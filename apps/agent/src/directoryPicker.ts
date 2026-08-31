// Native OS folder-picker dialog, invoked by the Agent (a real local process)
// on behalf of the popup — Chrome never exposes absolute filesystem paths to
// web/extension content, so there is no way to do this from the browser side.
// macOS uses AppleScript's "choose folder"; Windows uses a PowerShell
// System.Windows.Forms.FolderBrowserDialog. Both are already present on their
// respective OS — no extra dependency needed.

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

const WINDOWS_FOLDER_PICKER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.SelectedPath
}
`;

export async function pickDirectoryWindows(execFileFn: ExecFileFn = defaultExecFile): Promise<string | null> {
  const { stdout } = await execFileFn("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_FOLDER_PICKER_SCRIPT]);
  const path = stdout.trim();
  return path.length > 0 ? path : null;
}

export async function pickDirectory(
  platform: NodeJS.Platform = process.platform,
  execFileFn: ExecFileFn = defaultExecFile,
): Promise<string | null> {
  if (platform === "darwin") return pickDirectoryMac(execFileFn);
  if (platform === "win32") return pickDirectoryWindows(execFileFn);
  throw new Error(`Native directory picker is not supported on this platform: ${platform}`);
}
