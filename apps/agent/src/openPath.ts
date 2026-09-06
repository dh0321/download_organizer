// Opens a file with its OS-default associated application, invoked by the
// Agent (a real local process) on behalf of the popup/Inbox's "Open file"
// button. chrome.downloads.open() only works for files Chrome itself has a
// live history entry for — which by design excludes anything imported via
// Rescan's folder scan (see rescanDownloads.ts) and silently stops working
// for any file whose history entry was cleared. The Agent has real
// filesystem access already (see directoryPicker.ts), so it can just launch
// the file directly by its absolute path instead, with no dependency on
// Chrome's own bookkeeping.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExecFileFn } from "./directoryPicker.js";

async function defaultExecFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(file, args);
}

export async function openPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  execFileFn: ExecFileFn = defaultExecFile,
): Promise<void> {
  if (platform === "darwin") {
    await execFileFn("open", [path]);
    return;
  }
  if (platform === "win32") {
    // cmd's `start` treats its first argument as the new console window's
    // title, not the thing to open — the empty "" is required so a path
    // (quoted whenever it contains a space) isn't mistaken for the title.
    await execFileFn("cmd", ["/c", "start", "", path]);
    return;
  }
  throw new Error(`Opening a file is not supported on this platform: ${platform}`);
}
