// Centralized chrome.storage.local key names, shared by background, popup, and
// options (all of which can use ES module imports — unlike content-scripts/
// intentPing.ts, which must duplicate SESSION_STORAGE_KEY locally; see the
// comment there).

export const SESSION_STORAGE_KEY = "aiAssetSaver.sessionState";
export const INDEX_COUNTERS_STORAGE_KEY = "aiAssetSaver.indexCounters";
export const PENDING_ASSETS_STORAGE_KEY = "aiAssetSaver.pendingAssets";
/** chrome.storage.session (not .local): a per-browser-session, memory-backed
 * record of "this browserDownloadId was matched as an AI download" — written
 * synchronously in onDeterminingFilename and read back when onChanged reports
 * completion. Needed because a large video download can outlive the MV3
 * service worker's idle lifetime; storage.session (unlike an in-memory Map)
 * survives that restart while still never touching disk or surviving a real
 * browser restart. */
export const IN_FLIGHT_DETECTIONS_STORAGE_KEY = "aiAssetSaver.inFlightDetections";
