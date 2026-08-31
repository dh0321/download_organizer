// Centralized chrome.storage.local key names, shared by background, popup, and
// options (all of which can use ES module imports — unlike content-scripts/
// intentPing.ts, which must duplicate SESSION_STORAGE_KEY locally; see the
// comment there).

export const SESSION_STORAGE_KEY = "aiAssetSaver.sessionState";
export const INDEX_COUNTERS_STORAGE_KEY = "aiAssetSaver.indexCounters";
