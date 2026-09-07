import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { listDestinationFiles } from "../src/listDestinationFiles.js";
import { defaultAgentConfig } from "../src/agentConfig.js";

describe("listDestinationFiles", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "aias-root-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns an empty list when the destination folder has never been used", async () => {
    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const files = await listDestinationFiles(config, { project: "Galaxy_S27", sequence: "", shot: "SH020", bucketId: "generated" });
    expect(files).toEqual([]);
  });

  it("lists every file actually present in the destination folder, unfiltered", async () => {
    const folder = path.join(root, "Galaxy_S27", "Generated");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "SH020_v001.png"), "x");
    await writeFile(path.join(folder, "SH020_v002.png"), "x");
    await writeFile(path.join(folder, "not_related_at_all.txt"), "x");

    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const files = await listDestinationFiles(config, { project: "Galaxy_S27", sequence: "", shot: "SH020", bucketId: "generated" });
    expect(files.sort()).toEqual(["SH020_v001.png", "SH020_v002.png", "not_related_at_all.txt"]);
  });

  it("scans the custom directory folder when customDirectoryEnabled is set", async () => {
    const folder = path.join(root, "ClientA", "ReviewBatch2");
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "asset_v005.png"), "x");

    const config = { ...defaultAgentConfig("ext-id"), defaultRoot: root };
    const files = await listDestinationFiles(config, {
      project: "",
      sequence: "",
      shot: "",
      customDirectoryEnabled: true,
      customDirectory: "ClientA\\ReviewBatch2",
    });
    expect(files).toEqual(["asset_v005.png"]);
  });
});
