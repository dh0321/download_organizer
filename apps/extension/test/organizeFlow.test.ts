import { describe, it, expect, vi } from "vitest";
import { runOrganizeFlow } from "../src/background/organizeFlow.js";
import { JobManager } from "../src/background/jobManager.js";
import type { NamingFields, NativeRequest, NativeResponse, PendingAsset } from "@ai-asset-saver/shared";

function naming(overrides: Partial<NamingFields> = {}): NamingFields {
  return {
    project: "Galaxy_S27",
    sequence: "SQ010",
    shot: "SH020",
    bucketId: "generated",
    description: "",
    namingPresetId: "default",
    namingTemplate: "{shot}_{type}_{description}_{index}",
    customFilenameEnabled: false,
    customFilename: "",
    customDirectoryEnabled: false,
    customDirectory: "",
    ...overrides,
  };
}

async function makeJobManager() {
  return JobManager.create({
    loadPendingAssets: vi.fn(async () => ({})),
    persistPendingAssets: vi.fn(),
    loadPersistedIndexCounters: vi.fn(async () => ({})),
    persistIndexCounters: vi.fn(),
    generateJobId: (() => {
      let n = 0;
      return () => `job-${n++}`;
    })(),
  });
}

function register(jm: JobManager, overrides: Partial<Parameters<JobManager["registerPendingAsset"]>[0]> = {}): PendingAsset {
  return jm.registerPendingAsset({
    browserDownloadId: 1,
    sourcePath: "/Users/me/Downloads/a.png",
    originalFilename: "a.png",
    extension: ".png",
    mediaType: "image",
    source: "chatgpt",
    downloadedAt: Date.now(),
    naming: naming(),
    ...overrides,
  });
}

