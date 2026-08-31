// Background service worker entrypoint — wires session state, source detection,
// job management, native messaging, and notifications together. See PLAN.md §C/§D.

import type { NamingFields } from "@ai-asset-saver/shared";
import { loadSessionState, saveSessionState, DEFAULT_SESSION_STATE } from "./sessionManager.js";
import { JobManager } from "./jobManager.js";
import { IntentPingStore } from "./intentPingStore.js";
import { NativeClient } from "./nativeClient.js";
import { registerDownloadListeners } from "./downloadListener.js";
import { notifyJobsUpdated, notifyError } from "./notifier.js";
import { SESSION_STORAGE_KEY, INDEX_COUNTERS_STORAGE_KEY } from "./storageKeys.js";

let cachedRootForDisplay = "";

const intentPingStore = new IntentPingStore();
const nativeClient = new NativeClient();

async function loadPersistedIndexCounters(): Promise<Record<string, number>> {
  const result = await chrome.storage.local.get(INDEX_COUNTERS_STORAGE_KEY);
  return (result[INDEX_COUNTERS_STORAGE_KEY] as Record<string, number> | undefined) ?? {};
}

function persistIndexCounters(snapshot: Record<string, number>): void {
  // Fire-and-forget on purpose — never awaited from inside detectJob (§F-1).
  void chrome.storage.local.set({ [INDEX_COUNTERS_STORAGE_KEY]: snapshot });
}

async function main(): Promise<void> {
  const jobManager = await JobManager.create({
    loadPersistedIndexCounters,
    persistIndexCounters,
    generateJobId: () => crypto.randomUUID(),
  });

  // Best-effort: refresh the display-only Settings cache from the Agent (§F-2 —
  // this value is never used for actual routing, only for the popup's preview).
  nativeClient
    .send({ type: "get-settings" })
    .then((res) => {
      if (res.type === "get-settings-result") cachedRootForDisplay = res.settings.defaultRoot;
    })
    .catch(() => {
      // Agent not running yet — popup's <AgentStatusBadge> surfaces this; no toast needed on startup.
    });

  registerDownloadListeners({
    jobManager,
    intentPingStore,
    getSession: () => sessionSnapshotCache,
    getCachedRootForDisplay: () => cachedRootForDisplay,
    onJobDetected: () => {
      // Nothing extra to do here yet — completion is handled in onDownloadComplete.
    },
    onDownloadComplete: (jobId) => handleDownloadComplete(jobManager, jobId),
    onDownloadCancelled: () => notifyJobsUpdated(jobManager),
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "aias-intent-ping") {
      intentPingStore.record(message.origin, message.timestamp);
      return; // no response expected
    }

    if (message?.type === "aias-get-display-settings") {
      // Popup preview only — never the source of truth for routing (§F-2).
      nativeClient
        .send({ type: "get-settings" })
        .then((res) => {
          if (res.type === "get-settings-result") {
            cachedRootForDisplay = res.settings.defaultRoot;
            sendResponse({ ok: true, settings: res.settings });
          } else {
            sendResponse({ ok: false, error: "unexpected response" });
          }
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // keep the message channel open for the async sendResponse
    }

    if (message?.type === "aias-set-default-root") {
      nativeClient
        .send({ type: "get-settings" })
        .then((current) => {
          if (current.type !== "get-settings-result") throw new Error("unexpected response");
          return nativeClient.send({
            type: "sync-settings",
            settings: { ...current.settings, defaultRoot: message.root },
          });
        })
        .then(() => {
          cachedRootForDisplay = message.root;
          sendResponse({ ok: true });
        })
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;
    }

    if (message?.type === "aias-ping-agent") {
      nativeClient
        .send({ type: "ping" }, 3000)
        .then(() => sendResponse({ connected: true }))
        .catch(() => sendResponse({ connected: false }));
      return true;
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes[SESSION_STORAGE_KEY]) {
      sessionSnapshotCache = { ...DEFAULT_SESSION_STATE, ...changes[SESSION_STORAGE_KEY].newValue };
    }
  });
}

// A synchronous, in-memory mirror of SessionState kept up to date via the storage
// listener above — onDeterminingFilename must read this synchronously (no await),
// per §F-1's race-freedom requirement.
let sessionSnapshotCache = DEFAULT_SESSION_STATE;
loadSessionState().then((s) => {
  sessionSnapshotCache = s;
});

async function handleDownloadComplete(jobManager: JobManager, jobId: string): Promise<void> {
  const job = jobManager.get(jobId);
  if (!job) return;

  const [item] = await chrome.downloads.search({ id: job.browserDownloadId });
  if (!item) {
    jobManager.setStatus(jobId, "failed", "Download item disappeared before it could be routed");
    notifyJobsUpdated(jobManager);
    return;
  }

  jobManager.setStatus(jobId, "moving");
  notifyJobsUpdated(jobManager);

  const naming: NamingFields = {
    project: job.sessionSnapshot.project,
    sequence: job.sessionSnapshot.sequence,
    shot: job.sessionSnapshot.shot,
    bucketId: job.sessionSnapshot.bucketId,
    description: job.sessionSnapshot.description,
    namingPresetId: job.sessionSnapshot.namingPresetId,
    namingTemplate: "{shot}_{type}_{description}_{index}", // Phase 1: single built-in preset (§O)
    customFilenameEnabled: job.sessionSnapshot.customFilenameEnabled,
    customFilename: job.sessionSnapshot.customFilename,
  };

  try {
    const response = await nativeClient.send({
      type: "route-file",
      jobId,
      sourcePath: item.filename, // absolute path, resolved by Chrome within the Downloads dir (§C)
      extension: job.extension,
      mediaType: job.mediaType,
      reservedIndex: job.reservedIndex,
      naming,
    });

    if (response.type !== "route-file-result") return; // protocol mismatch — should never happen

    if (response.ok) {
      const finalFilename = response.finalPath.split(/[\\/]/).pop() ?? job.originalFilename;
      jobManager.setResult(jobId, response.finalPath, finalFilename);
      // Clean up the staged Downloads-dir entry now that the real file exists (§O Phase 0 open question).
      void chrome.downloads.erase({ id: job.browserDownloadId });
    } else {
      jobManager.setStatus(jobId, "failed", `${response.code}: ${response.error}`);
    }
  } catch (err) {
    jobManager.setStatus(jobId, "failed", `Agent unreachable: ${(err as Error).message}`);
    notifyError("Local Agent not running", "Couldn't save this file — open the Agent and retry from Recent Activity.");
  }

  notifyJobsUpdated(jobManager);
}

main().catch((err) => {
  console.error("AI Asset Saver background init failed:", err);
});
