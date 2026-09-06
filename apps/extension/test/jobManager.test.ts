import { describe, it, expect, vi } from "vitest";
import { JobManager, LOG_RETENTION_MS } from "../src/background/jobManager.js";
import type { NamingFields, OrganizeLogEntry, PendingAsset } from "@download-organizer/shared";

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
  const persistedLogs: OrganizeLogEntry[][] = [];
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
      loadOrganizeLog: vi.fn(async () => [] as OrganizeLogEntry[]),
      persistOrganizeLog: vi.fn((entries: OrganizeLogEntry[]) => {
        persistedLogs.push(entries);
      }),
      generateJobId: vi.fn(() => `job-${nextId++}`),
    },
    persistedAssets,
    persistedCounters,
    persistedLogs,
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
      loadOrganizeLog: vi.fn(async () => []),
      persistOrganizeLog: vi.fn(),
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

  it("tracks independent Organize-time counters per project/sequence/bucket/mediaType key — shot/name does NOT affect the key, since it's a filename identifier, not a folder level", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const assetShotA = register(manager, { browserDownloadId: 1, naming: naming({ shot: "SH010" }) });
    const assetShotB = register(manager, { browserDownloadId: 2, naming: naming({ shot: "SH020" }) });

    // Same project/sequence/bucket -> same destination folder -> shared counter,
    // even though shot differs (matches the Agent's own get-max-index, which
    // scans the destination folder without regard for shot either).
    expect(manager.reserveIndexForOrganize(assetShotA)).toBe(1);
    expect(manager.reserveIndexForOrganize(assetShotB)).toBe(2);

    const assetOtherSequence = register(manager, { browserDownloadId: 3, naming: naming({ sequence: "SQ020" }) });
    expect(manager.reserveIndexForOrganize(assetOtherSequence)).toBe(1); // different sequence -> different folder -> independent counter
  });

  it("keys the Organize-time counter off the custom directory, not project/sequence/bucket, when enabled", async () => {
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

    manager.reconcileIndexFloor("galaxy_s27|sq010|generated|image", 22);

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
      loadOrganizeLog: vi.fn(async () => []),
      persistOrganizeLog: vi.fn(),
      generateJobId: vi.fn(() => "job-restart"),
    });
    const secondAsset = register(manager2);

    expect(manager2.reserveIndexForOrganize(secondAsset)).toBe(2); // continues from 1, not reset
  });

  it("markOrganized sets status to 'organized' and records the real destination path", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const asset = register(manager);

    manager.markOrganized(asset.id, "/dest/P/Generated/SH020_IMG_v001.png");

    expect(manager.get(asset.id)?.status).toBe("organized");
    expect(manager.get(asset.id)?.finalPath).toBe("/dest/P/Generated/SH020_IMG_v001.png");
  });

  it("removeAsset drops the asset from tracking only — never touches pending/failed/organized, but refuses 'organizing'", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const pending = register(manager, { browserDownloadId: 1 });
    const organizing = register(manager, { browserDownloadId: 2 });
    manager.setStatus(organizing.id, "organizing");

    manager.removeAsset(pending.id);
    expect(manager.get(pending.id)).toBeUndefined();

    manager.removeAsset(organizing.id); // refused — mid-flight with the Agent
    expect(manager.get(organizing.id)).toBeDefined();
  });

  it("pruneOrganizedIntoLog moves organized assets into the log and removes them, leaving pending/failed untouched", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const pending = register(manager, { browserDownloadId: 1 });
    const organized = register(manager, { browserDownloadId: 2, originalFilename: "hero.png" });
    manager.markOrganized(organized.id, "/dest/hero.png");

    manager.pruneOrganizedIntoLog();

    expect(manager.get(organized.id)).toBeUndefined();
    expect(manager.get(pending.id)).toBeDefined();
    const log = manager.getOrganizeLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ originalFilename: "hero.png", finalPath: "/dest/hero.png" });
  });

  it("pruneOrganizedIntoLog also drops log entries older than the retention window", async () => {
    const { deps } = makeDeps();
    const staleEntry: OrganizeLogEntry = {
      id: "old-1",
      originalFilename: "old.png",
      finalPath: "/dest/old.png",
      loggedAt: Date.now() - LOG_RETENTION_MS - 1,
    };
    deps.loadOrganizeLog = vi.fn(async () => [staleEntry]);
    const manager = await JobManager.create(deps);

    manager.pruneOrganizedIntoLog();

    expect(manager.getOrganizeLog()).toHaveLength(0);
  });

  it("emptyInbox deletes every tracked asset regardless of status, logging organized ones first", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const pending = register(manager, { browserDownloadId: 1 });
    const failed = register(manager, { browserDownloadId: 2 });
    manager.setStatus(failed.id, "failed", "boom");
    const organized = register(manager, { browserDownloadId: 3, originalFilename: "hero.png" });
    manager.markOrganized(organized.id, "/dest/hero.png");

    manager.emptyInbox();

    expect(manager.allPendingAssets()).toHaveLength(0);
    expect(manager.get(pending.id)).toBeUndefined();
    expect(manager.get(failed.id)).toBeUndefined();
    const log = manager.getOrganizeLog();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ originalFilename: "hero.png", finalPath: "/dest/hero.png" });
  });
});
