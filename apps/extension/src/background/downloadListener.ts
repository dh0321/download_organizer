// §D download-listener — the actual chrome.downloads wiring. This is the one
// module whose real-world behavior PLAN.md §Q flags as unverified against live
// ChatGPT/Gemini download traffic (the exact shape of `url`/`referrer` for a
// blob: download, whether onDeterminingFilename fires at all for it, etc.) — the
// gating logic itself (§F, §F-1) is unit-tested in isolation elsewhere; this file
// is the thin, mostly-untestable-without-a-real-browser glue on top of it.

import { findMatchingAdapter, mediaTypeForExtension } from "../adapters/registry.js";
import type { JobManager } from "./jobManager.js";
import type { IntentPingStore } from "./intentPingStore.js";
import type { SessionState } from "@ai-asset-saver/shared";

export const STAGING_DIR_NAME = "_AIAssetSaver_staging";

export interface DownloadListenerDeps {
  jobManager: JobManager;
  intentPingStore: IntentPingStore;
  getSession(): SessionState;
  getCachedRootForDisplay(): string;
  onJobDetected(jobId: string, browserDownloadId: number): void;
  onDownloadComplete(jobId: string): void;
  onDownloadCancelled(jobId: string): void;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

export function registerDownloadListeners(deps: DownloadListenerDeps): void {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    const session = deps.getSession();

    // Gate 1 (§F): AI Session OFF is a hard boundary — do nothing at all.
    if (!session.aiSessionEnabled) return;

    const extension = extensionOf(item.filename);
    const mediaType = mediaTypeForExtension(extension);
    // Gate 4 (§F): unsupported extension (pdf/zip/exe/...) -> untouched.
    if (!mediaType) return;

    const adapter = findMatchingAdapter({
      url: item.url,
      referrer: item.referrer,
      recentIntentPing: deps.intentPingStore.mostRecent(),
    });
    // Gates 2+3 (§F): no matching AI-site adapter -> untouched.
    if (!adapter) return;

    // §F-1 — everything from here to reserving the index runs synchronously, with
    // no `await`, which is the entire race-freedom argument for concurrent detections.
    const job = deps.jobManager.detectJob({
      browserDownloadId: item.id,
      originalFilename: item.filename,
      extension,
      mediaType,
      source: adapter.id,
      session,
      cachedRootForDisplay: deps.getCachedRootForDisplay(),
    });

    const stagedName = `${STAGING_DIR_NAME}/${job.id}${extension}`;
    suggest({ filename: stagedName, conflictAction: "uniquify" });
    deps.onJobDetected(job.id, item.id);
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.state) return;

    if (delta.state.current === "complete") {
      const job = deps.jobManager.getByBrowserDownloadId(delta.id);
      if (!job) return; // not one of ours (or Session was off when it started)
      deps.jobManager.setStatus(job.id, "downloaded");
      deps.onDownloadComplete(job.id);
      return;
    }

    if (delta.state.current === "interrupted") {
      const job = deps.jobManager.getByBrowserDownloadId(delta.id);
      if (!job) return;
      // Chrome reports the interruption reason via delta.error, not delta.state —
      // any interruption on a job that never reached "downloaded" is treated as a
      // cancellation for index-gap purposes (§F-1); a true network failure vs. an
      // explicit user cancel both leave the reserved index unused either way.
      deps.jobManager.setStatus(job.id, "cancelled");
      deps.onDownloadCancelled(job.id);
    }
  });
}
