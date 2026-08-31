import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileLogger } from "../src/logger.js";

describe("FileLogger", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("creates the log file and its parent directory on first write", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aias-log-"));
    const logPath = path.join(dir, "nested", "agent.log");
    const logger = new FileLogger(logPath);

    await logger.log("hello");

    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("hello");
  });

  it("appends subsequent lines rather than overwriting", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aias-log-"));
    const logger = new FileLogger(path.join(dir, "agent.log"));

    await logger.log("first");
    await logger.log("second");

    const content = await readFile(path.join(dir, "agent.log"), "utf-8");
    expect(content.split("\n").filter(Boolean)).toHaveLength(2);
    expect(content).toContain("first");
    expect(content).toContain("second");
  });

  it("never throws even if the path is unwritable", async () => {
    const logger = new FileLogger("/this/path/does/not/exist/and/cannot/be/created/agent.log");
    await expect(logger.log("x")).resolves.toBeUndefined();
  });
});
