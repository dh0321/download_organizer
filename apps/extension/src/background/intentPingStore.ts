// §D content-scripts (intent-ping) receiver. Holds only a timestamp + origin per
// ping — no filenames, no page content, nothing beyond "a click happened here at
// time T" (§F-2 Privacy / Chrome Security: content-script data can only ever
// influence *whether* a download is treated as AI-sourced, never *what* path or
// filename is used).

import type { IntentPing } from "@ai-asset-saver/shared";

const RETENTION_MS = 10_000; // pings older than this are pruned; well beyond the 3s correlation window

export class IntentPingStore {
  private pings: IntentPing[] = [];

  record(origin: string, timestamp: number = Date.now()): void {
    this.pings.push({ origin, timestamp });
    this.prune(timestamp);
  }

  private prune(now: number): void {
    this.pings = this.pings.filter((p) => now - p.timestamp <= RETENTION_MS);
  }

  /** Most recent ping overall — the adapter itself checks the ping's origin matches. */
  mostRecent(): IntentPing | undefined {
    this.prune(Date.now());
    if (this.pings.length === 0) return undefined;
    return this.pings.reduce((latest, p) => (p.timestamp > latest.timestamp ? p : latest));
  }

  clear(): void {
    this.pings = [];
  }
}
