import { describe, it, expect } from "vitest";
import { IntentPingStore } from "../src/background/intentPingStore.js";

describe("IntentPingStore", () => {
  it("returns the most recent ping", () => {
    const store = new IntentPingStore();
    const now = Date.now();
    store.record("https://chatgpt.com", now - 2000);
    store.record("https://gemini.google.com", now - 1000);
    expect(store.mostRecent()).toEqual({ origin: "https://gemini.google.com", timestamp: now - 1000 });
  });

  it("returns undefined when no pings have been recorded", () => {
    expect(new IntentPingStore().mostRecent()).toBeUndefined();
  });

  it("prunes pings older than the retention window", () => {
    const store = new IntentPingStore();
    const veryOld = Date.now() - 60_000;
    store.record("https://chatgpt.com", veryOld);
    expect(store.mostRecent()).toBeUndefined();
  });

  it("clear() removes all pings", () => {
    const store = new IntentPingStore();
    store.record("https://chatgpt.com");
    store.clear();
    expect(store.mostRecent()).toBeUndefined();
  });
});
