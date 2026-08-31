// Adding a new AI source (Phase 2: Runway/Veo/Sora) means adding one adapter file
// and one entry here, plus the matching host_permissions/content_scripts manifest
// entries (§K) — no other pipeline code changes (§D).

import type { AISourceAdapter } from "@ai-asset-saver/shared";
import { chatgptAdapter } from "./chatgpt.js";
import { geminiAdapter } from "./gemini.js";

export const adapters: AISourceAdapter[] = [chatgptAdapter, geminiAdapter];

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
