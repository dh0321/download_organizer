import { describe, it, expect, vi } from "vitest";
import { scanDownloadsFolder, importRescanCandidates, type RescanCandidate } from "../src/background/rescanDownloads.js";
import { JobManager } from "../src/background/jobManager.js";
import type { DownloadsFolderEntry, NamingFields, NativeResponse, PendingAsset } from "@download-organizer/shared";

function naming(): NamingFields {
  return {
    project: "",
    sequence: "",
    shot: "",
    bucketId: "",
    description: "",
    namingPresetId: "default",
    namingTemplate: "{shot}_{type}_{description}_{index}",
    customFilenameEnabled: false,
    customFilename: "",
    customDirectoryEnabled: false,
    customDirectory: "",
  };
}

async function makeJobManager() {
  const persistedAssets: Record<string, PendingAsset>[] = [];
  return JobManager.create({
    loadPendingAssets: vi.fn(async () => ({})),
    persistPendingAssets: vi.fn((assets: Record<string, PendingAsset>) => {
      persistedAssets.push(assets);
    }),
    loadPersistedIndexCounters: vi.fn(async () => ({})),
    persistIndexCounters: vi.fn(() => {}),
    loadOrganizeLog: vi.fn(async () => []),
    persistOrganizeLog: vi.fn(() => {}),
    generateJobId: (() => {
      let n = 0;
      return () => `job-${n++}`;
    })(),
  });
}

function entry(overrides: Partial<DownloadsFolderEntry> = {}): DownloadsFolderEntry {
  return {
    path: "/Users/me/Downloads/image.png",
    filename: "image.png",
    extension: ".png",
    modifiedAt: Date.now(),
    ...overrides,
  };
}

function okResponse(files: DownloadsFolderEntry[]): NativeResponse {
  return { type: "list-downloads-folder-result", ok: true, files };
}

describe("scanDownloadsFolder", () => {
  it("never registers anything on the JobManager — it only reports candidates", async () => {
    const jm = await makeJobManager();
    const sendToAgent = vi.fn(async () => okResponse([entry({ path: "/D/a.png", filename: "a.png" })]));
    const result = await scanDownloadsFolder(jm, sendToAgent);

    expect("candidates" in result && result.candidates).toHaveLength(1);
    expect(jm.allPendingAssets()).toHaveLength(0);
  });

  it("excludes a file whose path is already tracked", async () => {
    const jm = await makeJobManager();
    jm.registerPendingAsset({
      sourcePath: "/D/a.png",
      originalFilename: "a.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      downloadedAt: Date.now(),
      naming: naming(),
    });

    const sendToAgent = vi.fn(async () => okResponse([entry({ path: "/D/a.png", filename: "a.png" })]));
    const result = await scanDownloadsFolder(jm, sendToAgent);

    expect("candidates" in result && result.candidates).toHaveLength(0);
  });

  it("excludes a file with an unsupported extension", async () => {
    const jm = await makeJobManager();
    const sendToAgent = vi.fn(async () => okResponse([entry({ path: "/D/notes.txt", filename: "notes.txt", extension: ".txt" })]));
    const result = await scanDownloadsFolder(jm, sendToAgent);

    expect("candidates" in result && result.candidates).toHaveLength(0);
  });

  it("guesses the source from a recognizable filename", async () => {
    const jm = await makeJobManager();
    const sendToAgent = vi.fn(async () =>
      okResponse([entry({ path: "/D/x.png", filename: "ChatGPT Image Aug 31, 2026.png" })]),
    );
    const result = await scanDownloadsFolder(jm, sendToAgent);

    expect("candidates" in result && result.candidates[0].source).toBe("chatgpt");
  });

  it("still includes a file with no recognizable filename hint, with a blank source (general download manager — no AI-match gate)", async () => {
    const jm = await makeJobManager();
    const sendToAgent = vi.fn(async () => okResponse([entry({ path: "/D/random_photo.jpg", filename: "random_photo.jpg", extension: ".jpg" })]));
    const result = await scanDownloadsFolder(jm, sendToAgent);

    expect("candidates" in result && result.candidates).toHaveLength(1);
    expect("candidates" in result && result.candidates[0].source).toBe("");
  });

  it("finds an old file just as well as a recent one (real folder scan, no chrome-history recency limits)", async () => {
    const jm = await makeJobManager();
    const sendToAgent = vi.fn(async () =>
      okResponse([entry({ path: "/D/ancient.png", filename: "ancient.png", modifiedAt: new Date("2020-01-01").getTime() })]),
    );
    const result = await scanDownloadsFolder(jm, sendToAgent);

    expect("candidates" in result && result.candidates).toHaveLength(1);
  });

  it("sends exactly a list-downloads-folder request", async () => {
    const jm = await makeJobManager();
    const sendToAgent = vi.fn(async () => okResponse([]));
    await scanDownloadsFolder(jm, sendToAgent);

    expect(sendToAgent).toHaveBeenCalledWith({ type: "list-downloads-folder" });
  });

  it("surfaces an error instead of candidates when the Agent can't read the folder", async () => {
    const jm = await makeJobManager();
    const sendToAgent = vi.fn(
      async (): Promise<NativeResponse> => ({ type: "list-downloads-folder-result", ok: false, error: "ENOENT" }),
    );
    const result = await scanDownloadsFolder(jm, sendToAgent);

    expect("error" in result && result.error).toBe("ENOENT");
  });

  it("surfaces an error for an unexpected response type (e.g. Local App not running)", async () => {
    const jm = await makeJobManager();
    const sendToAgent = vi.fn(async (): Promise<NativeResponse> => ({ type: "pong" }));
    const result = await scanDownloadsFolder(jm, sendToAgent);

    expect("error" in result).toBe(true);
  });
});

