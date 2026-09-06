// §H / §F-2 — moves a staged download into its final destination without ever
// silently overwriting an existing file, and without ever leaving a half-written
// file visible under its real name if the process dies mid-copy.
//
// Strategy (see PLAN.md §L "볼륨 간 이동" and §14 "Filename Conflict"):
//   1. copy sourcePath -> <destFolder>/.<random>.aias-tmp   (works cross-volume)
//   2. verify size matches the source
//   3. fs.link(tempPath, candidatePath)  — atomic, EEXIST if candidatePath exists
//      (hard link is same-volume only, which holds here: temp is already on the
//      destination volume) — this is the actual conflict/overwrite safety net,
//      immune to the exists-check-then-write race that a naive approach would have.
//   4. unlink the temp name (the data survives via the link at candidatePath)
//   5. only now unlink the original staged source file

import { copyFile, link, unlink, stat, mkdtemp } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { conflictCandidateFilename, MAX_CONFLICT_ATTEMPTS, type NativeErrorCode } from "@download-organizer/shared";
import { RoutingError } from "./fileRouter.js";

export class TimeoutError extends Error {}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface MoveOptions {
  /** Timeout for each individual filesystem operation, guards against a hung NAS (§L). */
  ioTimeoutMs?: number;
  /** Injectable only for tests — lets a test simulate unlink() failing (e.g. a
   * file locked open by another program on Windows) without depending on
   * OS-specific file-locking behavior that doesn't reproduce on macOS/Linux. */
  unlinkFn?: (path: string) => Promise<void>;
}

/**
 * Moves `sourcePath` into `destFolder` under `baseName + extension`, resolving
 * filename conflicts by incrementing a numeric suffix. Returns the final absolute
 * path. Throws RoutingError("CONFLICT_LIMIT_EXCEEDED" | "IO_ERROR", ...) on failure.
 * `destFolder` is assumed to already have been validated by resolveSafeDestination.
 */
export async function moveIntoDestination(
  sourcePath: string,
  destFolder: string,
  baseName: string,
  extension: string,
  options: MoveOptions = {},
): Promise<string> {
  // 2 minutes per fs operation — the copy step in particular needs real
  // headroom for large video files landing on a slow/external/networked
  // destination; 30s was sized for small images and timed out too easily
  // once video became a meaningful share of traffic. Still a real safety net
  // against a genuinely hung NAS, just not a hair-trigger one.
  const ioTimeoutMs = options.ioTimeoutMs ?? 120_000;
  const unlinkFn = options.unlinkFn ?? unlink;

  let sourceStat;
  try {
    sourceStat = await withTimeout(stat(sourcePath), ioTimeoutMs, "Timed out stat'ing source file");
  } catch (e) {
    throw new RoutingError("SOURCE_PATH_INVALID", `Cannot stat source file: ${(e as Error).message}`);
  }

  const tempName = `.${randomBytes(8).toString("hex")}.aias-tmp`;
  const tempPath = path.join(destFolder, tempName);

  try {
    await withTimeout(copyFile(sourcePath, tempPath), ioTimeoutMs, "Timed out copying to destination volume");

    const tempStat = await withTimeout(stat(tempPath), ioTimeoutMs, "Timed out verifying copy");
    if (tempStat.size !== sourceStat.size) {
      throw new RoutingError("IO_ERROR", `Copy size mismatch: expected ${sourceStat.size}, got ${tempStat.size}`);
    }

    let finalPath: string | undefined;
    for (let attempt = 0; attempt <= MAX_CONFLICT_ATTEMPTS; attempt++) {
      const candidateName = conflictCandidateFilename(baseName, extension, attempt);
      const candidatePath = path.join(destFolder, candidateName);
      try {
        await withTimeout(link(tempPath, candidatePath), ioTimeoutMs, "Timed out finalizing destination file");
        finalPath = candidatePath;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
    }

    if (!finalPath) {
      throw new RoutingError(
        "CONFLICT_LIMIT_EXCEEDED",
        `Exhausted ${MAX_CONFLICT_ATTEMPTS} conflict-resolution attempts for "${baseName}${extension}"`,
      );
    }

    await unlinkFn(tempPath);
    // The file is now safely and durably at `finalPath` (verified-size copy,
    // hard-linked in place) — this is the point of no return. Deleting the
    // original in Downloads is cleanup, not part of the safety guarantee, so
    // its failure (e.g. another program has the file open — common on
    // Windows, where that can deny delete) must never turn an already-
    // successful move into a reported failure. Worst case: a redundant copy
    // is left behind in Downloads for the user to remove by hand — never a
    // duplicate at the destination, since re-Organizing an "Organized" asset
    // isn't possible from the Inbox.
    await unlinkFn(sourcePath).catch(() => {});
    return finalPath;
  } catch (e) {
    // Best-effort cleanup of the temp file; never touch sourcePath on failure —
    // the staged download must survive so the user never loses the file (§M).
    await unlinkFn(tempPath).catch(() => {});
    if (e instanceof RoutingError) throw e;
    const code: NativeErrorCode = e instanceof TimeoutError ? "IO_ERROR" : "IO_ERROR";
    throw new RoutingError(code, `File move failed: ${(e as Error).message}`);
  }
}

/** Test helper: creates a fresh temp directory (used by fileMover/fileRouter tests). */
export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}
