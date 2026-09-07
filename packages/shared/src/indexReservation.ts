// §F-1 Index Reservation — key-building helpers for grouping Pending Assets by
// destination folder.
//
// There is deliberately no persisted/session-spanning counter here any more:
// one used to exist (see git history), reconciled forward-only against the
// Agent's on-disk scan, but confirmed live that this let a folder that had
// been organized into once — then had its file manually deleted — keep
// handing out numbers as if that file still existed (an empty folder showing
// "v002" on the next Organize). Index values are now resolved fresh per
// Organize click instead (see organizeFlow.ts): the Agent reports the
// destination's real current file listing, and the caller picks the first
// {index} value whose computed filename isn't already taken — no memory of
// any earlier session. These two functions just group assets sharing one
// destination folder so that lookup only happens once per folder, not once
// per asset.

/**
 * Deliberately keyed on the same fields that make up the actual destination
 * folder (project/sequence/bucket) — NOT shot, which is a filename identifier
 * rather than a folder level (see DEFAULT_FOLDER_TEMPLATE). This only groups
 * which assets share one destination folder (so its file listing is fetched
 * once, not once per asset) — actual {index} collision-avoidance is now
 * per-computed-filename (see organizeFlow.ts), not per this key.
 */
export function buildIndexKey(parts: {
  project: string;
  sequence: string;
  bucketId?: string;
  customFolderName?: string;
  mediaType: string;
}): string {
  return [parts.project, parts.sequence, parts.bucketId ?? parts.customFolderName ?? "", parts.mediaType]
    .map((p) => p.trim().toLowerCase())
    .join("|");
}

/**
 * Index key for Custom Directory jobs (§F-1): the actual destination folder no
 * longer depends on project/sequence/shot/bucket once Custom Directory is on
 * (see fileRouter.ts's computeCandidatePath), so grouping must key off the
 * custom directory string itself instead.
 */
export function buildIndexKeyForCustomDirectory(customDirectory: string, mediaType: string): string {
  return `custom-dir:${customDirectory.trim().toLowerCase()}|${mediaType.trim().toLowerCase()}`;
}
