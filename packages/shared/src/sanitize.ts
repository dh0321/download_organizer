// Windows-safe filename/folder-segment sanitizer. See PLAN.md §H (Naming Algorithm)
// and §F-2 (Root Sandbox Policy hardening rules).

const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;
const WHITESPACE_RUN = /\s+/g;
const SEPARATOR_RUN = /_+/g;
const TRAILING_DOT_OR_SPACE = /[.\s]+$/;

const RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

export class PathTraversalError extends Error {
  constructor(public readonly rawInput: string) {
    super(`Refusing to use "${rawInput}" as a path segment: resolves to empty/"."/".." after sanitization`);
    this.name = "PathTraversalError";
  }
}

/**
 * Truncates a string to at most maxLength UTF-16 code units without splitting a
 * surrogate pair in half.
 */
export function truncateToPathBudget(s: string, maxLength: number): string {
  if (s.length <= maxLength) return s;
  let cut = s.slice(0, maxLength);
  // avoid splitting a surrogate pair
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    cut = cut.slice(0, -1);
  }
  return cut;
}

/**
 * Sanitizes one path *segment* (a single folder name or a filename stem — never a
 * multi-segment path). Only call this with a non-empty, already-trimmed candidate;
 * the caller decides whether an empty optional field should be dropped entirely
 * (see resolveDestinationFolderSegments in path.ts) — this function never silently
 * drops a non-empty input, it either sanitizes it or throws.
 *
 * Throws PathTraversalError if, after sanitization, the result is "", ".", or ".."
 * — these are never valid substitutes for a legitimate segment and are treated as
 * a deliberate path-manipulation attempt (§F-2), not something to silently paper over.
 */
export function sanitizeSegment(raw: string, maxLength = 200): string {
  let s = raw.trim();
  s = s.replace(ILLEGAL_CHARS, "");
  s = s.replace(WHITESPACE_RUN, "_");
  s = s.replace(SEPARATOR_RUN, "_");
  s = s.replace(TRAILING_DOT_OR_SPACE, "");

  if (s === "" || s === "." || s === "..") {
    throw new PathTraversalError(raw);
  }

  if (RESERVED_NAMES.has(s.toUpperCase())) {
    s = `${s}_`;
  }

  return truncateToPathBudget(s, maxLength);
}
