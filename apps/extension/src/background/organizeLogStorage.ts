// Thin, direct chrome.storage.local accessor for OrganizeLogEntry records —
// mirrors pendingAssetsStorage.ts's pattern so any extension page (popup,
// Inbox, background) can read the current log without round-tripping through
// a runtime message. Only JobManager (background) ever WRITES here.

import type { OrganizeLogEntry } from "@ai-asset-saver/shared";
import { ORGANIZE_LOG_STORAGE_KEY } from "./storageKeys.js";

export async function loadOrganizeLog(): Promise<OrganizeLogEntry[]> {
  const result = await chrome.storage.local.get(ORGANIZE_LOG_STORAGE_KEY);
  return (result[ORGANIZE_LOG_STORAGE_KEY] as OrganizeLogEntry[] | undefined) ?? [];
}

export function persistOrganizeLog(entries: OrganizeLogEntry[]): void {
  void chrome.storage.local.set({ [ORGANIZE_LOG_STORAGE_KEY]: entries });
}
