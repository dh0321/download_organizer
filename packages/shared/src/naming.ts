// Filename construction. See PLAN.md §H (Naming Algorithm).

import { sanitizeSegment } from "./sanitize.js";

export interface BuildFilenameTokens {
  project: string;
  sequence: string;
  shot: string;
  description: string;
  /** Media type label used for the "type" token, e.g. "IMG" / "VID". */
  type: string;
  /** job.reservedIndex — already assigned at detection time (§F-1). Never recomputed here. */
  index: number;
  version?: number;
  date?: string;
  /** The AI source (e.g. "chatgpt", "gemini", or a user-edited value) — see PendingAsset.source. */
  source?: string;
  customFilenameEnabled: boolean;
  customFilename: string;
}

function parseTemplate(template: string): string[] {
  const slots: string[] = [];
  const re = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    slots.push(m[1]);
  }
  return slots;
}

/**
 * Builds the final filename (without extension already appended by the caller — the
 * original media extension is always preserved, per §12 of the requirements).
 */
export function buildFilename(template: string, tokens: BuildFilenameTokens, extension: string): string {
  if (tokens.customFilenameEnabled) {
    return `${sanitizeSegment(tokens.customFilename)}${extension}`;
  }

  const slots = parseTemplate(template);
  const values: string[] = [];

  slots.forEach((slot) => {
    let v = "";
    if (slot === "shot") {
      // §H identifier — applies wherever {shot} appears in the template (not
      // tied to its position). Deliberately NO fallback to Project or
      // Sequence when empty: both are shared across many assets, so silently
      // borrowing either one made unrelated assets indistinguishable by
      // filename alone. An empty Shot/Asset Name always reads as "untitled",
      // a clear signal to go fill it in, rather than a name that looks
      // intentional but isn't unique.
      const identifier = tokens.shot || "untitled";
      v = sanitizeSegment(identifier);
    } else if (slot === "description") {
      const d = tokens.description.trim();
      v = d ? sanitizeSegment(d) : "";
    } else if (slot === "index") {
      // "v"-prefixed like a version number (v001, v002, ...) even though this
      // is still the same Index Reservation counter under the hood — it's a
      // display convention, not a distinct "version" concept (see the
      // separate {version} slot below, unused by the UI today).
      v = `v${String(tokens.index).padStart(3, "0")}`;
    } else if (slot === "version") {
      v = tokens.version != null ? `v${String(tokens.version).padStart(3, "0")}` : "";
    } else if (slot === "type") {
      v = sanitizeSegment(tokens.type);
    } else if (slot === "date") {
      v = tokens.date ? sanitizeSegment(tokens.date) : "";
    } else if (slot === "project") {
      v = tokens.project ? sanitizeSegment(tokens.project) : "";
    } else if (slot === "sequence") {
      v = tokens.sequence ? sanitizeSegment(tokens.sequence) : "";
    } else if (slot === "source") {
      v = tokens.source ? sanitizeSegment(tokens.source) : "";
    }

    if (v) values.push(v);
  });

  return `${values.join("_")}${extension}`;
}

// Astronomically higher than any real destination folder's file count — just
// a defensive backstop against a pathological/corrupted folder listing.
const MAX_INDEX_SEARCH_ATTEMPTS = 999;

/**
 * §F-1 Index Reservation: picks the first {index} value (starting at 1)
 * whose fully-computed filename doesn't already appear in `takenFilenames`,
 * and marks that filename as taken (mutates the set) so a second call in the
 * same pass — e.g. another asset in the same Organize batch — doesn't also
 * claim it. Returns 1 unused, without touching `takenFilenames`, when the
 * template has no {index} slot or the asset uses a Custom Filename
 * (buildFilename ignores the index token in both cases either way).
 *
 * Used both by the real Organize-time reservation (organizeFlow.ts, against
 * the destination's actual on-disk listing) and by the Inbox's live preview
 * (App.tsx, against a listing fetched on demand) — the same algorithm, just
 * fed a different (real vs. just-in-time) file listing.
 */
export function pickAvailableIndex(
  template: string,
  tokens: Omit<BuildFilenameTokens, "index" | "customFilenameEnabled" | "customFilename">,
  extension: string,
  takenFilenames: Set<string>,
): number {
  if (!template.includes("{index}")) return 1;

  for (let n = 1; n <= MAX_INDEX_SEARCH_ATTEMPTS; n++) {
    const candidate = buildFilename(template, { ...tokens, index: n, customFilenameEnabled: false, customFilename: "" }, extension);
    if (!takenFilenames.has(candidate)) {
      takenFilenames.add(candidate);
      return n;
    }
  }
  throw new Error(`Could not find a free {index} value after ${MAX_INDEX_SEARCH_ATTEMPTS} attempts`);
}
