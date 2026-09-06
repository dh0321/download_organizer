import { describe, it, expect, vi } from "vitest";
import { pickDirectory, pickDirectoryMac, pickDirectoryWindows } from "../src/directoryPicker.js";

describe("pickDirectoryMac", () => {
  it("returns the trimmed POSIX path from osascript's stdout", async () => {
    const execFileFn = vi.fn().mockResolvedValue({ stdout: "/Users/dahye/AI_Projects\n", stderr: "" });
    const path = await pickDirectoryMac(execFileFn);
    expect(path).toBe("/Users/dahye/AI_Projects");
    expect(execFileFn).toHaveBeenCalledWith("osascript", ["-e", "POSIX path of (choose folder)"]);
  });

  it("returns null when the user cancels the dialog (AppleScript -128 error)", async () => {
    const execFileFn = vi.fn().mockRejectedValue(new Error("Command failed: osascript -e ... User canceled. (-128)"));
    const path = await pickDirectoryMac(execFileFn);
    expect(path).toBeNull();
  });

  it("re-throws a genuine failure that isn't a cancellation", async () => {
    const execFileFn = vi.fn().mockRejectedValue(new Error("osascript: command not found"));
    await expect(pickDirectoryMac(execFileFn)).rejects.toThrow(/command not found/);
  });
});

describe("pickDirectoryWindows", () => {
  it("returns the trimmed path from PowerShell's stdout", async () => {
    const execFileFn = vi.fn().mockResolvedValue({ stdout: "D:\\AI_Projects\r\n", stderr: "" });
    const path = await pickDirectoryWindows(execFileFn);
    expect(path).toBe("D:\\AI_Projects");
    expect(execFileFn).toHaveBeenCalledWith("powershell", expect.arrayContaining(["-NoProfile", "-NonInteractive"]));
  });

  it("returns null when stdout is empty (user cancelled — Shell.Application's BrowseForFolder returns nothing)", async () => {
    const execFileFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    const path = await pickDirectoryWindows(execFileFn);
    expect(path).toBeNull();
  });

  it("runs the script via -File against a real temp .ps1, not inline -Command — sidesteps command-line quoting issues confirmed live (see directoryPicker.ts's comment)", async () => {
    const { readFile, access } = await import("node:fs/promises");
    let scriptPathSeen = "";
    const execFileFn = vi.fn(async (_file: string, args: string[]) => {
      const fileIdx = args.indexOf("-File");
      scriptPathSeen = args[fileIdx + 1];
      // The script must actually be readable on disk at the moment
      // PowerShell would run it — proves this isn't just a plausible-looking
      // path string.
      const contents = await readFile(scriptPathSeen, "utf-8");
      expect(contents).toContain("Shell.Application");
      return { stdout: "C:\\Projects\r\n", stderr: "" };
    });

    const path = await pickDirectoryWindows(execFileFn);

    expect(path).toBe("C:\\Projects");
    expect(execFileFn).toHaveBeenCalledWith(
      "powershell",
      expect.arrayContaining(["-Sta", "-ExecutionPolicy", "Bypass", "-File", scriptPathSeen]),
    );
    // Cleaned up afterward — no leftover temp files.
    await expect(access(scriptPathSeen)).rejects.toThrow();
  });
});

describe("pickDirectory (platform dispatch)", () => {
  it("delegates to the macOS picker on darwin", async () => {
    const execFileFn = vi.fn().mockResolvedValue({ stdout: "/tmp/x\n", stderr: "" });
    const path = await pickDirectory("darwin", execFileFn);
    expect(path).toBe("/tmp/x");
    expect(execFileFn).toHaveBeenCalledWith("osascript", expect.anything());
  });

  it("delegates to the Windows picker on win32", async () => {
    const execFileFn = vi.fn().mockResolvedValue({ stdout: "C:\\x\n", stderr: "" });
    const path = await pickDirectory("win32", execFileFn);
    expect(path).toBe("C:\\x");
    expect(execFileFn).toHaveBeenCalledWith("powershell", expect.anything());
  });

  it("throws a clear error on an unsupported platform", async () => {
    await expect(pickDirectory("linux", vi.fn())).rejects.toThrow(/not supported/);
  });
});
