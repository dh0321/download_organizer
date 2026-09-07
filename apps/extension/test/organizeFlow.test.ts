import { describe, it, expect, vi } from "vitest";
import { runOrganizeFlow } from "../src/background/organizeFlow.js";
import { JobManager } from "../src/background/jobManager.js";
import { buildFilename, type NamingFields, type NativeRequest, type NativeResponse, type PendingAsset } from "@download-organizer/shared";

function naming(overrides: Partial<NamingFields> = {}): NamingFields {
  return {
    project: "Galaxy_S27",
    sequence: "SQ010",
    shot: "SH020",
    bucketId: "generated",
    description: "",
    namingPresetId: "default",
    namingTemplate: "{shot}_{description}_{index}",
    customFilenameEnabled: false,
    customFilename: "",
    customDirectoryEnabled: false,
    customDirectory: "",
    ...overrides,
  };
}

/** Mirrors organizeFlow.ts's own reserveIndexForAsset call shape, so tests can
 * compute exactly which filename a given {index} value would produce without
 * duplicating buildFilename's own logic. */
function nameForIndex(n: NamingFields, extension: string, index: number): string {
  return buildFilename(
    n.namingTemplate,
    {
      project: n.project,
      sequence: n.sequence,
      shot: n.shot,
      description: n.description,
      type: "",
      index,
      source: "chatgpt",
      customFilenameEnabled: false,
      customFilename: "",
    },
    extension,
  );
}

