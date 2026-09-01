import { describe, it, expect } from "vitest";
import { hostMatches, pingWithinWindow, makeHostAdapter, INTENT_PING_WINDOW_MS } from "../src/adapters/base.js";
import { findMatchingAdapter, mediaTypeForExtension } from "../src/adapters/registry.js";
import { chatgptAdapter } from "../src/adapters/chatgpt.js";
import { geminiAdapter } from "../src/adapters/gemini.js";

describe("hostMatches", () => {
  it("matches an exact host", () => {
    expect(hostMatches("https://chatgpt.com/c/123", ["chatgpt.com"])).toBe(true);
  });

  it("matches a subdomain", () => {
    expect(hostMatches("https://cdn.chatgpt.com/file.png", ["chatgpt.com"])).toBe(true);
  });

  it("rejects an unrelated host", () => {
    expect(hostMatches("https://evil.com/chatgpt.com", ["chatgpt.com"])).toBe(false);
  });

  it("rejects a host that merely contains the pattern as a substring (not a subdomain)", () => {
    expect(hostMatches("https://notchatgpt.com/", ["chatgpt.com"])).toBe(false);
  });

  it("returns false for an unparseable URL instead of throwing", () => {
    expect(hostMatches("blob:not-a-real-url", ["chatgpt.com"])).toBe(false);
  });
});

describe("pingWithinWindow", () => {
  it("accepts a ping within the window", () => {
    const now = 10_000;
    expect(pingWithinWindow({ origin: "https://chatgpt.com", timestamp: now - 1000 }, now)).toBe(true);
  });

  it("rejects a ping older than the window", () => {
    const now = 10_000;
    expect(pingWithinWindow({ origin: "https://chatgpt.com", timestamp: now - (INTENT_PING_WINDOW_MS + 1) }, now)).toBe(
      false,
    );
  });

  it("rejects a missing ping", () => {
    expect(pingWithinWindow(undefined, Date.now())).toBe(false);
  });
});

describe("makeHostAdapter / matchesDownload", () => {
  const adapter = makeHostAdapter("test", "Test", ["example.com"]);

  it("requires both a host match AND a recent same-origin intent ping", () => {
    const now = Date.now();
    expect(
      adapter.matchesDownload({
        url: "https://example.com/file.png",
        recentIntentPing: { origin: "https://example.com", timestamp: now - 500 },
      }),
    ).toBe(true);
  });

  it("rejects a host match with no intent ping at all (blob: URL with no referrer)", () => {
    expect(adapter.matchesDownload({ url: "https://example.com/file.png" })).toBe(false);
  });

  it("rejects when the intent ping's origin doesn't match this adapter's hosts", () => {
    const now = Date.now();
    expect(
      adapter.matchesDownload({
        url: "https://example.com/file.png",
        recentIntentPing: { origin: "https://unrelated.com", timestamp: now - 500 },
      }),
    ).toBe(false);
  });

  it("rejects a download whose url/referrer don't match this adapter at all", () => {
    const now = Date.now();
    expect(
      adapter.matchesDownload({
        url: "https://not-example.com/file.png",
        recentIntentPing: { origin: "https://example.com", timestamp: now - 500 },
      }),
    ).toBe(false);
  });

  it("matches a blob: download URL with no referrer, falling back to a recent same-origin intent ping (real ChatGPT shape)", () => {
    const now = Date.now();
    // Confirmed live: ChatGPT's actual download URL for a generated image is
    // exactly this shape, and Chrome leaves `referrer` empty for it — a
    // blob: URL's hostname is always "" per the URL spec (blob isn't a
    // "special" scheme), so neither url nor referrer carries any host info.
    expect(
      adapter.matchesDownload({
        url: "blob:https://example.com/edd88778-e08f-43d4-b969-50f7ef092a77",
        referrer: "",
        recentIntentPing: { origin: "https://example.com", timestamp: now - 500 },
      }),
    ).toBe(true);
  });

  it("rejects a blob: download with no host info at all when there is no intent ping", () => {
    expect(
      adapter.matchesDownload({
        url: "blob:https://example.com/edd88778-e08f-43d4-b969-50f7ef092a77",
        referrer: "",
      }),
    ).toBe(false);
  });

  it("rejects a blob: download whose intent ping is from an unrelated origin", () => {
    const now = Date.now();
    expect(
      adapter.matchesDownload({
        url: "blob:https://example.com/edd88778-e08f-43d4-b969-50f7ef092a77",
        referrer: "",
        recentIntentPing: { origin: "https://unrelated.com", timestamp: now - 500 },
      }),
    ).toBe(false);
  });
});

describe("findMatchingAdapter (registry)", () => {
  it("finds the ChatGPT adapter for a chatgpt.com download with a recent ping", () => {
    const now = Date.now();
    const found = findMatchingAdapter({
      url: "https://chatgpt.com/backend-api/estuary/content?x=1",
      recentIntentPing: { origin: "https://chatgpt.com", timestamp: now - 100 },
    });
    expect(found?.id).toBe(chatgptAdapter.id);
  });

  it("finds the Gemini adapter for a gemini.google.com download with a recent ping", () => {
    const now = Date.now();
    const found = findMatchingAdapter({
      url: "https://gemini.google.com/some/asset",
      recentIntentPing: { origin: "https://gemini.google.com", timestamp: now - 100 },
    });
    expect(found?.id).toBe(geminiAdapter.id);
  });

  it("finds no adapter for an unrelated site", () => {
    const found = findMatchingAdapter({ url: "https://example.org/report.pdf" });
    expect(found).toBeUndefined();
  });

  it("finds the Gemini adapter for a Google AI Studio download (Nano Banana's other access path)", () => {
    const now = Date.now();
    const found = findMatchingAdapter({
      url: "https://aistudio.google.com/some/asset",
      recentIntentPing: { origin: "https://aistudio.google.com", timestamp: now - 100 },
    });
    expect(found?.id).toBe(geminiAdapter.id);
  });

  // One representative host per newly-added adapter (§ "general download
  // manager" scope widening — domains verified via web search before adding).
  it.each([
    ["higgsfield", "https://higgsfield.ai/generate/1"],
    ["seedance", "https://dreamina.capcut.com/seedance/asset"],
    ["midjourney", "https://midjourney.com/jobs/1"],
    ["leonardo", "https://leonardo.ai/generations/1"],
    ["krea", "https://krea.ai/create/1"],
    ["runway", "https://app.runwayml.com/tasks/1"],
    ["kling", "https://kling.ai/videos/1"],
    ["firefly", "https://firefly.adobe.com/generate/1"],
    ["xianchou", "https://xianchou.com/works/1"],
  ])("finds the %s adapter for its own host with a recent ping", (id, url) => {
    const now = Date.now();
    const origin = new URL(url).origin;
    const found = findMatchingAdapter({ url, recentIntentPing: { origin, timestamp: now - 100 } });
    expect(found?.id).toBe(id);
  });
});

describe("mediaTypeForExtension", () => {
  it("classifies supported image extensions", () => {
    for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
      expect(mediaTypeForExtension(ext)).toBe("image");
    }
  });

  it("classifies supported video extensions", () => {
    for (const ext of [".mov", ".mp4", ".webm"]) {
      expect(mediaTypeForExtension(ext)).toBe("video");
    }
  });

  it("returns undefined for unsupported extensions (e.g. pdf/zip)", () => {
    expect(mediaTypeForExtension(".pdf")).toBeUndefined();
    expect(mediaTypeForExtension(".zip")).toBeUndefined();
  });
});
