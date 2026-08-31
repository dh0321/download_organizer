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
      // §H identifier fallback chain — applies wherever {shot} appears in the
      // template (not tied to its position), since it's the one token whose
      // whole point is "the thing this asset is identified by":
      // shot -> sequence -> project -> "asset".
      const identifier = tokens.shot || tokens.sequence || tokens.project || "asset";
      v = sanitizeSegment(identifier);
    } else if (slot === "description") {
      const d = tokens.description.trim();
      v = d ? sanitizeSegment(d) : "";
    } else if (slot === "index") {
      v = String(tokens.index).padStart(3, "0");
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
