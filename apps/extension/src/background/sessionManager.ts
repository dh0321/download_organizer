// §D session-manager — single source of truth for SessionState, backed by
// chrome.storage.local (never storage.sync — see PLAN.md §I for why).

import type { SessionState } from "@ai-asset-saver/shared";
import { SESSION_STORAGE_KEY as STORAGE_KEY } from "./storageKeys.js";

export const DEFAULT_SESSION_STATE: SessionState = {
  aiSessionEnabled: false,
  currentProject: "",
  currentSequence: "",
  currentShot: "",
  currentBucketId: "generated",
  currentDescription: "",
  selectedNamingPresetId: "default",
  customFilenameEnabled: false,
  customFilename: "",
  lastIndexByKey: {},
};

export async function loadSessionState(): Promise<SessionState> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY] as SessionState | undefined;
  return stored ? { ...DEFAULT_SESSION_STATE, ...stored } : { ...DEFAULT_SESSION_STATE };
}

export async function saveSessionState(state: SessionState): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
}

/** §F-2 AI Session OFF is a hard safety boundary: cheapest possible check, first. */
export function isSessionActive(state: SessionState): boolean {
  return state.aiSessionEnabled === true;
}
