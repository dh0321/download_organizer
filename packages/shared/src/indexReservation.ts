// §F-1 Index Reservation — a synchronous, race-free in-memory counter.
//
// This MUST be driven synchronously (no `await` between reading and incrementing)
// from within the Extension's onDeterminingFilename handler for the race-freedom
// argument in PLAN.md §F-1 to hold: MV3 service workers are single-threaded, so as
// long as increment() never yields to the event loop mid-operation, concurrently
// "detected" downloads cannot observe or produce a duplicate index.
//
// The Agent-reported `get-max-index` value (via reconcile()) is a *lower bound*
// correction only — this counter is never the sole authority against disk reality;
// the Agent's own O_EXCL conflict suffix is the final safety net (see file-router).

export function buildIndexKey(parts: {
  project: string;
  sequence: string;
  shot: string;
  bucketId?: string;
  customFolderName?: string;
  mediaType: string;
}): string {
  return [parts.project, parts.sequence, parts.shot, parts.bucketId ?? parts.customFolderName ?? "", parts.mediaType]
    .map((p) => p.trim().toLowerCase())
    .join("|");
}

export class IndexReservationCounter {
  private counters: Map<string, number>;

  constructor(initial: Record<string, number> = {}) {
    this.counters = new Map(Object.entries(initial));
  }

  /**
   * Synchronously reserves and returns the next index for `key`, starting at 1.
   * Call this exactly once per DownloadJob, inside the detection callback, with no
   * `await` before it.
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
