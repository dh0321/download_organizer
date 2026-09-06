// Native OS folder-picker dialog, invoked by the Agent (a real local process)
// on behalf of the popup — Chrome never exposes absolute filesystem paths to
// web/extension content, so there is no way to do this from the browser side.
// macOS uses AppleScript's "choose folder"; Windows uses PowerShell's
// Shell.Application COM object (see pickDirectoryWindows for why it's a
// script file on disk, not an inline -Command string). Both are already
// present on their respective OS — no extra dependency needed.

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type ExecFileFn = (file: string, args: string[]) => Promise<ExecFileResult>;

async function defaultExecFile(file: string, args: string[]): Promise<ExecFileResult> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
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
// version since 2000, no Add-Type/assembly loading needed) — switched to
// this after FolderBrowserDialog failed live with "A dynamic callback was
// not specified". That exact error persisted even after the switch (and
// after adding -Sta, and confirmed unrelated to the script's own logic:
// the identical command line runs fine when typed into cmd.exe directly).
// That combination — same error survives 3 different script rewrites, but
// disappears when the exact same command is run outside Node — points at
// the *argument-passing* path itself, not anything in the script: Node's
// execFile reconstructs a single Windows command-line string from the argv
// array, and a multi-line script embedded in a -Command argument is a
// known-fragile case for that reconstruction (quoting/newlines can come out
// subtly mangled). Writing the script to a real .ps1 file and running that
// via -File sidesteps command-line quoting entirely — the script is read
// from disk, not reassembled through argv.
const WINDOWS_FOLDER_PICKER_SCRIPT = `
$shell = New-Object -ComObject Shell.Application
$folder = $shell.BrowseForFolder(0, 'Select a folder', 0, 0)
if ($folder) {
  Write-Output $folder.Self.Path
}
`;

export async function pickDirectoryWindows(execFileFn: ExecFileFn = defaultExecFile): Promise<string | null> {
  const { writeFile, unlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { randomBytes } = await import("node:crypto");

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
