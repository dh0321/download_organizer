import { describe, it, expect } from "vitest";
import { buildIndexKey, buildIndexKeyForCustomDirectory } from "../src/indexReservation.js";

describe("buildIndexKey", () => {
  it("gives the same key to two different Shot/Asset Name values in the same folder", () => {
    const keyA = buildIndexKey({ project: "P", sequence: "SQ010", bucketId: "generated", mediaType: "image" });
    const keyB = buildIndexKey({ project: "P", sequence: "SQ010", bucketId: "generated", mediaType: "image" });
    expect(keyA).toBe(keyB);
  });

  it("gives different keys to different destination folders", () => {
    const keyA = buildIndexKey({ project: "A", sequence: "SQ010", mediaType: "image" });
    const keyB = buildIndexKey({ project: "A", sequence: "SQ020", mediaType: "image" });
    expect(keyA).not.toBe(keyB);
  });

  it("is case-insensitive and whitespace-trimmed", () => {
    expect(buildIndexKey({ project: "Galaxy", sequence: "SQ010", mediaType: "IMAGE" })).toBe(
      buildIndexKey({ project: "  galaxy  ", sequence: "sq010", mediaType: "image" }),
    );
  });
});

describe("buildIndexKeyForCustomDirectory", () => {
  it("gives different directories different keys", () => {
    const keyA = buildIndexKeyForCustomDirectory("ClientA\\ReviewBatch2", "image");
    const keyB = buildIndexKeyForCustomDirectory("ClientB\\ReviewBatch2", "image");
    expect(keyA).not.toBe(keyB);
  });

  it("is case-insensitive and whitespace-trimmed, like buildIndexKey", () => {
    expect(buildIndexKeyForCustomDirectory("ClientA\\Batch", "IMAGE")).toBe(
      buildIndexKeyForCustomDirectory("  clienta\\batch  ", "image"),
    );
  });

  it("never collides with a structured buildIndexKey for the same-looking string", () => {
    // Namespaced with a "custom-dir:" prefix so a custom directory literally
    // named e.g. "generated" can't accidentally share a key with a
    // project/sequence/bucket combination that produces the same text.
    const structured = buildIndexKey({ project: "a", sequence: "", bucketId: "generated", mediaType: "image" });
    const custom = buildIndexKeyForCustomDirectory("a||generated", "image");
    expect(structured).not.toBe(custom);
  });
});
