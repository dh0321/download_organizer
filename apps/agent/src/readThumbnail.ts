// Reads an image file, downsizes it, and returns it as a data: URL, so the
// Inbox's Thumbnail can show a real preview without needing file:// access
// from the extension page — this codebase already confirmed live that
// Chrome blocks file:// loads entirely from a chrome-extension:// document,
// regardless of the "Allow access to file URLs" toggle (that setting only
// governs content scripts / host-permission matching on file: pages, not
// in-page subresource loads). Images only: video would need real frame
// extraction (ffmpeg or similar, a much heavier addition — and one that
// significantly complicates the pkg cross-compile pipeline, since native
// dependencies don't package cleanly); audio has no meaningful visual
// thumbnail to begin with.
//
// jimp (pure JS/TS, no native binaries — confirmed no .node files and no
// postinstall build step) does the actual decode/resize/encode, so this
// still cross-compiles cleanly via pkg. The resize is not just a nice-to-
// have: Native Messaging caps a single host-to-extension message at 1 MiB
// (see stdio.ts) — confirmed live that ignoring this crashed the whole
// Agent process outright (see index.ts's writeMessage try/catch) — and
// real AI-generation output PNGs (this tool's actual use case) commonly run
// 2-3MB, several times over that limit on their own before base64 even
// inflates them further. Downscaling first sidesteps the limit entirely
// instead of just rejecting most real files outright: a resized thumbnail
// is on the order of tens of KB regardless of the source file's size.

import { stat } from "node:fs/promises";
import { Jimp } from "jimp";

// Guards decode cost/memory for a pathologically large source file — NOT a
// stand-in for the Native Messaging limit above (the resize below already
// handles that regardless of source size).
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

// Matches the Inbox's .aias-thumb box (64x64 CSS px) with headroom for
// higher-DPI displays — no reason to ship more pixels than will ever show.
const MAX_THUMBNAIL_DIMENSION = 128;

export async function readThumbnail(filePath: string): Promise<string> {
  const { size } = await stat(filePath);
  if (size > MAX_SOURCE_BYTES) {
    throw new Error(`File too large for a thumbnail (${size} bytes)`);
  }

  // Jimp.read itself rejects unsupported formats (svg/webp/avif — none of
  // jimp's built-in decoders cover these) and corrupt files with a clear
  // error, so there's no need to pre-check the extension separately.
  const image = await Jimp.read(filePath);

  const scale = Math.min(1, MAX_THUMBNAIL_DIMENSION / Math.max(image.width, image.height));
  if (scale < 1) {
    image.resize({ w: Math.round(image.width * scale), h: Math.round(image.height * scale) });
  }

  const buffer = await image.getBuffer("image/png");
  return `data:image/png;base64,${buffer.toString("base64")}`;
}
