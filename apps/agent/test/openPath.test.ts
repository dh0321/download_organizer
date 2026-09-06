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
    it("unblocks the file (Zone.Identifier) before launching it, passing the path via $args rather than interpolation", async () => {
      const execFileFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
      const spawnFn = vi.fn();
      await openPath("D:\\AI Projects\\hero.png", "win32", execFileFn, spawnFn);
      expect(execFileFn).toHaveBeenCalledWith(
        "powershell",
        expect.arrayContaining(["-Command", "Unblock-File -LiteralPath $args[0]", "D:\\AI Projects\\hero.png"]),
      );
    });

    it("launches the file via a fire-and-forget spawn, not execFile, with an empty title arg for `start`", async () => {
      const execFileFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
      const spawnFn = vi.fn();
      await openPath("D:\\AI Projects\\hero.png", "win32", execFileFn, spawnFn);
      expect(spawnFn).toHaveBeenCalledWith("cmd", ["/c", "start", "", "D:\\AI Projects\\hero.png"]);
      // Only the Unblock-File step goes through execFile — the actual launch
      // must not, since waiting on it is what caused the Inbox button to
      // hang on "Opening…" indefinitely against a viewer app left open.
      expect(execFileFn).toHaveBeenCalledTimes(1);
    });

    it("still opens the file even when Unblock-File fails (e.g. non-NTFS volume)", async () => {
      const execFileFn = vi.fn().mockRejectedValue(new Error("Unblock-File : Cannot find drive"));
      const spawnFn = vi.fn();
      await openPath("D:\\hero.png", "win32", execFileFn, spawnFn);
      expect(spawnFn).toHaveBeenCalledWith("cmd", ["/c", "start", "", "D:\\hero.png"]);
    });

    it("resolves without waiting for spawnFn to report anything (fire-and-forget)", async () => {
      const execFileFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
      let spawnCalled = false;
      const spawnFn = vi.fn(() => {
        spawnCalled = true;
        // Never resolves/rejects anything — spawnFn's return type is void,
        // simulating a detached, unref'd child that outlives this call.
      });
      await openPath("D:\\hero.png", "win32", execFileFn, spawnFn);
      expect(spawnCalled).toBe(true);
    });
  });
});
