// Shared adapter-matching logic. See PLAN.md §F (Download Detection Flow).
//
// Deliberately does NOT scrape any AI-site DOM structure — the only site-specific
// knowledge here is a small host allowlist (§K). The intent-ping correlation window
// is a heuristic explicitly flagged in PLAN.md §Q as needing empirical validation
// against real ChatGPT/Gemini download behavior before being trusted in production.

import type { AISourceAdapter, IntentPing } from "@ai-asset-saver/shared";

export const INTENT_PING_WINDOW_MS = 3000;

/**
 * The URL's hostname, or null if it isn't a host-bearing URL at all —
 * unparseable, OR a non-"special" scheme (per the URL spec, only
 * ftp/file/http/https/ws/wss get authority/host parsing). `blob:` is exactly
 * such a scheme: a real, empirically-observed ChatGPT download URL looks like
 * `blob:https://chatgpt.com/<uuid>`, and `new URL(...).hostname` on that is
 * `""`, not "chatgpt.com" — confirmed live (§Q was right to flag this as
 * unverified). Returning null (not "") lets callers distinguish "no host
 * information available" from "resolved to a host that doesn't match".
 */
function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export function hostMatches(url: string, hostPatterns: string[]): boolean {
  const host = extractHostname(url);
  if (!host) return false;
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
      // Gate 2 (§F): reject outright if url or referrer DOES resolve to a
      // real host and it's for a different site — that's a confident "not
      // from us" signal no ping should be able to override.
      const urlHost = extractHostname(ctx.url);
      const referrerHost = ctx.referrer ? extractHostname(ctx.referrer) : null;
      if (urlHost && !hostMatches(ctx.url, hostPatterns)) return false;
      if (referrerHost && !hostMatches(ctx.referrer!, hostPatterns)) return false;

      const hostConfirmed = (urlHost !== null && hostMatches(ctx.url, hostPatterns)) || (referrerHost !== null && hostMatches(ctx.referrer!, hostPatterns));

      // When NEITHER url nor referrer carries usable host info at all (the
      // `blob:`/`data:` case above, or a download with no referrer — both
      // very common for AI-generated media), fall back entirely to a recent,
      // origin-matching intent-ping: it's the only signal left, and it's
      // still bounded by its own short time window + origin check below.
      if (!hostConfirmed && !ctx.recentIntentPing) return false;

      // Gate 3 (§F): the ping's own origin must match this adapter's hosts —
      // a ping from an unrelated tab can never corroborate this adapter,
      // even if url/referrer independently matched.
      if (ctx.recentIntentPing && !hostMatches(ctx.recentIntentPing.origin, hostPatterns)) {
        return false;
      }
      return pingWithinWindow(ctx.recentIntentPing, Date.now());
    },
  };
}
