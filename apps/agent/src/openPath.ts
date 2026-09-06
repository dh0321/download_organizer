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

export async function openPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
  execFileFn: ExecFileFn = defaultExecFile,
  spawnFn: SpawnFn = defaultSpawn,
): Promise<void> {
  if (platform === "darwin") {
    await execFileFn("open", [path]);
    return;
  }
  if (platform === "win32") {
    // Best-effort: strips the Zone.Identifier "Mark of the Web" stream that
    // Windows tags every downloaded file with, which otherwise triggers an
    // "Is this file from a trusted source?" prompt on every single open —
    // confirmed live, even for plain images with no real security
    // relevance (Chrome's own Safe Browsing check already ran at download
    // time; this is a separate, purely cosmetic Explorer-level warning).
    // $args[0] (rather than interpolating path into the script text) avoids
    // reintroducing quoting fragility already worked around elsewhere (see
    // directoryPicker.ts) — PowerShell binds any arguments after
    // -Command's script text to $args automatically. If this fails for any
    // reason (e.g. a non-NTFS volume with no ADS support), still go on and
    // open the file anyway — this is a convenience, not a precondition.
    await execFileFn("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Unblock-File -LiteralPath $args[0]",
      path,
    ]).catch(() => {});

    // Deliberately fire-and-forget via spawn, NOT awaited through execFile
    // like everything else in this file: `cmd /c start` launches the file's
    // default app as a child that, by default, inherits this call's stdio
    // handles. If that app stays open (an image viewer left open for the
    // user to look at, say), Node never sees EOF on those pipes and
    // execFile's promise hangs until the viewer is closed — confirmed live:
    // the file opened instantly, but the Agent never got to send its
    // response, leaving the Inbox button stuck on "Opening…" until the
    // request timed out. spawn with stdio:"ignore" + detached + unref
    // shares no handle with whatever gets launched, so this returns as soon
    // as `start` itself does, regardless of what happens afterward.
    spawnFn("cmd", ["/c", "start", "", path]);
    return;
  }
  throw new Error(`Opening a file is not supported on this platform: ${platform}`);
}
