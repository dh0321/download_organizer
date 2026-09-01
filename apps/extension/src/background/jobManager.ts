// §6/§11 Pending Asset store. A download that completes while AI Session is on
// is registered here as a PendingAsset — nothing is written to disk yet. Index
// Reservation (§F-1) no longer happens at registration time; it happens once,
// synchronously, right before an Organize batch is sent to the Agent (see
// reserveIndexForOrganize) — the same race-free "no `await` mid-loop" technique
// as before, just invoked from a different trigger point.

import {
  IndexReservationCounter,
  buildIndexKey,
  buildIndexKeyForCustomDirectory,
  type PendingAsset,
  type PendingAssetStatus,
  type NamingFields,
  type MediaType,
} from "@ai-asset-saver/shared";

export interface JobManagerDeps {
  loadPendingAssets(): Promise<Record<string, PendingAsset>>;
  /** Fire-and-forget — every mutating method calls this after updating memory. */
  persistPendingAssets(assets: Record<string, PendingAsset>): void;
  loadPersistedIndexCounters(): Promise<Record<string, number>>;
  /** Fire-and-forget — never awaited from inside reserveIndexForOrganize (§F-1). */
  persistIndexCounters(snapshot: Record<string, number>): void;
  generateJobId(): string;
}

export interface RegisterPendingAssetParams {
  browserDownloadId?: number;
  sourcePath: string;
  originalFilename: string;
  extension: string;
  mediaType: MediaType;
  source: string;
  downloadedAt: number;
  /** Pre-filled from the current Batch Defaults (§8) at registration time. */
  naming: NamingFields;
}

const ORGANIZABLE_STATUSES: PendingAssetStatus[] = ["pending", "failed"];

/** Same key formula Index Reservation has always used (§F-1) — Custom Directory
 * assets key off the directory string instead of project/sequence/shot/bucket
 * (see fileRouter.ts's computeCandidatePath for why). Exported so callers
 * outside JobManager (the Organize flow's get-max-index step) can compute the
 * same key without duplicating the branch. */
export function pendingAssetIndexKey(asset: Pick<PendingAsset, "mediaType" | "naming">): string {
  return asset.naming.customDirectoryEnabled
    ? buildIndexKeyForCustomDirectory(asset.naming.customDirectory ?? "", asset.mediaType)
    : buildIndexKey({
        project: asset.naming.project,
        sequence: asset.naming.sequence,
        shot: asset.naming.shot,
        bucketId: asset.naming.bucketId,
        mediaType: asset.mediaType,
      });
}

export class JobManager {
  private readonly counter: IndexReservationCounter;
  private readonly assets = new Map<string, PendingAsset>();

  private constructor(
    private readonly deps: JobManagerDeps,
    initialAssets: Record<string, PendingAsset>,
    initialCounters: Record<string, number>,
  ) {
    this.counter = new IndexReservationCounter(initialCounters);
    for (const [id, asset] of Object.entries(initialAssets)) this.assets.set(id, asset);
  }

  static async create(deps: JobManagerDeps): Promise<JobManager> {
    const [assets, counters] = await Promise.all([deps.loadPendingAssets(), deps.loadPersistedIndexCounters()]);
    return new JobManager(deps, assets, counters);
  }

  private persist(): void {
    this.deps.persistPendingAssets(Object.fromEntries(this.assets.entries()));
  }

  registerPendingAsset(params: RegisterPendingAssetParams): PendingAsset {
    const asset: PendingAsset = {
      id: this.deps.generateJobId(),
      browserDownloadId: params.browserDownloadId,
      sourcePath: params.sourcePath,
      originalFilename: params.originalFilename,
      extension: params.extension,
      mediaType: params.mediaType,
      source: params.source,
      downloadedAt: params.downloadedAt,
      status: "pending",
      selected: true,
      naming: params.naming,
    };
    this.assets.set(asset.id, asset);
    this.persist();
    return asset;
  }

