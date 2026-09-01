import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { moveIntoDestination } from "../src/fileMover.js";
import { RoutingError } from "../src/fileRouter.js";

describe("moveIntoDestination", () => {
  let stagingDir: string;
  let destDir: string;

  beforeEach(async () => {
    stagingDir = await mkdtemp(path.join(tmpdir(), "aias-staging-"));
    destDir = await mkdtemp(path.join(tmpdir(), "aias-dest-"));
  });

  afterEach(async () => {
    await rm(stagingDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  });

  it("moves the file to the destination and removes the staged original", async () => {
    const src = path.join(stagingDir, "download.tmp");
    await writeFile(src, "hello world");

    const finalPath = await moveIntoDestination(src, destDir, "hero", ".mov");

    expect(finalPath).toBe(path.join(destDir, "hero.mov"));
    expect(await readFile(finalPath, "utf-8")).toBe("hello world");
    await expect(access(src)).rejects.toThrow(); // staged original removed only after success
  });

  it("never overwrites an existing file — appends a numeric suffix instead", async () => {
    await writeFile(path.join(destDir, "hero.mov"), "ORIGINAL CONTENT — must survive");

    const src = path.join(stagingDir, "download.tmp");
    await writeFile(src, "new content");

    const finalPath = await moveIntoDestination(src, destDir, "hero", ".mov");

    expect(finalPath).toBe(path.join(destDir, "hero_002.mov"));
    expect(await readFile(path.join(destDir, "hero.mov"), "utf-8")).toBe("ORIGINAL CONTENT — must survive");
    expect(await readFile(finalPath, "utf-8")).toBe("new content");
  });

  it("increments through multiple collisions", async () => {
    await writeFile(path.join(destDir, "hero.mov"), "v0");
    await writeFile(path.join(destDir, "hero_002.mov"), "v1");

    const src = path.join(stagingDir, "download.tmp");
    await writeFile(src, "v2");

    const finalPath = await moveIntoDestination(src, destDir, "hero", ".mov");
    expect(finalPath).toBe(path.join(destDir, "hero_003.mov"));
  });

  it("leaves the staged source file untouched if the source cannot be read", async () => {
    const missingSrc = path.join(stagingDir, "does-not-exist.tmp");
    await expect(moveIntoDestination(missingSrc, destDir, "hero", ".mov")).rejects.toBeInstanceOf(RoutingError);
  });

  it("does not leave a temp file behind after a successful move", async () => {
    const src = path.join(stagingDir, "download.tmp");
    await writeFile(src, "content");
    await moveIntoDestination(src, destDir, "hero", ".mov");

    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(destDir);
    expect(entries).toEqual(["hero.mov"]);
  });

  it("still reports success when deleting the original source fails (e.g. locked open by another program) — the file is already safely at the destination", async () => {
    const src = path.join(stagingDir, "download.tmp");
    await writeFile(src, "hello world");

    const finalPath = await moveIntoDestination(src, destDir, "hero", ".mov", {
      unlinkFn: async (p) => {
        if (p === src) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
        await (await import("node:fs/promises")).unlink(p);
      },
    });

    expect(finalPath).toBe(path.join(destDir, "hero.mov"));
    expect(await readFile(finalPath, "utf-8")).toBe("hello world");
    // the redundant source copy is left behind on purpose — never duplicated
    // at the destination, never reported as a failure (§M).
    expect(await readFile(src, "utf-8")).toBe("hello world");
  });
});