describe("runOrganizeFlow", () => {
  it("organizes every selected asset and marks them 'organized' on success", async () => {
    const jm = await makeJobManager();
    const a1 = register(jm, { browserDownloadId: 1 });
    const a2 = register(jm, { browserDownloadId: 2, naming: naming({ shot: "SH030" }) });

    const sendToAgent = vi.fn(async (req: NativeRequest): Promise<NativeResponse> => {
      if (req.type === "get-max-index") return { type: "get-max-index-result", maxIndex: 0 };
      if (req.type === "organize-batch") {
        return {
          type: "organize-batch-result",
          results: req.items.map((item) => ({ jobId: item.jobId, ok: true, finalPath: `/dest/${item.jobId}.png` })),
        };
      }
      throw new Error("unexpected request");
    });

    const result = await runOrganizeFlow({ jobManager: jm, sendToAgent }, [a1.id, a2.id]);

    expect(result.ok).toBe(true);
    expect(jm.get(a1.id)?.status).toBe("organized");
    expect(jm.get(a2.id)?.status).toBe("organized");
    // two distinct destinations (different shot) -> two get-max-index calls + one organize-batch
    expect(sendToAgent.mock.calls.filter((c) => c[0].type === "get-max-index")).toHaveLength(2);
    expect(sendToAgent.mock.calls.filter((c) => c[0].type === "organize-batch")).toHaveLength(1);
  });

  it("assigns sequential reservedIndex values for assets sharing the same destination key", async () => {
    const jm = await makeJobManager();
    const a1 = register(jm, { browserDownloadId: 1 });
    const a2 = register(jm, { browserDownloadId: 2 }); // same project/sequence/shot/bucket -> same key

    let capturedItems: { jobId: string; reservedIndex: number }[] = [];
    const sendToAgent = vi.fn(async (req: NativeRequest): Promise<NativeResponse> => {
      if (req.type === "get-max-index") return { type: "get-max-index-result", maxIndex: 0 };
      if (req.type === "organize-batch") {
        capturedItems = req.items.map((i) => ({ jobId: i.jobId, reservedIndex: i.reservedIndex }));
        return { type: "organize-batch-result", results: req.items.map((i) => ({ jobId: i.jobId, ok: true, finalPath: "x" })) };
      }
      throw new Error("unexpected");
    });

    await runOrganizeFlow({ jobManager: jm, sendToAgent }, [a1.id, a2.id]);

    expect(capturedItems.find((i) => i.jobId === a1.id)?.reservedIndex).toBe(1);
    expect(capturedItems.find((i) => i.jobId === a2.id)?.reservedIndex).toBe(2);
  });

  it("reconciles against the Agent's real on-disk max index before reserving", async () => {
    const jm = await makeJobManager();
    const a1 = register(jm, { browserDownloadId: 1 });

    let reservedIndex = -1;
    const sendToAgent = vi.fn(async (req: NativeRequest): Promise<NativeResponse> => {
      if (req.type === "get-max-index") return { type: "get-max-index-result", maxIndex: 22 };
      if (req.type === "organize-batch") {
        reservedIndex = req.items[0].reservedIndex;
        return { type: "organize-batch-result", results: [{ jobId: req.items[0].jobId, ok: true, finalPath: "x" }] };
      }
      throw new Error("unexpected");
    });

    await runOrganizeFlow({ jobManager: jm, sendToAgent }, [a1.id]);

    expect(reservedIndex).toBe(23);
  });

  it("keeps other assets 'organized' when one item fails (§F-1 Failure Isolation)", async () => {
    const jm = await makeJobManager();
    const good = register(jm, { browserDownloadId: 1 });
    const bad = register(jm, { browserDownloadId: 2, naming: naming({ shot: "SH999" }) });

    const sendToAgent = vi.fn(async (req: NativeRequest): Promise<NativeResponse> => {
      if (req.type === "get-max-index") return { type: "get-max-index-result", maxIndex: 0 };
      if (req.type === "organize-batch") {
        return {
          type: "organize-batch-result",
          results: req.items.map((item) =>
            item.jobId === bad.id
              ? { jobId: item.jobId, ok: false, error: "gone", code: "SOURCE_NOT_FOUND" }
              : { jobId: item.jobId, ok: true, finalPath: "x" },
          ),
        };
      }
      throw new Error("unexpected");
    });

    const result = await runOrganizeFlow({ jobManager: jm, sendToAgent }, [good.id, bad.id]);

    expect(result.ok).toBe(true);
    expect(jm.get(good.id)?.status).toBe("organized");
    expect(jm.get(bad.id)?.status).toBe("failed");
    expect(jm.get(bad.id)?.errorMessage).toContain("SOURCE_NOT_FOUND");
  });

  it("blocks the whole action up front when the Agent is unreachable, touching no asset status (§12)", async () => {
    const jm = await makeJobManager();
    const a1 = register(jm, { browserDownloadId: 1 });
    const sendToAgent = vi.fn(async (): Promise<NativeResponse> => {
      throw new Error("Native Messaging host disconnected");
    });

    const result = await runOrganizeFlow({ jobManager: jm, sendToAgent }, [a1.id]);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Agent unreachable");
    expect(jm.get(a1.id)?.status).toBe("pending"); // never touched
  });

  it("marks assets 'failed' (never stuck 'organizing') if the Agent drops mid-batch", async () => {
    const jm = await makeJobManager();
    const a1 = register(jm, { browserDownloadId: 1 });
    const sendToAgent = vi.fn(async (req: NativeRequest): Promise<NativeResponse> => {
      if (req.type === "get-max-index") return { type: "get-max-index-result", maxIndex: 0 };
      throw new Error("disconnected mid-flight");
    });

    const result = await runOrganizeFlow({ jobManager: jm, sendToAgent }, [a1.id]);

    expect(result.ok).toBe(false);
    expect(jm.get(a1.id)?.status).toBe("failed");
    expect(jm.get(a1.id)?.errorMessage).toContain("Agent unreachable");
  });

  it("skips assets that are already organizing/organized and no-ops on an empty selection", async () => {
    const jm = await makeJobManager();
    const already = register(jm, { browserDownloadId: 1 });
    jm.setStatus(already.id, "organized");
    const sendToAgent = vi.fn();

    const result = await runOrganizeFlow({ jobManager: jm, sendToAgent }, [already.id]);

    expect(result).toEqual({ ok: true, results: [] });
    expect(sendToAgent).not.toHaveBeenCalled();
  });
});
