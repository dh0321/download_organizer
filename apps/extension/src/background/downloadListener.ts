// §5 Download Detection — downloads are left completely untouched at
// detection time (no staging redirect, no suggest() call at all): if AI
// Session is on and the download matches an adapter, we just remember that
// this browserDownloadId is "ours" and register it as a Pending Asset once
// Chrome reports the download complete, using whatever absolute path Chrome
// actually wrote the file to. See the Download → Inbox → Edit → Organize plan.
//
// IMPORTANT: chrome.downloads.on*.addListener(...) below is still called
// synchronously at the top of registerDownloadListeners(), which itself must
// be called synchronously at module top level — MV3 only guarantees an event
// isn't missed if the listener was registered during the service worker's
// initial synchronous script evaluation.
//
// "Is this browserDownloadId one we're tracking" has to survive a mid-download
// service worker eviction too (a large video download can easily outlive an
// MV3 SW's idle lifetime) — kept in an in-memory Map for the fast path, backed
// by chrome.storage.session (memory-only, survives SW restarts, cleared on
// browser close — not chrome.storage.local, which would need explicit
// eventual cleanup instead of vanishing naturally with the browser session).

import { findMatchingAdapter, mediaTypeForExtension } from "../adapters/registry.js";
import type { JobManager } from "./jobManager.js";
import type { IntentPingStore } from "./intentPingStore.js";
import type { MediaType, NamingFields, PendingAsset, SessionState } from "@ai-asset-saver/shared";
import { IN_FLIGHT_DETECTIONS_STORAGE_KEY } from "./storageKeys.js";

interface InFlightDetection {
  source: string;
  mediaType: MediaType;
  extension: string;
}

export interface DownloadListenerDeps {
  jobManagerPromise: Promise<JobManager>;
  intentPingStore: IntentPingStore;
  getSession(): SessionState;
  /** Builds the NamingFields a brand-new Pending Asset starts with, pre-filled
   * from the current Batch Defaults (§8) — Shot/Description start empty (only
   * ever set per-asset) and Custom Folder/Filename start off (Auto). */
  buildDefaultNaming(): NamingFields;
  onAssetRegistered(asset: PendingAsset): void;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot).toLowerCase();
}

function basenameOf(filename: string): string {
  return filename.split(/[\\/]/).pop() ?? filename;
}

export function registerDownloadListeners(deps: DownloadListenerDeps): void {
  const inFlight = new Map<number, InFlightDetection>();

  // Cold-start recovery: restore any detections a previous, now-evicted
  // service worker instance recorded, in case this instance's onChanged fires
  // for a download whose onDeterminingFilename it never itself saw.
  void chrome.storage.session.get(IN_FLIGHT_DETECTIONS_STORAGE_KEY).then((result) => {
    const restored = result[IN_FLIGHT_DETECTIONS_STORAGE_KEY] as Record<string, InFlightDetection> | undefined;
    if (!restored) return;
    for (const [id, detection] of Object.entries(restored)) {
      if (!inFlight.has(Number(id))) inFlight.set(Number(id), detection);
    }
  });

  function persistInFlight(): void {
    void chrome.storage.session.set({
      [IN_FLIGHT_DETECTIONS_STORAGE_KEY]: Object.fromEntries(inFlight.entries()),
    });
  }

  chrome.downloads.onDeterminingFilename.addListener((item) => {
    const session = deps.getSession();
    // §F hard boundary: AI Session OFF means no detection/registration at all.
    if (!session.aiSessionEnabled) {
      console.log("[AIAS] onDeterminingFilename: skipped, AI Session is OFF", item.filename);
      return;
    }

    const extension = extensionOf(item.filename);
    const mediaType = mediaTypeForExtension(extension);
    if (!mediaType) {
      console.log("[AIAS] onDeterminingFilename: skipped, unsupported extension", extension, item.filename);
      return;
    }

    const ping = deps.intentPingStore.mostRecent();
    const adapter = findMatchingAdapter({
      url: item.url,
      referrer: item.referrer,
      recentIntentPing: ping,
    });
    console.log("[AIAS] onDeterminingFilename", {
      url: item.url,
      referrer: item.referrer,
      recentIntentPing: ping,
      matchedAdapter: adapter?.id ?? null,
    });
    if (!adapter) return;

    // No suggest() call: the file lands exactly where Chrome's own default
    // Downloads behavior puts it (§5) — nothing to lose track of if the user
    // never opens the Inbox or never clicks Organize.
    inFlight.set(item.id, { source: adapter.id, mediaType, extension });
    persistInFlight();
    console.log("[AIAS] onDeterminingFilename: tracking as AI download", item.id, adapter.id);
  });

  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta.state) return;

    if (delta.state.current === "complete") {
      const detection = inFlight.get(delta.id);
      console.log("[AIAS] onChanged complete", delta.id, "tracked:", detection ?? null);
      if (!detection) return; // not one of ours (or Session was off when it started)
      inFlight.delete(delta.id);
      persistInFlight();

      void chrome.downloads.search({ id: delta.id }).then(([item]) => {
        if (!item) return; // download item vanished before we could read its final path
        void deps.jobManagerPromise.then((jm) => {
          const asset = jm.registerPendingAsset({
            browserDownloadId: delta.id,
            sourcePath: item.filename,
            originalFilename: basenameOf(item.filename),
            extension: detection.extension,
            mediaType: detection.mediaType,
            source: detection.source,
            downloadedAt: Date.now(),
            naming: deps.buildDefaultNaming(),
          });
          console.log("[AIAS] registered PendingAsset", asset);
          deps.onAssetRegistered(asset);
        });
      });
      return;
    }

    if (delta.state.current === "interrupted") {
      // No Pending Asset was ever created for this one (that only happens on
      // "complete") — just stop tracking it.
      if (inFlight.delete(delta.id)) persistInFlight();
    }
  });
}
