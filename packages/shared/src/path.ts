// Destination folder segment assembly. See PLAN.md §G (File Routing Algorithm) and
// §F-2 (Root Sandbox Policy). This module is intentionally fs-free and Root-free:
// it only builds a segment array. Joining against the Agent's own configured
// defaultRoot, normalizing, and verifying containment happens only in the Agent
// (apps/agent/src/file-router), never here and never in the Extension.

import type { FolderLevel } from "./types.js";
import { sanitizeSegment } from "./sanitize.js";

export class MissingRequiredFieldError extends Error {
  constructor(public readonly fieldKey: string) {
    super(`Missing required field: ${fieldKey}`);
    this.name = "MissingRequiredFieldError";
  }
}

export interface NamingLike {
  // Callers may pass a richer object (e.g. NamingFields, which also carries
  // boolean flags like customDirectoryEnabled) — only string-keyed level
  // values are ever read here, so the index signature just needs to not
  // reject those extra non-string properties structurally.
  [key: string]: string | boolean | undefined;
}

/**
 * Builds the list of folder segments (Project/Sequence/Shot/... + bucket), dropping
 * empty optional levels entirely rather than inserting a blank segment — this is
 * what guarantees `Galaxy_S27\SH020\Generated` (Sequence omitted) instead of a path
 * with a hole in it.
 */
export function resolveDestinationFolderSegments(
  levels: FolderLevel[],
  naming: NamingLike,
  bucketOrCustomFolderName: string,
): string[] {
  const segments: string[] = [];

  for (const level of levels) {
    const raw = naming[level.key];
    const value = typeof raw === "string" ? raw.trim() : undefined;
    if (value) {
      segments.push(sanitizeSegment(value));
    } else if (level.required) {
      throw new MissingRequiredFieldError(level.key);
    }
    // optional + empty -> silently dropped, never inserts a blank segment
  }

  segments.push(sanitizeSegment(bucketOrCustomFolderName));
  return segments;
}

/**
 * Given a desired base filename (without extension) and the original extension,
 * returns the candidate to try for a given collision attempt number:
 *   attempt 0 -> "hero.mov"
 *   attempt 1 -> "hero_002.mov"
 *   attempt 2 -> "hero_003.mov"
 * This is the *physical disk collision* safety net (§H, §F-2) — distinct from and
 * unrelated to the semantic {index} token, which is assigned once at detection time
 * and never recomputed.
 */
export function conflictCandidateFilename(baseName: string, extension: string, attempt: number): string {
  if (attempt <= 0) return `${baseName}${extension}`;
  const suffix = String(attempt + 1).padStart(3, "0");
  return `${baseName}_${suffix}${extension}`;
}

export const MAX_CONFLICT_ATTEMPTS = 999;

/**
 * Splits a user-typed "custom directory" string into sanitized path segments,
 * reusing sanitizeSegment for every piece — the same function that already
 * rejects "", ".", and ".." (§F-2). This is what lets Custom Directory need no
 * new security logic: an absolute-looking input like "C:\Windows\System32"
 * just has its ":" stripped and becomes the safe relative segments
 * ["C", "Windows", "System32"] under Root; "..\..\secret" throws
 * PathTraversalError from the ".." segment exactly like any other field does.
 */
export function splitCustomDirectorySegments(rawPath: string): string[] {
  return rawPath
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => sanitizeSegment(s));
}
