import { describe, it, expect, vi } from "vitest";
import { openPath } from "../src/openPath.js";

describe("openPath", () => {
  it("shells out to macOS's `open` with the raw path", async () => {
    const execFileFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await openPath("/Users/dahye/AI_Projects/hero.png", "darwin", execFileFn);
    expect(execFileFn).toHaveBeenCalledWith("open", ["/Users/dahye/AI_Projects/hero.png"]);
  });

  it("shells out to `cmd /c start` with an empty title arg on Windows", async () => {
    const execFileFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await openPath("D:\\AI Projects\\hero.png", "win32", execFileFn);
    expect(execFileFn).toHaveBeenCalledWith("cmd", ["/c", "start", "", "D:\\AI Projects\\hero.png"]);
  });

  it("throws a clear error on an unsupported platform", async () => {
    await expect(openPath("/tmp/x", "linux", vi.fn())).rejects.toThrow(/not supported/);
  });

  it("propagates a failure from the underlying command", async () => {
    const execFileFn = vi.fn().mockRejectedValue(new Error("ENOENT: no such file"));
    await expect(openPath("/missing", "darwin", execFileFn)).rejects.toThrow(/ENOENT/);
  });
});
