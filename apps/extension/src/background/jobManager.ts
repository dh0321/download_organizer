// §6/§11 Pending Asset store. A download that completes while AI Session is on
// is registered here as a PendingAsset — nothing is written to disk yet. Index
// Reservation (§F-1) happens once, synchronously, right before an Organize
// batch is sent to the Agent (see organizeFlow.ts) — no persisted counter is
// kept here any more (see that file's header for why): confirmed live that a
// counter surviving across sessions/manual deletions in the destination
// folder produced a filename number the folder's real contents didn't
// support (e.g. "v002" in an empty folder).

import {
  buildIndexKey,
  buildIndexKeyForCustomDirectory,
  type PendingAsset,
  type PendingAssetStatus,
  type NamingFields,
  type MediaType,
  type OrganizeLogEntry,
} from "@download-organizer/shared";

export interface JobManagerDeps {
  loadPendingAssets(): Promise<Record<string, PendingAsset>>;
  /** Fire-and-forget — every mutating method calls this after updating memory. */
  persistPendingAssets(assets: Record<string, PendingAsset>): void;
  loadOrganizeLog(): Promise<OrganizeLogEntry[]>;
  /** Fire-and-forget, same as persistPendingAssets. */
  persistOrganizeLog(entries: OrganizeLogEntry[]): void;
  generateJobId(): string;
}

/** How long an OrganizeLogEntry survives after being written — see
 * pruneOrganizedIntoLog/emptyInbox. Pruned lazily (no chrome.alarms): every
 * time the log is written to, entries older than this are dropped too. */
export const LOG_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;

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
 * outside JobManager (organizeFlow.ts's list-destination-files step) can
 * compute the same key without duplicating the branch — it's purely a
 * "which destination folder" grouping key, unrelated to any stored counter. */
export function pendingAssetIndexKey(asset: Pick<PendingAsset, "mediaType" | "naming">): string {
  return asset.naming.customDirectoryEnabled
    ? buildIndexKeyForCustomDirectory(asset.naming.customDirectory ?? "", asset.mediaType)
    : buildIndexKey({
        project: asset.naming.project,
        sequence: asset.naming.sequence,
        bucketId: asset.naming.bucketId,
        mediaType: asset.mediaType,
      });
}

export class JobManager {
  private readonly assets = new Map<string, PendingAsset>();
  private log: OrganizeLogEntry[];

  private constructor(
    private readonly deps: JobManagerDeps,
    initialAssets: Record<string, PendingAsset>,
    initialLog: OrganizeLogEntry[],
  ) {
    for (const [id, asset] of Object.entries(initialAssets)) this.assets.set(id, asset);
    this.log = initialLog;
  }

  static async create(deps: JobManagerDeps): Promise<JobManager> {
    const [assets, log] = await Promise.all([deps.loadPendingAssets(), deps.loadOrganizeLog()]);
    return new JobManager(deps, assets, log);
  }

  private persist(): void {
    this.deps.persistPendingAssets(Object.fromEntries(this.assets.entries()));
  }

  private persistLog(): void {
    this.deps.persistOrganizeLog(this.log);
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

  /** Organize success path: like setStatus(id, "organized"), but also records
   * the real destination path so it can later be written to the organize log
   * (see pruneOrganizedIntoLog/emptyInbox) before the asset itself is cleared
   * from the active Inbox list. */
  markOrganized(id: string, finalPath: string): void {
    const asset = this.assets.get(id);
    if (!asset) return;
    asset.status = "organized";
    asset.finalPath = finalPath;
    asset.errorMessage = undefined;
    this.persist();
  }

  /** Removes a single asset from the tracked list only — never touches the
   * real file on disk. Refuses "organizing" assets since they're mid-flight
   * with the Agent; every other status (pending/failed/organized) is
   * removable. Organized assets are dropped with NO log entry here (compare
   * pruneOrganizedIntoLog/emptyInbox) since this is a manual per-row dismiss,
   * not the "already handled, keep a record" auto-cleanup path. */
  removeAsset(id: string): void {
    const asset = this.assets.get(id);
    if (!asset || asset.status === "organizing") return;
    this.assets.delete(id);
    this.persist();
  }

  /** Auto-cleanup: called on every fresh Inbox page load. Moves every
   * currently-"organized" asset into the organize log (recording where it
   * went) and removes it from the active list, then prunes any log entries
   * past LOG_RETENTION_MS. Pending/failed/organizing assets are untouched. */
  pruneOrganizedIntoLog(): void {
    const now = Date.now();
    const beforeLogLength = this.log.length;
    let assetsChanged = false;
    for (const [id, asset] of this.assets) {
      if (asset.status !== "organized") continue;
      this.log.push({
        id: this.deps.generateJobId(),
        originalFilename: asset.originalFilename,
        finalPath: asset.finalPath ?? "",
        loggedAt: now,
      });
      this.assets.delete(id);
      assetsChanged = true;
    }
    this.log = this.log.filter((entry) => now - entry.loggedAt < LOG_RETENTION_MS);
    if (assetsChanged) this.persist();
    if (assetsChanged || this.log.length !== beforeLogLength) this.persistLog();
  }

  /** "Inbox 비우기": deletes every tracked asset regardless of status
   * (pending/organizing/organized/failed all removed) — unlike removeAsset,
   * this is an explicit bulk wipe the user confirmed. Organized assets are
   * logged first (same as pruneOrganizedIntoLog) so their destination isn't
   * lost; pending/failed assets never had a destination, so they're just
   * discarded with no log entry. */
  emptyInbox(): void {
    const now = Date.now();
    for (const asset of this.assets.values()) {
      if (asset.status !== "organized") continue;
      this.log.push({
        id: this.deps.generateJobId(),
        originalFilename: asset.originalFilename,
        finalPath: asset.finalPath ?? "",
        loggedAt: now,
      });
    }
    this.assets.clear();
    this.log = this.log.filter((entry) => now - entry.loggedAt < LOG_RETENTION_MS);
    this.persist();
    this.persistLog();
  }

  /** Live (not-yet-expired) organize log entries, newest first. */
  getOrganizeLog(): OrganizeLogEntry[] {
    const now = Date.now();
    return this.log
      .filter((entry) => now - entry.loggedAt < LOG_RETENTION_MS)
      .sort((a, b) => b.loggedAt - a.loggedAt);
  }

}
