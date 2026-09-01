import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import type { Dirent } from "node:fs";
import { listDownloadsFolder } from "../src/listDownloadsFolder.js";

function fileDirent(name: string): Dirent {
  return { name, isFile: () => true, isDirectory: () => false } as Dirent;
}

function dirDirent(name: string): Dirent {
  return { name, isFile: () => false, isDirectory: () => true } as Dirent;
}

describe("listDownloadsFolder", () => {
  it("lists files with their extension and modified time", async () => {
    const readdirFn = vi.fn(async () => [fileDirent("a.png")]);
    const statFn = vi.fn(async () => ({ birthtimeMs: 1000, mtimeMs: 2000 }));

    const entries = await listDownloadsFolder("/Downloads", readdirFn, statFn);

    expect(entries).toEqual([
      { path: path.join("/Downloads", "a.png"), filename: "a.png", extension: ".png", modifiedAt: 1000 },
    ]);
  });

  it("skips subdirectories — only real files are reported", async () => {
    const readdirFn = vi.fn(async () => [dirDirent("subfolder"), fileDirent("b.jpg")]);
    const statFn = vi.fn(async () => ({ birthtimeMs: 500, mtimeMs: 600 }));

    const entries = await listDownloadsFolder("/Downloads", readdirFn, statFn);

    expect(entries.map((e) => e.filename)).toEqual(["b.jpg"]);
  });

  it("falls back to mtime when birthtime reads as 0 (filesystem doesn't track creation time)", async () => {
    const readdirFn = vi.fn(async () => [fileDirent("c.mp4")]);
    const statFn = vi.fn(async () => ({ birthtimeMs: 0, mtimeMs: 4242 }));

    const entries = await listDownloadsFolder("/Downloads", readdirFn, statFn);

    expect(entries[0].modifiedAt).toBe(4242);
  });

  it("lowercases the extension", async () => {
    const readdirFn = vi.fn(async () => [fileDirent("PHOTO.PNG")]);
    const statFn = vi.fn(async () => ({ birthtimeMs: 1, mtimeMs: 1 }));

    const entries = await listDownloadsFolder("/Downloads", readdirFn, statFn);

    expect(entries[0].extension).toBe(".png");
  });

  it("returns an empty list for an empty folder", async () => {
    const readdirFn = vi.fn(async () => []);
    const statFn = vi.fn();

    const entries = await listDownloadsFolder("/Downloads", readdirFn, statFn);

    expect(entries).toEqual([]);
  });
});
