// §F-1 Index Reservation — a synchronous, race-free in-memory counter.
//
// This MUST be driven synchronously (no `await` between reading and incrementing)
// for the race-freedom argument in PLAN.md §F-1 to hold: MV3 service workers are
// single-threaded, so as long as reserveNext() never yields to the event loop
// mid-loop, several Pending Assets organized in the same Organize click cannot
// observe or produce a duplicate index. (Originally driven from
// onDeterminingFilename at download-detection time; the Download → Inbox →
// Organize redesign moved the call site to Organize-click time — see
// jobManager.ts's reserveIndicesForOrganize — but the technique is unchanged.)
//
// The Agent-reported `get-max-index` value (via reconcile()) is a *lower bound*
// correction only — this counter is never the sole authority against disk reality;
// the Agent's own O_EXCL conflict suffix is the final safety net (see file-router).

/**
 * Deliberately keyed on the same fields that make up the actual destination
 * folder (project/sequence/bucket) — NOT shot, which is a filename identifier
 * rather than a folder level (see DEFAULT_FOLDER_TEMPLATE). Keying on shot
 * here would desync this in-session reservation counter from the Agent's own
 * get-max-index reconciliation, which scans the real destination folder and
 * has no notion of "shot" either — two different Shot/Asset Name values that
 * land in the same folder must share one counter, the same way the Agent's
 * on-disk scan already treats that folder as a single sequence.
 */
export function buildIndexKey(parts: {
  project: string;
  sequence: string;
  bucketId?: string;
  customFolderName?: string;
  mediaType: string;
}): string {
  return [parts.project, parts.sequence, parts.bucketId ?? parts.customFolderName ?? "", parts.mediaType]
    .map((p) => p.trim().toLowerCase())
    .join("|");
}

/**
 * Index key for Custom Directory jobs (§F-1): the actual destination folder no
 * longer depends on project/sequence/shot/bucket once Custom Directory is on
 * (see fileRouter.ts's computeCandidatePath), so the sequential counter must
 * key off the custom directory string itself instead.
 */
export function buildIndexKeyForCustomDirectory(customDirectory: string, mediaType: string): string {
  return `custom-dir:${customDirectory.trim().toLowerCase()}|${mediaType.trim().toLowerCase()}`;
}

export class IndexReservationCounter {
  private counters: Map<string, number>;

  constructor(initial: Record<string, number> = {}) {
    this.counters = new Map(Object.entries(initial));
  }

  /**
   * Synchronously reserves and returns the next index for `key`, starting at 1.
   * Call this exactly once per Pending Asset being organized, inside the
   * synchronous reservation loop, with no `await` before it.
   */
  reserveNext(key: string): number {
    const current = this.counters.get(key) ?? 0;
    const next = current + 1;
    this.counters.set(key, next);
    return next;
  }

  /**
   * Reconciles the local counter against a value the Agent reported (the highest
   * index already present on disk for this key, via get-max-index). Only ever moves
   * the counter forward, never backward — a lower disk-reported value never
   * un-reserves indices already handed out this session.
   */
  reconcile(key: string, agentReportedMax: number): void {
    const current = this.counters.get(key) ?? 0;
    this.counters.set(key, Math.max(current, agentReportedMax));
  }

  peek(key: string): number {
    return this.counters.get(key) ?? 0;
  }

  /** For persisting to chrome.storage.local as a restart-recovery checkpoint. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters.entries());
  }
}
