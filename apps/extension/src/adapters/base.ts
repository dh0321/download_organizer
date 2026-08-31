// Shared adapter-matching logic. See PLAN.md §F (Download Detection Flow).
//
// Deliberately does NOT scrape any AI-site DOM structure — the only site-specific
// knowledge here is a small host allowlist (§K). The intent-ping correlation window
// is a heuristic explicitly flagged in PLAN.md §Q as needing empirical validation
// against real ChatGPT/Gemini download behavior before being trusted in production.

import type { AISourceAdapter, IntentPing } from "@ai-asset-saver/shared";

export const INTENT_PING_WINDOW_MS = 3000;

export function hostMatches(url: string, hostPatterns: string[]): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return hostPatterns.some((pattern) => host === pattern || host.endsWith(`.${pattern}`));
}

export function pingWithinWindow(ping: IntentPing | undefined, now: number, windowMs = INTENT_PING_WINDOW_MS): boolean {
  if (!ping) return false;
  return now - ping.timestamp <= windowMs && now >= ping.timestamp;
}

export function makeHostAdapter(id: string, label: string, hostPatterns: string[]): AISourceAdapter {
  return {
    id,
    label,
    hostPatterns,
    matchesDownload(ctx) {
      // Gate 2 (§F): url or referrer must match one of this adapter's hosts.
      const urlMatches = hostMatches(ctx.url, hostPatterns);
      const referrerMatches = ctx.referrer ? hostMatches(ctx.referrer, hostPatterns) : false;
      if (!urlMatches && !referrerMatches) return false;

      // Gate 3 (§F): additionally require a recent intent-ping from a matching
      // origin tab, since `url`/`referrer` alone can be empty for blob: downloads.
      // If the ping's own origin doesn't match this adapter's hosts, it cannot be
      // used to corroborate this adapter's match (avoids cross-adapter confusion).
      if (ctx.recentIntentPing && !hostMatches(ctx.recentIntentPing.origin, hostPatterns)) {
        return false;
      }
      return pingWithinWindow(ctx.recentIntentPing, Date.now());
    },
  };
}
