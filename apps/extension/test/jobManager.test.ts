import { describe, it, expect, vi } from "vitest";
import { JobManager } from "../src/background/jobManager.js";
import type { NamingFields, PendingAsset } from "@ai-asset-saver/shared";

function naming(overrides: Partial<NamingFields> = {}): NamingFields {
  return {
    project: "Galaxy_S27",
    sequence: "SQ010",
    shot: "SH020",
    bucketId: "generated",
    description: "woman red dress closeup",
    namingPresetId: "default",
    namingTemplate: "{shot}_{type}_{description}_{index}",
    customFilenameEnabled: false,
    customFilename: "",
    customDirectoryEnabled: false,
    customDirectory: "",
    ...overrides,
  };
}

function makeDeps() {
  let nextId = 0;
  const persistedAssets: Record<string, PendingAsset>[] = [];
  const persistedCounters: Record<string, number>[] = [];
  return {
    deps: {
      loadPendingAssets: vi.fn(async () => ({})),
      persistPendingAssets: vi.fn((assets: Record<string, PendingAsset>) => {
        persistedAssets.push(assets);
      }),
      loadPersistedIndexCounters: vi.fn(async () => ({})),
      persistIndexCounters: vi.fn((snapshot: Record<string, number>) => {
        persistedCounters.push(snapshot);
      }),
      generateJobId: vi.fn(() => `job-${nextId++}`),
    },
    persistedAssets,
    persistedCounters,
  };
}

