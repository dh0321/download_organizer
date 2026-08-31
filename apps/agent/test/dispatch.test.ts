import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dispatch } from "../src/dispatch.js";
import { AgentConfigStore, defaultAgentConfig } from "../src/agentConfig.js";
import { JobWorkerPool } from "../src/jobQueue.js";
import { STAGING_DIR_NAME } from "../src/routeFile.js";

describe("dispatch", () => {
  let root: string;
  let stagingDir: string;
  let configDir: string;
  let configStore: AgentConfigStore;
  let jobQueue: JobWorkerPool;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aias-root-"));
    stagingDir = path.join(await mkdtemp(path.join(tmpdir(), "aias-downloads-")), STAGING_DIR_NAME);
    await mkdir(stagingDir, { recursive: true });
    configDir = await mkdtemp(path.join(tmpdir(), "aias-config-"));

    configStore = new AgentConfigStore(path.join(configDir, "agent-config.json"), {
      ...defaultAgentConfig("prod-extension-id"),
      defaultRoot: root,
    });
    jobQueue = new JobWorkerPool(2);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  it("answers ping with pong", async () => {
    const res = await dispatch({ configStore, jobQueue }, { type: "ping" });
    expect(res).toEqual({ type: "pong" });
  });

  it("returns settings without leaking allowedExtensionId", async () => {
    const res = await dispatch({ configStore, jobQueue }, { type: "get-settings" });
    expect(res.type).toBe("get-settings-result");
    if (res.type === "get-settings-result") {
      expect(res.settings).not.toHaveProperty("allowedExtensionId");
      expect(res.settings.defaultRoot).toBe(root);
    }
  });

  it("applies sync-settings and persists it as the new authoritative config", async () => {
    const res = await dispatch(
      { configStore, jobQueue },
      {
        type: "sync-settings",
        settings: {
          defaultRoot: root,
          folderTemplate: defaultAgentConfig("x").folderTemplate,
          assetBuckets: defaultAgentConfig("x").assetBuckets,
          conflictPolicy: "uniquify",
          maxConcurrentFileOps: 4,
        },
      },
    );
    expect(res).toEqual({ type: "sync-settings-result", ok: true });
    expect(configStore.get().maxConcurrentFileOps).toBe(4);
    // allowedExtensionId must never be changed by a sync-settings request
    expect(configStore.get().allowedExtensionId).toBe("prod-extension-id");
  });

  it("routes a route-file request end to end through the real handler", async () => {
    const src = path.join(stagingDir, "a.png");
    await writeFile(src, "bytes");

    const res = await dispatch(
      { configStore, jobQueue },
      {
        type: "route-file",
        jobId: "job-1",
        sourcePath: src,
        extension: ".png",
        mediaType: "image",
        reservedIndex: 1,
        naming: {
          project: "P",
          sequence: "",
          shot: "SH010",
          bucketId: "generated",
          description: "",
          namingPresetId: "default",
          namingTemplate: "{shot}_{type}_{description}_{index}",
          customFilenameEnabled: false,
          customFilename: "",
        },
      },
    );

    expect(res.type).toBe("route-file-result");
    if (res.type === "route-file-result" && res.ok) {
      expect(res.finalPath.endsWith(path.join("P", "SH010", "Generated", "SH010_IMG_001.png"))).toBe(true);
    } else {
      throw new Error("expected success");
    }
  });

  it("reports get-max-index as 0 for a never-used destination", async () => {
    const res = await dispatch(
      { configStore, jobQueue },
      { type: "get-max-index", naming: { project: "P", sequence: "", shot: "SH010", bucketId: "generated" } },
    );
    expect(res).toEqual({ type: "get-max-index-result", maxIndex: 0 });
  });
});
