import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Jimp } from "jimp";
import { readThumbnail } from "../src/readThumbnail.js";

async function writeTestPng(filePath: string, width: number, height: number): Promise<void> {
  const image = new Jimp({ width, height, color: 0xff0000ff });
  const buffer = await image.getBuffer("image/png");
  await writeFile(filePath, buffer);
}

async function dataUrlDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const image = await Jimp.read(Buffer.from(base64, "base64"));
  return { width: image.width, height: image.height };
}

describe("readThumbnail", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("downscales a large image to fit within the max dimension, as a PNG data URL", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aias-thumb-"));
    const filePath = path.join(dir, "hero.png");
    await writeTestPng(filePath, 1600, 900);

    const dataUrl = await readThumbnail(filePath);
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);

    const { width, height } = await dataUrlDimensions(dataUrl);
    expect(Math.max(width, height)).toBeLessThanOrEqual(128);
    // Aspect ratio preserved (1600:900 = 16:9).
    expect(width / height).toBeCloseTo(1600 / 900, 1);
  });

  it("does not upscale an image already smaller than the max dimension", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aias-thumb-"));
    const filePath = path.join(dir, "small.png");
    await writeTestPng(filePath, 20, 10);

    const dataUrl = await readThumbnail(filePath);
    const { width, height } = await dataUrlDimensions(dataUrl);
    expect(width).toBe(20);
    expect(height).toBe(10);
  });

  it("produces a thumbnail small enough for Native Messaging's 1 MiB host-to-extension limit", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aias-thumb-"));
    const filePath = path.join(dir, "hero.png");
    await writeTestPng(filePath, 4000, 3000);

    const dataUrl = await readThumbnail(filePath);
    // Generous margin under the real 1 MiB limit — a solid-color test image
    // compresses far smaller than this in practice, this just guards the
    // ceiling. See index.ts's writeMessage try/catch for what happens if a
    // response ever does exceed it.
    expect(dataUrl.length).toBeLessThan(200 * 1024);
  });

  it("rejects an unsupported or corrupt file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aias-thumb-"));
    const filePath = path.join(dir, "clip.mp4");
    await writeFile(filePath, "not a real video");

    await expect(readThumbnail(filePath)).rejects.toThrow();
  });

  it("rejects a source file larger than the size cap, without attempting to decode it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aias-thumb-"));
    const filePath = path.join(dir, "huge.png");
    // 20MB cap — one byte over. Zero-filled, not a real image: this test is
    // about the pre-decode size guard rejecting the file outright, not
    // about what jimp would do with it.
    await writeFile(filePath, Buffer.alloc(20 * 1024 * 1024 + 1));

    await expect(readThumbnail(filePath)).rejects.toThrow(/too large/);
  });

  it("propagates a real filesystem error (e.g. file missing)", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aias-thumb-"));
    const filePath = path.join(dir, "missing.png");
    await expect(readThumbnail(filePath)).rejects.toThrow();
  });
});