function register(manager: JobManager, overrides: Partial<Parameters<JobManager["registerPendingAsset"]>[0]> = {}) {
  return manager.registerPendingAsset({
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

describe("JobManager (Pending Asset store)", () => {
  it("registers a completed download as a pending, selected-by-default asset with no index reserved yet", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);

    const asset = register(manager);

    expect(asset.status).toBe("pending");
    expect(asset.selected).toBe(true);
    expect(manager.get(asset.id)).toEqual(asset);
    expect(manager.getByBrowserDownloadId(1)?.id).toBe(asset.id);
  });

  it("persists to storage on every mutation so the Inbox survives a tab/service-worker restart", async () => {
    const { deps, persistedAssets } = makeDeps();
    const manager = await JobManager.create(deps);

    const asset = register(manager);
    expect(persistedAssets.at(-1)).toEqual({ [asset.id]: asset });

    manager.setSelected(asset.id, false);
    expect(persistedAssets.at(-1)?.[asset.id].selected).toBe(false);
  });

  it("restores previously-registered pending assets from a persisted snapshot after a restart", async () => {
    const { deps: firstRunDeps } = makeDeps();
    const manager1 = await JobManager.create(firstRunDeps);
    const asset = register(manager1);

    const lastPersisted = firstRunDeps.persistPendingAssets.mock.calls.at(-1)?.[0];
    const manager2 = await JobManager.create({
      loadPendingAssets: vi.fn(async () => lastPersisted ?? {}),
      persistPendingAssets: vi.fn(),
      loadPersistedIndexCounters: vi.fn(async () => ({})),
      persistIndexCounters: vi.fn(),
      generateJobId: vi.fn(() => "job-restart"),
    });

    expect(manager2.get(asset.id)).toEqual(asset);
  });

  it("does not auto-apply Batch Defaults changes — only 'apply to selected' overwrites listed assets", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const asset1 = register(manager, { browserDownloadId: 1 });
    const asset2 = register(manager, { browserDownloadId: 2 });
    manager.setSelected(asset2.id, false); // only asset1 stays selected

    manager.applyDefaultsToSelected({ project: "NewProject", sequence: "SQ099", bucketId: "final" });

    expect(manager.get(asset1.id)?.naming.project).toBe("NewProject");
    expect(manager.get(asset1.id)?.naming.bucketId).toBe("final");
    expect(manager.get(asset2.id)?.naming.project).toBe("Galaxy_S27"); // untouched, was deselected
  });

  it("lets per-asset naming edits (e.g. switching to Custom Folder) apply independently", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const asset = register(manager);

    manager.updateNaming(asset.id, { customDirectoryEnabled: true, customDirectory: "ClientA\\Round03" });

    expect(manager.get(asset.id)?.naming.customDirectoryEnabled).toBe(true);
    expect(manager.get(asset.id)?.naming.customDirectory).toBe("ClientA\\Round03");
    expect(manager.get(asset.id)?.naming.project).toBe("Galaxy_S27"); // unrelated fields untouched
  });

  it("lets the user correct the auto-detected source directly, persisting the change", async () => {
    const { deps, persistedAssets } = makeDeps();
    const manager = await JobManager.create(deps);
    const asset = register(manager, { source: "chatgpt" });

    manager.updateSource(asset.id, "gemini");

    expect(manager.get(asset.id)?.source).toBe("gemini");
    expect(persistedAssets.at(-1)?.[asset.id].source).toBe("gemini");
  });

  it("setSelectedByIds only touches the given ids, so a filtered 'Select all' never selects hidden assets", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const a = register(manager, { browserDownloadId: 1 });
    const b = register(manager, { browserDownloadId: 2 });
    const c = register(manager, { browserDownloadId: 3 });
    manager.setSelectedByIds([a.id, b.id], false);

    expect(manager.get(a.id)?.selected).toBe(false);
    expect(manager.get(b.id)?.selected).toBe(false);
    expect(manager.get(c.id)?.selected).toBe(true);
  });

  it("excludes organized/organizing assets from organizableAssets()", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const pendingAsset = register(manager, { browserDownloadId: 1 });
    const organizingAsset = register(manager, { browserDownloadId: 2 });
    const organizedAsset = register(manager, { browserDownloadId: 3 });
    manager.setStatus(organizingAsset.id, "organizing");
    manager.setStatus(organizedAsset.id, "organized");

    const organizable = manager.organizableAssets().map((a) => a.id);
    expect(organizable).toContain(pendingAsset.id);
    expect(organizable).not.toContain(organizingAsset.id);
    expect(organizable).not.toContain(organizedAsset.id);
  });

  it("assigns unique, sequential Organize-time indices for 5 assets Organized together (§F-1)", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const assets = [1, 2, 3, 4, 5].map((n) => register(manager, { browserDownloadId: n }));

    // Synchronous loop, no `await` in between — mirrors the real Organize handler.
    const indices = assets.map((a) => manager.reserveIndexForOrganize(a));

    expect(indices).toEqual([1, 2, 3, 4, 5]);
  });

  it("tracks independent Organize-time counters per project/sequence/shot/bucket/mediaType key", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const assetShotA = register(manager, { browserDownloadId: 1, naming: naming({ shot: "SH010" }) });
    const assetShotB = register(manager, { browserDownloadId: 2, naming: naming({ shot: "SH020" }) });

    expect(manager.reserveIndexForOrganize(assetShotA)).toBe(1);
    expect(manager.reserveIndexForOrganize(assetShotB)).toBe(1); // independent key, starts at 1 too
  });

  it("keys the Organize-time counter off the custom directory, not project/sequence/shot/bucket, when enabled", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const structuredAsset = register(manager, { browserDownloadId: 1 });
    const customDirAsset1 = register(manager, {
      browserDownloadId: 2,
      naming: naming({ customDirectoryEnabled: true, customDirectory: "ClientA\\ReviewBatch2" }),
    });
    const customDirAsset2 = register(manager, {
      browserDownloadId: 3,
      naming: naming({ customDirectoryEnabled: true, customDirectory: "ClientA\\ReviewBatch2" }),
    });

    expect(manager.reserveIndexForOrganize(structuredAsset)).toBe(1);
    expect(manager.reserveIndexForOrganize(customDirAsset1)).toBe(1);
    expect(manager.reserveIndexForOrganize(customDirAsset2)).toBe(2);
  });

  it("reconciles the Organize-time counter against the Agent's real on-disk max before reserving", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const asset = register(manager);

    manager.reconcileIndexFloor("galaxy_s27|sq010|sh020|generated|image", 22);

    expect(manager.reserveIndexForOrganize(asset)).toBe(23); // continues from the disk-reported max, not 1
  });

  it("restores Organize-time index counters from a persisted checkpoint after a simulated restart", async () => {
    const { deps: firstRunDeps } = makeDeps();
    const manager1 = await JobManager.create(firstRunDeps);
    const firstAsset = register(manager1);
    manager1.reserveIndexForOrganize(firstAsset);

    const lastPersistedCounters = firstRunDeps.persistIndexCounters.mock.calls.at(-1)?.[0];
    const manager2 = await JobManager.create({
      loadPendingAssets: vi.fn(async () => ({})),
      persistPendingAssets: vi.fn(),
      loadPersistedIndexCounters: vi.fn(async () => lastPersistedCounters ?? {}),
      persistIndexCounters: vi.fn(),
      generateJobId: vi.fn(() => "job-restart"),
    });
    const secondAsset = register(manager2);

    expect(manager2.reserveIndexForOrganize(secondAsset)).toBe(2); // continues from 1, not reset
  });
});
