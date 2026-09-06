// Opens a file with its OS-default associated application, invoked by the
// Agent (a real local process) on behalf of the popup/Inbox's "Open file"
// button. chrome.downloads.open() only works for files Chrome itself has a
// live history entry for — which by design excludes anything imported via
// Rescan's folder scan (see rescanDownloads.ts) and silently stops working
// for any file whose history entry was cleared. The Agent has real
// filesystem access already (see directoryPicker.ts), so it can just launch
// the file directly by its absolute path instead, with no dependency on
// Chrome's own bookkeeping.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { unlink } from "node:fs/promises";
import type { ExecFileFn } from "./directoryPicker.js";

async function defaultExecFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(file, args);
}

export type SpawnFn = (command: string, args: string[]) => void;

function defaultSpawn(command: string, args: string[]): void {
  // detached + stdio:"ignore", then unref: this Agent process must not wait
  // on, or share any stdio handle with, whatever ends up actually opening
  // the file — see the win32 branch below for why that matters here.
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export type UnlinkFn = (path: string) => Promise<void>;

export async function openPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  execFileFn: ExecFileFn = defaultExecFile,
  spawnFn: SpawnFn = defaultSpawn,
  unlinkFn: UnlinkFn = unlink,
): Promise<void> {
  if (platform === "darwin") {
    await execFileFn("open", [path]);
    return;
  }
  if (platform === "win32") {
    // Best-effort: deletes the Zone.Identifier NTFS alternate data stream
    // Windows tags every downloaded file with (its "Mark of the Web"),
    // which otherwise triggers an "Is this file from a trusted source?"
    // prompt on every single open — confirmed live, even for plain images
    // with no real security relevance (Chrome's own Safe Browsing check
    // already ran at download time). "<path>:Zone.Identifier" is real (if
    // unusual) NTFS syntax for addressing that specific stream directly —
    // Windows' file APIs, and therefore Node's fs, accept it — so this is
    // both correct and fast: no external process.
    //
    // A previous attempt instead shelled out to PowerShell's Unblock-File,
    // which was wrong on two counts, confirmed live: (1) its ~2-3s cold
    // start made every open feel stuck even once it worked, and (2) it
    // never actually worked — the path was passed as a trailing argument to
    // -Command, which PowerShell folds into the same command TEXT rather
    // than binding to $args the way a real script file's parameters would,
    // so $args[0] silently evaluated to nothing and Unblock-File's failure
    // was masked by the .catch(() => {}) around it. The warning kept
    // appearing on every open despite that "fix" having shipped.
    //
    // If deleting the stream fails for any reason (already unblocked, a
    // non-NTFS volume, no stream present), just go on and open the file —
    // this is a convenience, never a precondition for opening.
    await unlinkFn(`${path}:Zone.Identifier`).catch(() => {});

    // Deliberately fire-and-forget via spawn, NOT awaited through execFile
    // like `open` above: `cmd /c start` launches the file's default app as
    // a child that, by default, inherits this call's stdio handles. If that
    // app stays open (an image viewer left open for the user to look at,
    // say), Node never sees EOF on those pipes and execFile's promise hangs
    // until the viewer is closed — confirmed live: the file opened
    // instantly, but the Agent never got to send its response, leaving the
    // Inbox button stuck on "Opening…" until the request timed out. spawn
    // with stdio:"ignore" + detached + unref shares no handle with whatever
    // gets launched, so this returns as soon as `start` itself does,
    // regardless of what happens afterward.
    spawnFn("cmd", ["/c", "start", "", path]);
    return;
  }
  throw new Error(`Opening a file is not supported on this platform: ${platform}`);
}