describe("importRescanCandidates", () => {
  function candidate(overrides: Partial<RescanCandidate> = {}): RescanCandidate {
    return {
      sourcePath: "/D/a.png",
      originalFilename: "a.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      downloadedAt: Date.now(),
      ...overrides,
    };
  }

  it("registers only the candidates it's given", async () => {
    const jm = await makeJobManager();
    const result = importRescanCandidates(
      jm,
      [candidate({ sourcePath: "/D/a.png" }), candidate({ sourcePath: "/D/b.png" })],
      naming,
    );

    expect(result.addedCount).toBe(2);
    expect(jm.allPendingAssets().map((a) => a.sourcePath).sort()).toEqual(["/D/a.png", "/D/b.png"]);
  });

  it("registers nothing when given an empty selection", async () => {
    const jm = await makeJobManager();
    const result = importRescanCandidates(jm, [], naming);

    expect(result.addedCount).toBe(0);
    expect(jm.allPendingAssets()).toHaveLength(0);
  });

  it("skips a candidate whose sourcePath is already tracked (stale/duplicate picker submission)", async () => {
    const jm = await makeJobManager();
    jm.registerPendingAsset({ ...candidate({ sourcePath: "/D/dup.png" }), naming: naming() });

    const result = importRescanCandidates(jm, [candidate({ sourcePath: "/D/dup.png" })], naming);

    expect(result.addedCount).toBe(0);
    expect(jm.allPendingAssets()).toHaveLength(1);
  });

  it("registers the asset without a browserDownloadId (folder-scanned files have no chrome.downloads id)", async () => {
    const jm = await makeJobManager();
    importRescanCandidates(jm, [candidate({ sourcePath: "/D/no-id.png" })], naming);

    expect(jm.allPendingAssets()[0].browserDownloadId).toBeUndefined();
  });

  it("carries the candidate's source through to the registered asset", async () => {
    const jm = await makeJobManager();
    importRescanCandidates(jm, [candidate({ sourcePath: "/D/blank.png", source: "" })], naming);

    expect(jm.allPendingAssets()[0].source).toBe("");
  });
});
