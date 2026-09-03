import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getMaxIndex } from "../src/getMaxIndex.js";
import { defaultAgentConfig } from "../src/agentConfig.js";

describe("getMaxIndex", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aias-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns 0 when the destination folder has never been used", async () => {
    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const max = await getMaxIndex(config, { project: "Galaxy_S27", sequence: "", shot: "SH020", bucketId: "generated" });
    expect(max).toBe(0);
  });

  it("finds the highest existing index among files in the destination folder", async () => {
    const folder = path.join(root, "Galaxy_S27", "Generated");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SH020_IMG_001.png"), "x");
    await writeFile(path.join(folder, "SH020_IMG_010.png"), "x");
    await writeFile(path.join(folder, "SH020_VID_004.mov"), "x");
    await writeFile(path.join(folder, "not_matching_at_all.txt"), "x");

    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const max = await getMaxIndex(config, { project: "Galaxy_S27", sequence: "", shot: "SH020", bucketId: "generated" });
    expect(max).toBe(10);
  });

  it("scans the custom directory folder when customDirectoryEnabled is set", async () => {
    const folder = path.join(root, "ClientA", "ReviewBatch2");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "asset_IMG_005.png"), "x");

    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const max = await getMaxIndex(config, {
      project: "",
      sequence: "",
      shot: "",
      customDirectoryEnabled: true,
      customDirectory: "ClientA\\ReviewBatch2",
    });
    expect(max).toBe(5);
  });
});
