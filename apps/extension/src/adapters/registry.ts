// Adding a new AI source (Phase 2: Runway/Veo/Sora) means adding one adapter file
// and one entry here, plus the matching host_permissions/content_scripts manifest
// entries (§K) — no other pipeline code changes (§D).

import type { AISourceAdapter, MediaType } from "@download-organizer/shared";
import { chatgptAdapter } from "./chatgpt.js";
import { geminiAdapter } from "./gemini.js";
import { higgsfieldAdapter } from "./higgsfield.js";
import { seedanceAdapter } from "./seedance.js";
import { midjourneyAdapter } from "./midjourney.js";
import { leonardoAdapter } from "./leonardo.js";
import { kreaAdapter } from "./krea.js";
import { runwayAdapter } from "./runway.js";
import { klingAdapter } from "./kling.js";
import { fireflyAdapter } from "./firefly.js";
import { xianchouAdapter } from "./xianchou.js";

export const adapters: AISourceAdapter[] = [
  chatgptAdapter,
  geminiAdapter,
  higgsfieldAdapter,
  seedanceAdapter,
  midjourneyAdapter,
  leonardoAdapter,
  kreaAdapter,
  runwayAdapter,
  klingAdapter,
  fireflyAdapter,
  xianchouAdapter,
];

export function findMatchingAdapter(ctx: Parameters<AISourceAdapter["matchesDownload"]>[0]): AISourceAdapter | undefined {
  return adapters.find((adapter) => adapter.matchesDownload(ctx));
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".heic", ".heif", ".tif", ".tiff"];
const VIDEO_EXTENSIONS = [".mov", ".mp4", ".webm", ".avi", ".mkv", ".m4v", ".wmv", ".flv", ".mpeg", ".mpg"];
const AUDIO_EXTENSIONS = [".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg", ".opus"];

/** The single gate deciding whether a download/on-disk file is tracked at all
 * (both live Watch Mode detection and Rescan's folder scan call this) — an
 * extension missing here is silently invisible everywhere, never an error. */
export function mediaTypeForExtension(extension: string): MediaType | undefined {
  if (IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (VIDEO_EXTENSIONS.includes(extension)) return "video";
  if (AUDIO_EXTENSIONS.includes(extension)) return "audio";
  return undefined;
}
