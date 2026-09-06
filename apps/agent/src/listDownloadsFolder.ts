// §Rescan — lists the files sitting directly in the OS Downloads folder, for
// the Extension's "Rescan Downloads" picker. Deliberately a raw directory
// listing, not filtered by extension/media type here: that logical filtering
// (which extensions count as image/video) already lives client-side in the
// Extension (apps/extension/src/adapters/registry.ts) and has no reason to be
// duplicated on the Agent — this module's only job is "what files are really
// there right now."
//
// Reuses the exact same default Downloads root as routeFile.ts's source-side
// boundary check (assertWithinDownloads), so "what Rescan can find" and "what
// Organize will accept as a source" never drift apart.

import { readdir, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { DownloadsFolderEntry } from "@download-organizer/shared";
import { defaultDownloadsRoot } from "./routeFile.js";

type ReaddirFn = (dir: string, opts: { withFileTypes: true }) => Promise<Dirent[]>;
type StatFn = (p: string) => Promise<{ birthtimeMs: number; mtimeMs: number }>;

export async function listDownloadsFolder(
  folder: string = defaultDownloadsRoot(),
  // Injectable only for tests, so they don't depend on the real machine's
  // ~/Downloads contents.
  readdirFn: ReaddirFn = readdir,
  statFn: StatFn = stat,
): Promise<DownloadsFolderEntry[]> {
  const dirents = await readdirFn(folder, { withFileTypes: true });
  const entries: DownloadsFolderEntry[] = [];

  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;

    const filePath = path.join(folder, dirent.name);
    const stats = await statFn(filePath);
    // Creation time is the more meaningful "when was this downloaded" signal;
    // birthtimeMs can read as 0 on filesystems that don't track it, in which
    // case mtimeMs is the honest fallback.
    const modifiedAt = stats.birthtimeMs > 0 ? stats.birthtimeMs : stats.mtimeMs;

    entries.push({
      path: filePath,
      filename: dirent.name,
      extension: path.extname(dirent.name).toLowerCase(),
      modifiedAt,
    });
  }

  return entries;
}
