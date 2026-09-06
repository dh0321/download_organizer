// §Rescan — a manual, explicit action (independent of Watch Mode's current
// on/off state) that reads the real OS Downloads folder directly, via the
// Agent's "list-downloads-folder" native message, and shows what it finds in
// a picker (grouped and collapsible by day) so the user chooses what actually
// gets imported. Deliberately NOT chrome.downloads.search(): that only
// reflects Chrome's own download history database, which can lose an entry
// (e.g. "Clear browsing data") while the file itself is still sitting
// untouched on disk — confirmed live this session as the reason a real user's
// older-but-still-present downloads were invisible to Rescan. Reading the
// folder itself has no such blind spot.
//
// This is a two-step flow, not a one-click import: scanDownloadsFolder() only
// *finds* candidates (never registers them), and the Inbox shows them to the
// user in the picker so they choose what actually gets imported via
// importRescanCandidates(). Auto-importing everything the scan finds was
// tried first and produced too much noise — letting the user pick is the
// deliberate fix, not a stopgap.
//
// A file found this way has no chrome.downloads history entry at all, so
// there's no browserDownloadId to attach (see PendingAsset.browserDownloadId) —
// identity/dedup here is by absolute path instead.

import { adapters, mediaTypeForExtension } from "../adapters/registry.js";
import { basenameOf } from "./downloadListener.js";
import type { JobManager } from "./jobManager.js";
import type { DownloadsFolderEntry, MediaType, NamingFields, NativeRequest, NativeResponse } from "@download-organizer/shared";

const FILENAME_HINTS: Record<string, RegExp> = {
  chatgpt: /chatgpt/i,
  gemini: /gemini|nano.?banana/i,
  seedance: /seedance/i,
  midjourney: /midjourney/i,
};

export interface RescanCandidate {
  sourcePath: string;
  originalFilename: string;
  extension: string;
  mediaType: MediaType;
  source: string;
  downloadedAt: number;
}

/** A raw folder listing carries no URL/referrer, so host-matching (the
 * stronger signal used for live detection) isn't available — only the
 * filename-hint fallback applies here. */
function guessSourceFromFilename(filename: string): string {
  for (const adapter of adapters) {
    if (FILENAME_HINTS[adapter.id]?.test(filename)) return adapter.id;
  }
  return "";
}

/** Reads the Downloads folder via the Agent — never registers anything. */
export async function scanDownloadsFolder(
  jobManager: JobManager,
  sendToAgent: (req: NativeRequest) => Promise<NativeResponse>,
): Promise<{ candidates: RescanCandidate[] } | { error: string }> {
  const res = await sendToAgent({ type: "list-downloads-folder" });
  if (res.type !== "list-downloads-folder-result") {
    return { error: "Unexpected response from Local App" };
  }
  if (!res.ok) {
    return { error: res.error };
  }

  const alreadyTrackedPaths = new Set(jobManager.allPendingAssets().map((a) => a.sourcePath));

  const candidates: RescanCandidate[] = [];
  for (const file of res.files as DownloadsFolderEntry[]) {
    if (alreadyTrackedPaths.has(file.path)) continue;

    const mediaType = mediaTypeForExtension(file.extension);
    if (!mediaType) continue;

    candidates.push({
      sourcePath: file.path,
      originalFilename: file.filename,
      extension: file.extension,
      mediaType,
      source: guessSourceFromFilename(basenameOf(file.filename)),
      downloadedAt: file.modifiedAt,
    });
  }

  return { candidates };
}

/** Registers only the candidates the user chose to import from the picker. */
export function importRescanCandidates(
  jobManager: JobManager,
  candidates: RescanCandidate[],
  buildDefaultNaming: () => NamingFields,
): { addedCount: number } {
  const alreadyTrackedPaths = new Set(jobManager.allPendingAssets().map((a) => a.sourcePath));

  let addedCount = 0;
  for (const candidate of candidates) {
    if (alreadyTrackedPaths.has(candidate.sourcePath)) continue; // safety net against a stale/duplicate picker submission
    jobManager.registerPendingAsset({ ...candidate, naming: buildDefaultNaming() });
    addedCount++;
  }

  return { addedCount };
}
