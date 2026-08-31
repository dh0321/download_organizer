// §D content-scripts (intent-ping) / §F-2 Privacy & Safety Boundary.
//
// Deliberately self-contained with NO imports: classic (non-module) content
// scripts cannot resolve bare/relative ES module imports the way the "type":
// "module" background service worker can, so this file must not depend on any
// other module — including @ai-asset-saver/shared or sessionManager.ts. The
// storage key below is intentionally duplicated from sessionManager.ts; keep the
// two in sync if that key ever changes.
//
// This script's ONLY job is: "a click happened in this tab at time T" — it never
// reads page content, never inspects what was clicked, and (per §F-2) never even
// sends that timestamp when AI Session is OFF.

const SESSION_STORAGE_KEY = "aiAssetSaver.sessionState"; // must match sessionManager.ts

let cachedSessionEnabled = false;

function refreshCachedSessionState(): void {
  chrome.storage.local.get(SESSION_STORAGE_KEY).then((result) => {
    cachedSessionEnabled = Boolean(result[SESSION_STORAGE_KEY]?.aiSessionEnabled);
  });
}

refreshCachedSessionState();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  const change = changes[SESSION_STORAGE_KEY];
  if (change) {
    cachedSessionEnabled = Boolean(change.newValue?.aiSessionEnabled);
  }
});

document.addEventListener(
  "click",
  () => {
    if (!cachedSessionEnabled) {
      console.log("[AIAS] click ignored — AI Session is OFF (as seen by this tab)");
      return; // §F-2 — no signal at all while Session is OFF
    }
    console.log("[AIAS] sending intent-ping", location.origin);
    chrome.runtime.sendMessage({
      type: "aias-intent-ping",
      origin: location.origin,
      timestamp: Date.now(),
    });
  },
  { capture: true, passive: true },
);
