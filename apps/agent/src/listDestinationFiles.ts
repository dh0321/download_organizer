// §F-1 Index Reservation — lists the files already present in an asset's
// resolved destination folder, so the caller (organizeFlow.ts) can pick the
// first unused {index} value for its own computed filename rather than
// trusting a client-side counter with no way to know the destination folder
// was ever touched outside this tool. Confirmed live: a previously-organized
// file that was later deleted manually left the old counter permanently
// offset from what the folder actually contained (an empty folder still
// producing "v002" on the next Organize).

import { readdir } from "node:fs/promises";
import type { AgentConfig } from "@download-organizer/shared";
import { resolveExistingDestinationOrNull, type FolderNamingFields } from "./fileRouter.js";

export async function listDestinationFiles(agentConfig: AgentConfig, naming: FolderNamingFields): Promise<string[]> {
  const folder = await resolveExistingDestinationOrNull(agentConfig, naming);
  if (!folder) return []; // folder never used before -> nothing can collide

  try {
    return await readdir(folder);
  } catch {
    return [];
  }
}
