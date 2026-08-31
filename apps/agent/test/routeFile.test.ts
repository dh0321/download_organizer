import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleRouteFile, STAGING_DIR_NAME } from "../src/routeFile.js";
import { defaultAgentConfig } from "../src/agentConfig.js";
import type { NativeRequest } from "@ai-asset-saver/shared";

function req(overrides: Partial<Extract<NativeRequest, { type: "route-file" }>> = {}): Extract<
  NativeRequest,
  { type: "route-file" }
> {
  return {
    type: "route-file",
    jobId: "job-1",
    sourcePath: "",
    extension: ".png",
    mediaType: "image",
    reservedIndex: 23,
    naming: {
      project: "Galaxy_S27",
      sequence: "SQ010",
      shot: "SH020",
      bucketId: "generated",
      description: "woman red dress closeup",
      namingPresetId: "default",
      namingTemplate: "{shot}_{type}_{description}_{index}",
      customFilenameEnabled: false,
      customFilename: "",
    },
    ...overrides,
  };
}

describe("handleRouteFile", () => {
  let root: string;
  let downloadsDir: string;
  let stagingDir: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "aias-root-")));
    downloadsDir = await mkdtemp(path.join(tmpdir(), "aias-downloads-"));
    stagingDir = path.join(downloadsDir, STAGING_DIR_NAME);
    await mkdir(stagingDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(downloadsDir, { recursive: true, force: true });
  });

  it("routes a staged file to the correct nested destination with the expected filename", async () => {
    const src = path.join(stagingDir, "abc123.png");
    await writeFile(src, "fake png bytes");

    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const result = await handleRouteFile(config, req({ sourcePath: src }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalPath).toBe(
        path.join(root, "Galaxy_S27", "SQ010", "SH020", "Generated", "SH020_IMG_woman_red_dress_closeup_023.png"),
      );
      expect(await readFile(result.finalPath, "utf-8")).toBe("fake png bytes");
    }
  });

  it("rejects a sourcePath outside the designated staging area (§F-2)", async () => {
    const outsideSrc = path.join(downloadsDir, "not-staged.png"); // sibling of staging dir, not inside it
    await writeFile(outsideSrc, "x");

    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const result = await handleRouteFile(config, req({ sourcePath: outsideSrc }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SOURCE_PATH_INVALID");
  });

  it("reports ROOT_NOT_CONFIGURED without touching the staged file", async () => {
    const src = path.join(stagingDir, "abc123.png");
    await writeFile(src, "fake png bytes");

    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: "" };
    const result = await handleRouteFile(config, req({ sourcePath: src }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ROOT_NOT_CONFIGURED");
    // staged file must survive so the user never loses it (§M)
    await expect(readFile(src, "utf-8")).resolves.toBe("fake png bytes");
  });

  it("builds the custom-filename form when customFilenameEnabled is set, preserving the original extension", async () => {
    const src = path.join(stagingDir, "clip.tmp");
    await writeFile(src, "video bytes");

    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const result = await handleRouteFile(
      config,
      req({
        sourcePath: src,
        extension: ".mov",
        mediaType: "video",
        naming: {
          ...req().naming,
          customFilenameEnabled: true,
          customFilename: "hero final",
        },
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(path.basename(result.finalPath)).toBe("hero_final.mov");
    }
  });
});
