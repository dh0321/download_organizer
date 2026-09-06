// Native OS folder-picker dialog, invoked by the Agent (a real local process)
// on behalf of the popup — Chrome never exposes absolute filesystem paths to
// web/extension content, so there is no way to do this from the browser side.
// macOS uses AppleScript's "choose folder"; Windows uses PowerShell's
// Shell.Application COM object (see pickDirectoryWindows for why it's a
// script file on disk, not an inline -Command string). Both are already
// present on their respective OS — no extra dependency needed.
//
// All Node built-ins below are STATIC imports, not dynamic import() — the
// packaged (pkg) Windows .exe has no dynamic-import host callback wired up,
// so any await import(...) throws "A dynamic import callback was not
// specified" the instant it runs, before the platform-specific script logic
// below even gets a chance to execute. That's what was actually causing the
// "Edit" folder picker to fail live on Windows — three separate rewrites of
// the PowerShell invocation (WinForms, Shell.Application, -Sta, temp .ps1
// file) all hit this same wall since none of them touched the dynamic
// imports that ran before any of that code. Confirmed unrelated to
// PowerShell/Shell entirely: the vitest suite here never runs through pkg,
// so it never caught this.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type ExecFileFn = (file: string, args: string[]) => Promise<ExecFileResult>;

async function defaultExecFile(file: string, args: string[]): Promise<ExecFileResult> {
  return promisify(execFile)(file, args);
}

const MAC_CANCEL_MARKERS = ["-128", "User canceled"];

export async function pickDirectoryMac(execFileFn: ExecFileFn = defaultExecFile): Promise<string | null> {
  try {
    const { stdout } = await execFileFn("osascript", ["-e", "POSIX path of (choose folder)"]);
    const path = stdout.trim();
    return path.length > 0 ? path : null;
  } catch (e) {
    const text = `${(e as Error).message ?? ""} ${(e as { stderr?: string }).stderr ?? ""}`;
    if (MAC_CANCEL_MARKERS.some((marker) => text.includes(marker))) return null;
    throw e;
  }
}

// Shell.Application's BrowseForFolder is a much older, simpler COM object
// than System.Windows.Forms.FolderBrowserDialog (present on every Windows
// version since 2000, no Add-Type/assembly loading needed). Earlier
// debugging blamed command-line quoting for the "A dynamic import callback
// was not specified" error seen live and switched this to a temp .ps1 file
// run via -File for that reason — that theory turned out to be wrong (the
// error was Node's own dynamic import() failing inside the pkg-packaged
// .exe, well before this script ever ran; see the file-level comment above).
// The -File approach and -Sta are kept anyway since they're harmless and
// slightly more robust than an inline -Command string.
const WINDOWS_FOLDER_PICKER_SCRIPT = `
$shell = New-Object -ComObject Shell.Application
$folder = $shell.BrowseForFolder(0, 'Select a folder', 0, 0)
if ($folder) {
  Write-Output $folder.Self.Path
}
`;

export async function pickDirectoryWindows(execFileFn: ExecFileFn = defaultExecFile): Promise<string | null> {
  const scriptPath = path.join(tmpdir(), `aias-folder-picker-${randomBytes(8).toString("hex")}.ps1`);
  await writeFile(scriptPath, WINDOWS_FOLDER_PICKER_SCRIPT, "utf-8");
  try {
    const { stdout } = await execFileFn("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Sta",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ]);
    const selected = stdout.trim();
    return selected.length > 0 ? selected : null;
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}

export async function pickDirectory(
  platform: NodeJS.Platform = process.platform,
  execFileFn: ExecFileFn = defaultExecFile,
): Promise<string | null> {
  if (platform === "darwin") return pickDirectoryMac(execFileFn);
  if (platform === "win32") return pickDirectoryWindows(execFileFn);
  throw new Error(`Native directory picker is not supported on this platform: ${platform}`);
}
