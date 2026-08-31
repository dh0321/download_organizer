import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSafeDestination, assertWithinRoot, RoutingError } from "../src/fileRouter.js";
import { defaultAgentConfig } from "../src/agentConfig.js";
import type { NamingFields } from "@ai-asset-saver/shared";

function naming(overrides: Partial<NamingFields> = {}): NamingFields {
  return {
    project: "Galaxy_S27",
    sequence: "SQ010",
    shot: "SH020",
    bucketId: "generated",
    description: "",
    namingPresetId: "default",
    namingTemplate: "{shot}_{type}_{description}_{index}",
    customFilenameEnabled: false,
    customFilename: "",
    ...overrides,
  };
}

describe("resolveSafeDestination", () => {
  let root: string;

  beforeEach(async () => {
    // realpath() immediately: on macOS, tmpdir() lives under a symlink
    // (/tmp -> /private/tmp), and resolveSafeDestination itself always realpath's
    // the configured root — comparing against the un-resolved path would spuriously
    // fail even though the containment logic is correct.
    root = await realpath(await mkdtemp(path.join(tmpdir(), "aias-root-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("creates and returns the nested folder for project/sequence/shot/bucket", async () => {
    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const dest = await resolveSafeDestination(config, naming());
    expect(dest).toBe(path.join(root, "Galaxy_S27", "SQ010", "SH020", "Generated"));
  });

  it("drops the sequence segment when empty — no hole in the path", async () => {
    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const dest = await resolveSafeDestination(config, naming({ sequence: "" }));
    expect(dest).toBe(path.join(root, "Galaxy_S27", "SH020", "Generated"));
  });

  it("throws ROOT_NOT_CONFIGURED when defaultRoot is empty", async () => {
    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: "" };
    await expect(resolveSafeDestination(config, naming())).rejects.toMatchObject({
      code: "ROOT_NOT_CONFIGURED",
    });
  });

  it("throws ROOT_UNAVAILABLE when defaultRoot does not exist", async () => {
    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: path.join(root, "does-not-exist") };
    await expect(resolveSafeDestination(config, naming())).rejects.toMatchObject({
      code: "ROOT_UNAVAILABLE",
    });
  });

  it("throws MISSING_REQUIRED_FIELD when the required project field is empty", async () => {
    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    await expect(resolveSafeDestination(config, naming({ project: "" }))).rejects.toMatchObject({
      code: "MISSING_REQUIRED_FIELD",
    });
  });

  it("rejects a '..' path-traversal attempt disguised as a project name", async () => {
    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    await expect(resolveSafeDestination(config, naming({ project: ".." }))).rejects.toMatchObject({
      code: "OUTSIDE_ROOT",
    });
  });

  it("rejects a destination that escapes Root via a symlink/junction planted inside Root", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "aias-outside-"));
    try {
      // Simulate a Windows junction: a directory inside Root that actually points
      // to a location outside Root (§L, §F-2).
      await symlink(outside, path.join(root, "Escaped"), "dir");

      const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
      await expect(
        resolveSafeDestination(config, naming({ project: "Escaped", sequence: "", shot: "" })),
      ).rejects.toMatchObject({ code: "OUTSIDE_ROOT" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("assertWithinRoot (prefix-boundary logic)", () => {
  it("accepts a true descendant", () => {
    expect(() => assertWithinRoot("/root/child", "/root")).not.toThrow();
  });

  it("accepts the root itself", () => {
    expect(() => assertWithinRoot("/root", "/root")).not.toThrow();
  });

  it("rejects a sibling directory whose name merely starts with the root's name", () => {
    // Without the separator-aware check, a naive string prefix test would wrongly
    // accept "/root2/child" as being "inside" "/root".
    expect(() => assertWithinRoot("/root2/child", "/root")).toThrow(RoutingError);
  });

  it("rejects an unrelated path", () => {
    expect(() => assertWithinRoot("/somewhere/else", "/root")).toThrow(RoutingError);
  });
});

// NOTE: the case-insensitive Root-containment comparison (relevant on Windows/NTFS,
// where "D:\AI_Projects2" must not be mistaken for a child of "D:\AI_Projects") is
// not meaningfully testable on a case-sensitive dev filesystem and must be
// re-verified on real Windows (tracked in PLAN.md §Q).
