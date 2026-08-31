// Thin, direct chrome.storage.local accessor for PendingAsset records —
// mirrors sessionManager.ts's pattern so any extension page (popup, Inbox,
// background) can read the current Pending Asset list without round-tripping
// through a runtime message; chrome.storage.local is shared across every
// context an extension runs in. Only JobManager (background) ever WRITES
// here — see jobManager.ts's persist().

import type { PendingAsset } from "@ai-asset-saver/shared";
import { PENDING_ASSETS_STORAGE_KEY } from "./storageKeys.js";

export async function loadPendingAssets(): Promise<Record<string, PendingAsset>> {
  const result = await chrome.storage.local.get(PENDING_ASSETS_STORAGE_KEY);
  return (result[PENDING_ASSETS_STORAGE_KEY] as Record<string, PendingAsset> | undefined) ?? {};
}

export function persistPendingAssets(assets: Record<string, PendingAsset>): void {
  void chrome.storage.local.set({ [PENDING_ASSETS_STORAGE_KEY]: assets });
}
