// Adding a new AI source (Phase 2: Runway/Veo/Sora) means adding one adapter file
// and one entry here, plus the matching host_permissions/content_scripts manifest
// entries (§K) — no other pipeline code changes (§D).

import type { AISourceAdapter } from "@ai-asset-saver/shared";
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

export const SUPPORTED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".mov",
  ".mp4",
  ".webm",
]);

export function mediaTypeForExtension(extension: string): "image" | "video" | undefined {
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return "image";
  if ([".mov", ".mp4", ".webm"].includes(extension)) return "video";
  return undefined;
}
