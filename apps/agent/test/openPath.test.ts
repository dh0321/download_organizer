import { describe, it, expect, vi } from "vitest";
import { openPath } from "../src/openPath.js";

describe("openPath", () => {
  it("shells out to macOS's `open` with the raw path", async () => {
    const execFileFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await openPath("/Users/dahye/AI_Projects/hero.png", "darwin", execFileFn);
    expect(execFileFn).toHaveBeenCalledWith("open", ["/Users/dahye/AI_Projects/hero.png"]);
  });

  it("throws a clear error on an unsupported platform", async () => {
    await expect(openPath("/tmp/x", "linux", vi.fn())).rejects.toThrow(/not supported/);
  });

  it("propagates a failure from the underlying command on macOS", async () => {
    const execFileFn = vi.fn().mockRejectedValue(new Error("ENOENT: no such file"));
    await expect(openPath("/missing", "darwin", execFileFn)).rejects.toThrow(/ENOENT/);
  });

  describe("on win32", () => {
    it("deletes the Zone.Identifier ADS directly via fs, not PowerShell", async () => {
      const execFileFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
      const spawnFn = vi.fn();
      const unlinkFn = vi.fn().mockResolvedValue(undefined);
      await openPath("D:\\AI Projects\\hero.png", "win32", execFileFn, spawnFn, unlinkFn);
      expect(unlinkFn).toHaveBeenCalledWith("D:\\AI Projects\\hero.png:Zone.Identifier");
      // No PowerShell process at all for this step anymore — that's what
      // made every open feel stuck (cold-start latency) and, on top of
      // that, never actually worked (see the file-level comment).
      expect(execFileFn).not.toHaveBeenCalled();
    });

    it("launches the file via a fire-and-forget spawn, not execFile, with an empty title arg for `start`", async () => {
      const spawnFn = vi.fn();
      const unlinkFn = vi.fn().mockResolvedValue(undefined);
      await openPath("D:\\AI Projects\\hero.png", "win32", undefined, spawnFn, unlinkFn);
      expect(spawnFn).toHaveBeenCalledWith("cmd", ["/c", "start", "", "D:\\AI Projects\\hero.png"]);
    });

    it("still opens the file even when deleting the ADS fails (already unblocked, non-NTFS volume, etc.)", async () => {
      const spawnFn = vi.fn();
      const unlinkFn = vi.fn().mockRejectedValue(new Error("ENOENT"));
      await openPath("D:\\hero.png", "win32", undefined, spawnFn, unlinkFn);
      expect(spawnFn).toHaveBeenCalledWith("cmd", ["/c", "start", "", "D:\\hero.png"]);
    });

    it("resolves without waiting for spawnFn to report anything (fire-and-forget)", async () => {
      const unlinkFn = vi.fn().mockResolvedValue(undefined);
      let spawnCalled = false;
      const spawnFn = vi.fn(() => {
        spawnCalled = true;
        // Never resolves/rejects anything — spawnFn's return type is void,
        // simulating a detached, unref'd child that outlives this call.
      });
      await openPath("D:\\hero.png", "win32", undefined, spawnFn, unlinkFn);
      expect(spawnCalled).toBe(true);
    });
  });
});
