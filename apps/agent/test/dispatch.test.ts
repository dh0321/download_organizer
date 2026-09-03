import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { dispatch } from "../src/dispatch.js";
import { AgentConfigStore, defaultAgentConfig } from "../src/agentConfig.js";
import { JobWorkerPool } from "../src/jobQueue.js";

// dispatch's "pick-directory" case calls the real OS (osascript/powershell) via
// directoryPicker.ts — mock it here so tests never spawn a real dialog.
vi.mock("../src/directoryPicker.js", () => ({
  pickDirectory: vi.fn(),
}));
import { pickDirectory } from "../src/directoryPicker.js";

describe("dispatch", () => {
  let root: string;
  let downloadsDir: string;
  let configDir: string;
  let configStore: AgentConfigStore;
  let jobQueue: JobWorkerPool;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aias-root-"));
    downloadsDir = await mkdtemp(path.join(tmpdir(), "aias-downloads-"));
    configDir = await mkdtemp(path.join(tmpdir(), "aias-config-"));

    configStore = new AgentConfigStore(path.join(configDir, "agent-config.json"), {
      ...defaultAgentConfig("prod-extension-id"),
      defaultRoot: root,
    });
    jobQueue = new JobWorkerPool(2);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(downloadsDir, { recursive: true, force: true });
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
    const src = path.join(downloadsDir, "a.png");
    await writeFile(src, "bytes");

    const res = await dispatch(
      { configStore, jobQueue, downloadsRoot: downloadsDir },
      {
        type: "route-file",
        jobId: "job-1",
        sourcePath: src,
        extension: ".png",
        mediaType: "image",
        source: "chatgpt",
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
      expect(res.finalPath.endsWith(path.join("P", "Generated", "SH010_IMG_v001.png"))).toBe(true);
    } else {
      throw new Error("expected success");
    }
  });

  it("organize-batch processes every item independently — one failure never blocks the others (§F-1 Failure Isolation)", async () => {
    const goodSrc = path.join(downloadsDir, "good.png");
    await writeFile(goodSrc, "bytes");
    const missingSrc = path.join(downloadsDir, "already-gone.png"); // never created -> SOURCE_NOT_FOUND
    const otherGoodSrc = path.join(downloadsDir, "other-good.mov");
    await writeFile(otherGoodSrc, "video bytes");

    const naming = {
      project: "P",
      sequence: "",
      shot: "SH010",
      bucketId: "generated",
      description: "",
      namingPresetId: "default",
      namingTemplate: "{shot}_{type}_{description}_{index}",
      customFilenameEnabled: false,
      customFilename: "",
    };

    const res = await dispatch(
      { configStore, jobQueue, downloadsRoot: downloadsDir },
      {
        type: "organize-batch",
        items: [
          { jobId: "job-good", sourcePath: goodSrc, extension: ".png", mediaType: "image", source: "chatgpt", reservedIndex: 1, naming },
          { jobId: "job-missing", sourcePath: missingSrc, extension: ".png", mediaType: "image", source: "chatgpt", reservedIndex: 2, naming },
          { jobId: "job-other-good", sourcePath: otherGoodSrc, extension: ".mov", mediaType: "video", source: "gemini", reservedIndex: 3, naming },
        ],
      },
    );

    expect(res.type).toBe("organize-batch-result");
    if (res.type !== "organize-batch-result") throw new Error("expected organize-batch-result");
    const byJobId = Object.fromEntries(res.results.map((r) => [r.jobId, r]));
    expect(byJobId["job-good"]).toMatchObject({ ok: true });
    expect(byJobId["job-missing"]).toMatchObject({ ok: false, code: "SOURCE_NOT_FOUND" });
    expect(byJobId["job-other-good"]).toMatchObject({ ok: true });
  });

  it("reports get-max-index as 0 for a never-used destination", async () => {
    const res = await dispatch(
      { configStore, jobQueue },
      { type: "get-max-index", naming: { project: "P", sequence: "", shot: "SH010", bucketId: "generated" } },
    );
    expect(res).toEqual({ type: "get-max-index-result", maxIndex: 0 });
  });

  it("returns the picked path on pick-directory", async () => {
    vi.mocked(pickDirectory).mockResolvedValueOnce("/Users/dahye/AI_Projects");
    const res = await dispatch({ configStore, jobQueue }, { type: "pick-directory" });
    expect(res).toEqual({ type: "pick-directory-result", ok: true, path: "/Users/dahye/AI_Projects" });
  });

  it("returns ok:true with a null path when the user cancels the dialog", async () => {
    vi.mocked(pickDirectory).mockResolvedValueOnce(null);
    const res = await dispatch({ configStore, jobQueue }, { type: "pick-directory" });
    expect(res).toEqual({ type: "pick-directory-result", ok: true, path: null });
  });

  it("returns ok:false when the native picker throws (e.g. unsupported platform)", async () => {
    vi.mocked(pickDirectory).mockRejectedValueOnce(new Error("Native directory picker is not supported on this platform: linux"));
    const res = await dispatch({ configStore, jobQueue }, { type: "pick-directory" });
    expect(res).toMatchObject({ type: "pick-directory-result", ok: false });
  });

  it("lists real files sitting in the Downloads folder on list-downloads-folder", async () => {
    await writeFile(path.join(downloadsDir, "photo.png"), "bytes");
    const res = await dispatch({ configStore, jobQueue, downloadsRoot: downloadsDir }, { type: "list-downloads-folder" });

    expect(res.type).toBe("list-downloads-folder-result");
    if (res.type === "list-downloads-folder-result" && res.ok) {
      expect(res.files.map((f) => f.filename)).toEqual(["photo.png"]);
      expect(res.files[0].path).toBe(path.join(downloadsDir, "photo.png"));
    } else {
      throw new Error("expected ok:true");
    }
  });

  it("returns ok:false when the Downloads folder can't be read", async () => {
    const res = await dispatch(
      { configStore, jobQueue, downloadsRoot: path.join(downloadsDir, "does-not-exist") },
      { type: "list-downloads-folder" },
    );
    expect(res).toMatchObject({ type: "list-downloads-folder-result", ok: false });
  });
});