async function makeJobManager() {
  return JobManager.create({
    loadPendingAssets: vi.fn(async () => ({})),
    persistPendingAssets: vi.fn(),
    loadOrganizeLog: vi.fn(async () => []),
    persistOrganizeLog: vi.fn(),
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
    // Shot/Asset Name is a filename identifier, not a folder level (see
    // DEFAULT_FOLDER_TEMPLATE) — differ by sequence instead to get a genuinely
    // distinct destination folder/index key.
    const a2 = register(jm, { browserDownloadId: 2, naming: naming({ sequence: "SQ020" }) });

    const sendToAgent = vi.fn(async (req: NativeRequest): Promise<NativeResponse> => {
      if (req.type === "list-destination-files") return { type: "list-destination-files-result", files: [] };
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
    // finalPath from the Agent's organize-batch result must be captured on the
    // asset, not discarded — it's what the organize log (see jobManager.ts's
    // pruneOrganizedIntoLog) later records as "where did this file go".
    expect(jm.get(a1.id)?.finalPath).toBe(`/dest/${a1.id}.png`);
    expect(jm.get(a2.id)?.finalPath).toBe(`/dest/${a2.id}.png`);
    // two distinct destinations (different sequence) -> two list-destination-files calls + one organize-batch
    expect(sendToAgent.mock.calls.filter((c) => c[0].type === "list-destination-files")).toHaveLength(2);
    expect(sendToAgent.mock.calls.filter((c) => c[0].type === "organize-batch")).toHaveLength(1);
  });

  it("assigns sequential reservedIndex values for assets sharing the same destination and computed base name", async () => {
    const jm = await makeJobManager();
    const a1 = register(jm, { browserDownloadId: 1 });
    const a2 = register(jm, { browserDownloadId: 2 }); // same project/sequence/bucket/shot -> same computed name

    let capturedItems: { jobId: string; reservedIndex: number }[] = [];
    const sendToAgent = vi.fn(async (req: NativeRequest): Promise<NativeResponse> => {
      if (req.type === "list-destination-files") return { type: "list-destination-files-result", files: [] };
      if (req.type === "organize-batch") {
        capturedItems = req.items.map((i) => ({ jobId: i.jobId, reservedIndex: i.reservedIndex }));
        return { type: "organize-batch-result", results: req.items.map((i) => ({ jobId: i.jobId, ok: true, finalPath: "x" })) };
      }
      throw new Error("unexpected");
    });

    await runOrganizeFlow({ jobManager: jm, sendToAgent }, [a1.id, a2.id]);

    // Both assets compute the exact same filename at index 1, so the second
    // one must be bumped to 2 — not because of any shared per-folder counter
    // (there is none any more), but because the first claimed "index 1"'s
    // filename within this batch.
    expect(capturedItems.find((i) => i.jobId === a1.id)?.reservedIndex).toBe(1);
    expect(capturedItems.find((i) => i.jobId === a2.id)?.reservedIndex).toBe(2);
  });

  it("reserves index 1 for a brand-new (empty) destination folder, even if a stale prior session existed", async () => {
    const jm = await makeJobManager();
    const a1 = register(jm, { browserDownloadId: 1 });

    let reservedIndex = -1;
    const sendToAgent = vi.fn(async (req: NativeRequest): Promise<NativeResponse> => {
      // Confirmed live bug this replaces: an empty destination folder used to
      // still produce "v002" because of a counter that persisted across
      // sessions and never rewound after a manual delete. There's no such
      // memory now — an empty real folder listing must always mean index 1.
      if (req.type === "list-destination-files") return { type: "list-destination-files-result", files: [] };
      if (req.type === "organize-batch") {
        reservedIndex = req.items[0].reservedIndex;
        return { type: "organize-batch-result", results: [{ jobId: req.items[0].jobId, ok: true, finalPath: "x" }] };
      }
      throw new Error("unexpected");
    });

    await runOrganizeFlow({ jobManager: jm, sendToAgent }, [a1.id]);

    expect(reservedIndex).toBe(1);
  });

  it("only bumps the index past a value whose exact computed filename already exists in the destination", async () => {
    const jm = await makeJobManager();
    const a1 = register(jm, { browserDownloadId: 1 });
    const n = naming();
    // Some unrelated file already at index 1 in the real folder — a
    // completely different asset's index 5 existing must not affect this
    // one, since it's a different computed name.
    const existing = [nameForIndex(n, ".png", 1), "some_other_unrelated_file_v005.png"];

    let reservedIndex = -1;
    const sendToAgent = vi.fn(async (req: NativeRequest): Promise<NativeResponse> => {
      if (req.type === "list-destination-files") return { type: "list-destination-files-result", files: existing };
      if (req.type === "organize-batch") {
        reservedIndex = req.items[0].reservedIndex;
        return { type: "organize-batch-result", results: [{ jobId: req.items[0].jobId, ok: true, finalPath: "x" }] };
      }
      throw new Error("unexpected");
    });

    await runOrganizeFlow({ jobManager: jm, sendToAgent }, [a1.id]);

    expect(reservedIndex).toBe(2);
  });

  it("keeps other assets 'organized' when one item fails (§F-1 Failure Isolation)", async () => {
    const jm = await makeJobManager();
    const good = register(jm, { browserDownloadId: 1 });
    const bad = register(jm, { browserDownloadId: 2, naming: naming({ shot: "SH999" }) });

    const sendToAgent = vi.fn(async (req: NativeRequest): Promise<NativeResponse> => {
      if (req.type === "list-destination-files") return { type: "list-destination-files-result", files: [] };
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
      if (req.type === "list-destination-files") return { type: "list-destination-files-result", files: [] };
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

  it("scales the organize-batch native-messaging timeout with the number of items — large video batches need real headroom, not the generic fast-round-trip default", async () => {
    const jm = await makeJobManager();
    const a1 = register(jm, { browserDownloadId: 1 });
    const a2 = register(jm, { browserDownloadId: 2, naming: naming({ sequence: "SQ020" }) });

    let capturedTimeoutMs: number | undefined;
    const sendToAgent = vi.fn(async (req: NativeRequest, timeoutMs?: number): Promise<NativeResponse> => {
      if (req.type === "list-destination-files") return { type: "list-destination-files-result", files: [] };
      if (req.type === "organize-batch") {
        capturedTimeoutMs = timeoutMs;
        return { type: "organize-batch-result", results: req.items.map((i) => ({ jobId: i.jobId, ok: true, finalPath: "x" })) };
      }
      throw new Error("unexpected");
    });

    await runOrganizeFlow({ jobManager: jm, sendToAgent }, [a1.id, a2.id]);

    // 2 items -> base (60s) + 2 * per-item (60s) = 180s, well beyond the
    // generic default (nativeClient's DEFAULT_TIMEOUT_MS is 15s).
    expect(capturedTimeoutMs).toBe(180_000);
    // list-destination-files round trips are fast metadata lookups — left on
    // the default timeout (no explicit second argument).
    const listCalls = sendToAgent.mock.calls.filter((c) => c[0].type === "list-destination-files");
    expect(listCalls.every((c) => c[1] === undefined)).toBe(true);
  });
});
