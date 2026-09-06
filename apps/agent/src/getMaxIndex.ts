// §F-1 Index Reservation — Agent side of the "get-max-index" reconciliation query.
// Derives its own scan pattern from the logical naming fields rather than trusting
// any caller-supplied regex (§F-2) — a compromised/buggy Extension can only ask
// "what's the max index under this folder", never hand the Agent an arbitrary regex.

import { readdir } from "node:fs/promises";
import type { AgentConfig } from "@download-organizer/shared";
import { resolveExistingDestinationOrNull, type FolderNamingFields } from "./fileRouter.js";

/**
 * Matches the default Phase 1 naming preset's shape: whatever prefix, then an
 * underscore-separated 3+ digit index, then a dot-extension. This is a heuristic
 * tied to the MVP's single built-in preset (§O Phase 1 scope) — a Phase 2 with
 * arbitrary custom naming templates will need a smarter, preset-aware scan.
 */
const INDEX_SUFFIX_PATTERN = /_(\d{3,})\.[A-Za-z0-9]+$/;

export async function getMaxIndex(agentConfig: AgentConfig, naming: FolderNamingFields): Promise<number> {
  const folder = await resolveExistingDestinationOrNull(agentConfig, naming);
  if (!folder) return 0; // folder never used before -> nothing to reconcile against

  let entries: string[];
  try {
    entries = await readdir(folder);
  } catch {
    return 0;
  }

  let max = 0;
  for (const name of entries) {
    const m = INDEX_SUFFIX_PATTERN.exec(name);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n) && n > max) max = n;
    }
  }
  return max;
}