  get(id: string): PendingAsset | undefined {
    return this.assets.get(id);
  }

  getByBrowserDownloadId(browserDownloadId: number): PendingAsset | undefined {
    for (const asset of this.assets.values()) {
      if (asset.browserDownloadId === browserDownloadId) return asset;
    }
    return undefined;
  }

  allPendingAssets(): PendingAsset[] {
    return Array.from(this.assets.values());
  }

  /** Assets still eligible for editing/Organize — excludes "organizing" (in
   * flight) and "organized" (done) so a finished item never reappears as if
   * still pending. */
  organizableAssets(): PendingAsset[] {
    return this.allPendingAssets().filter((a) => ORGANIZABLE_STATUSES.includes(a.status));
  }

  updateNaming(id: string, patch: Partial<NamingFields>): void {
    const asset = this.assets.get(id);
    if (!asset) return;
    asset.naming = { ...asset.naming, ...patch };
    this.persist();
  }

  /** Lets the user correct/override the auto-detected source (e.g. "chatgpt")
   * directly — distinct from updateNaming since `source` lives on the
   * PendingAsset itself, not inside its `naming` sub-object (§ Source token). */
  updateSource(id: string, source: string): void {
    const asset = this.assets.get(id);
    if (!asset) return;
    asset.source = source;
    this.persist();
  }

  setSelected(id: string, selected: boolean): void {
    const asset = this.assets.get(id);
    if (!asset) return;
    asset.selected = selected;
    this.persist();
  }

  setAllSelected(selected: boolean): void {
    for (const asset of this.assets.values()) {
      if (ORGANIZABLE_STATUSES.includes(asset.status)) asset.selected = selected;
    }
    this.persist();
  }

  /** Like setAllSelected, but scoped to a specific id set — used by the Inbox
   * "Select all" button when a display filter (e.g. "AI files only") is
   * active, so hidden assets are never silently selected/deselected. */
  setSelectedByIds(ids: string[], selected: boolean): void {
    const idSet = new Set(ids);
    for (const asset of this.assets.values()) {
      if (idSet.has(asset.id) && ORGANIZABLE_STATUSES.includes(asset.status)) asset.selected = selected;
    }
    this.persist();
  }

  /** §8 Batch Edit UX: explicit bulk overwrite, only ever triggered by the user
   * clicking "Apply defaults to selected" — Batch Defaults changes never
   * silently propagate to already-listed assets any other way. */
  applyDefaultsToSelected(defaults: { project: string; sequence: string; bucketId: string }): void {
    for (const asset of this.assets.values()) {
      if (!asset.selected || !ORGANIZABLE_STATUSES.includes(asset.status)) continue;
      asset.naming = { ...asset.naming, ...defaults };
    }
    this.persist();
  }

  /**
   * Each asset's status is independent of every other asset's (§F-1 Failure
   * Isolation) — this never touches any asset but the one named.
   */
  setStatus(id: string, status: PendingAssetStatus, errorMessage?: string): void {
    const asset = this.assets.get(id);
    if (!asset) return;
    asset.status = status;
    asset.errorMessage = errorMessage;
    this.persist();
  }

  /** Organize flow step: fold the Agent's real on-disk max index (from
   * get-max-index) into the in-memory counter as a lower bound, before any
   * reservation happens for that key. */
  reconcileIndexFloor(key: string, agentReportedMax: number): void {
    this.counter.reconcile(key, agentReportedMax);
  }

  /**
   * §11 Organize Flow step 2: must be called synchronously (no `await` between
   * calls) once per selected asset, after every distinct key's floor has
   * already been reconciled via reconcileIndexFloor — this preserves the exact
   * race-freedom technique index reservation has always used (§F-1), just
   * triggered by the Organize click instead of by download detection.
   */
  reserveIndexForOrganize(asset: PendingAsset): number {
    const index = this.counter.reserveNext(pendingAssetIndexKey(asset));
    this.deps.persistIndexCounters(this.counter.snapshot());
    return index;
  }
}
