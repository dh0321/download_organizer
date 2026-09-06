#!/usr/bin/env node
// Native Messaging host entrypoint. Chrome launches this process per-connection
// and passes the calling extension's origin as a command-line argument (one of
// `process.argv`, shaped like "chrome-extension://<id>/"). Chrome's own
// `allowed_origins` check in the native-messaging-host manifest is the primary
// gate; this process performs an independent second check against its own
// AgentConfig.allowedExtensionId before processing anything (§F-2 Chrome Security
// — "검증이 Extension Service Worker와 Local Agent 양쪽에서 독립적으로 이루어집니다").
//
// Everything here also logs to a file (see logger.ts) because Chrome runs this
// as a child process with no visible console window — stderr alone is not a
// practical way to debug a real Windows installation.

import path from "node:path";
import os from "node:os";
import { AgentConfigStore } from "./agentConfig.js";
import { JobWorkerPool } from "./jobQueue.js";
import { dispatch } from "./dispatch.js";
import { readMessages, writeMessage } from "./stdio.js";
import { FileLogger } from "./logger.js";
import type { NativeRequest } from "@download-organizer/shared";

function resolveAppDataDir(): string {
  // %APPDATA%\DownloadOrganizer on Windows (the real deployment target); falls back
  // to a dotfile under the user's home directory so this same code path can be
  // exercised in local dev on macOS/Linux (see PLAN.md appendix).
  const appData = process.env.APPDATA ?? path.join(os.homedir(), ".config");
  return path.join(appData, "DownloadOrganizer");
}

function extractCallerExtensionOrigin(argv: string[]): string | undefined {
  return argv.find((a) => a.startsWith("chrome-extension://"));
}

async function main(): Promise<void> {
  const appDataDir = resolveAppDataDir();
  const configPath = path.join(appDataDir, "config.json");
  const logger = new FileLogger(path.join(appDataDir, "agent.log"));

  await logger.log(`Agent starting. pid=${process.pid} argv=${JSON.stringify(process.argv)}`);

  // The production Extension ID is baked in at install time by the installer
  // (§E config/installer) — this fallback value only matters for local dev runs
  // invoked directly (not through Chrome), where there is no real caller to check.
  const bootstrapExtensionId = process.env.AIAS_ALLOWED_EXTENSION_ID ?? "unconfigured";
  const configStore = await AgentConfigStore.load(configPath, bootstrapExtensionId);

  const callerOrigin = extractCallerExtensionOrigin(process.argv);
  const expectedOrigin = `chrome-extension://${configStore.get().allowedExtensionId}/`;
  if (callerOrigin && callerOrigin !== expectedOrigin) {
    await logger.log(
      `REJECTED connection from unexpected origin "${callerOrigin}" (expected "${expectedOrigin}"). ` +
        `If this is unexpected, re-run install.ps1 with the correct -ExtensionId.`,
    );
    process.exit(1);
  }
  if (configStore.get().allowedExtensionId === "unconfigured") {
    await logger.log(
      "WARNING: allowedExtensionId is still 'unconfigured' — install.ps1 was probably run without " +
        "-DefaultRoot (which is what seeds config.json). Every real connection will be rejected until this is fixed.",
    );
  }

  const jobQueue = new JobWorkerPool(configStore.get().maxConcurrentFileOps);
  await logger.log(
    `Ready. defaultRoot=${configStore.get().defaultRoot || "(not set)"} maxConcurrentFileOps=${configStore.get().maxConcurrentFileOps}`,
  );

  readMessages(process.stdin, (raw) => {
    const req = raw as NativeRequest;
    void logger.log(`request: ${req?.type}${"jobId" in req ? ` jobId=${req.jobId}` : ""}`);
    // No further trust is extended to `raw` here beyond "valid JSON" — every field
    // is re-validated by the handler it reaches (sanitizeSegment, Root containment,
    // etc.), per §F-2's "never trust a value from the Extension" principle.
    void dispatch(
      {
        configStore,
        jobQueue,
        onOrganizeProgress: (completed, total) => {
          writeMessage(process.stdout, { type: "organize-progress", completed, total });
        },
      },
      req,
    ).then(
      (response) => {
        writeMessage(process.stdout, response);
        void logger.log(`response: ${response.type}${"ok" in response ? ` ok=${response.ok}` : ""}`);
      },
      (err) => {
        void logger.log(`UNHANDLED dispatch error: ${String(err)}`);
      },
    );
  });

  process.stdin.on("end", () => {
    void logger.log("stdin closed — Chrome disconnected, exiting.");
  });
}

main().catch(async (err) => {
  const logger = new FileLogger(path.join(resolveAppDataDir(), "agent.log"));
  await logger.log(`FATAL startup error: ${String(err)}`);
  process.exit(1);
});
