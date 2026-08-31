import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { handleRouteFile } from "../src/routeFile.js";
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
    source: "chatgpt",
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

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "aias-root-")));
    downloadsDir = await realpath(await mkdtemp(path.join(tmpdir(), "aias-downloads-")));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(downloadsDir, { recursive: true, force: true });
  });

  it("routes a downloaded file (left untouched by the download step) to the correct nested destination", async () => {
    const src = path.join(downloadsDir, "abc123.png");
    await writeFile(src, "fake png bytes");

    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const result = await handleRouteFile(config, req({ sourcePath: src }), downloadsDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalPath).toBe(
        path.join(root, "Galaxy_S27", "SQ010", "SH020", "Generated", "SH020_IMG_woman_red_dress_closeup_023.png"),
      );
      expect(await readFile(result.finalPath, "utf-8")).toBe("fake png bytes");
    }
  });

  it("rejects a sourcePath outside the OS Downloads folder (§F-2)", async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "aias-not-downloads-"));
    const outsideSrc = path.join(outsideDir, "not-in-downloads.png");
    await writeFile(outsideSrc, "x");

    try {
      const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
      const result = await handleRouteFile(config, req({ sourcePath: outsideSrc }), downloadsDir);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SOURCE_PATH_INVALID");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects a symlink escape planted inside the Downloads folder (§F-2)", async () => {
    const outsideDir = await mkdtemp(path.join(tmpdir(), "aias-escape-target-"));
    const outsideSrc = path.join(outsideDir, "secret.png");
    await writeFile(outsideSrc, "secret bytes");
    const linkPath = path.join(downloadsDir, "looks-like-a-download.png");
    await symlink(outsideSrc, linkPath);

    try {
      const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
      const result = await handleRouteFile(config, req({ sourcePath: linkPath }), downloadsDir);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("SOURCE_PATH_INVALID");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("reports SOURCE_NOT_FOUND when the file is gone from Downloads by Organize time", async () => {
    const src = path.join(downloadsDir, "already-deleted.png"); // never created

    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const result = await handleRouteFile(config, req({ sourcePath: src }), downloadsDir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("SOURCE_NOT_FOUND");
  });

  it("reports ROOT_NOT_CONFIGURED without touching the downloaded file", async () => {
    const src = path.join(downloadsDir, "abc123.png");
    await writeFile(src, "fake png bytes");

    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: "" };
    const result = await handleRouteFile(config, req({ sourcePath: src }), downloadsDir);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ROOT_NOT_CONFIGURED");
    // file must survive so the user never loses it (§M)
    await expect(readFile(src, "utf-8")).resolves.toBe("fake png bytes");
  });

  it("builds the custom-filename form when customFilenameEnabled is set, preserving the original extension", async () => {
    const src = path.join(downloadsDir, "clip.tmp");
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
      downloadsDir,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(path.basename(result.finalPath)).toBe("hero_final.mov");
    }
  });

  it("includes the {source} token end-to-end when the naming template uses it", async () => {
    const src = path.join(downloadsDir, "abc123.png");
    await writeFile(src, "fake png bytes");

    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const result = await handleRouteFile(
      config,
      req({
        sourcePath: src,
        source: "gemini",
        naming: { ...req().naming, namingTemplate: "{shot}_{source}_{index}" },
      }),
      downloadsDir,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(path.basename(result.finalPath)).toBe("SH020_gemini_023.png");
    }
  });
});
