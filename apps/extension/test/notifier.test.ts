import { describe, it, expect, vi } from "vitest";
import { formatSingleSavedMessage, formatBatchMessage, notifyJobsUpdated } from "../src/background/notifier.js";
import { JobManager } from "../src/background/jobManager.js";
import type { DownloadJob, SessionState } from "@ai-asset-saver/shared";

function job(overrides: Partial<DownloadJob> = {}): DownloadJob {
  return {
    id: "j1",
    browserDownloadId: 1,
    originalFilename: "x.png",
    extension: ".png",
    mediaType: "image",
    source: "chatgpt",
    detectedAt: Date.now(),
    sessionSnapshot: {
      root: "D:\\AI_Projects",
      project: "Galaxy_S27",
      sequence: "SQ010",
      shot: "SH020",
      bucketId: "generated",
      description: "",
      namingPresetId: "default",
      customFilenameEnabled: false,
      customFilename: "",
    },
    reservedIndex: 23,
    status: "saved",
    finalFilename: "SH020_IMG_023.png",
    ...overrides,
  };
}

function session(): SessionState {
  return {
    aiSessionEnabled: true,
    currentProject: "Galaxy_S27",
    currentSequence: "SQ010",
    currentShot: "SH020",
    currentBucketId: "generated",
    currentDescription: "",
    selectedNamingPresetId: "default",
    customFilenameEnabled: false,
    customFilename: "",
    lastIndexByKey: {},
  };
}

describe("formatSingleSavedMessage", () => {
  it("includes the filename and a Project/Sequence/Shot breadcrumb", () => {
    const { title, message } = formatSingleSavedMessage(job());
    expect(title).toBe("Saved");
    expect(message).toContain("SH020_IMG_023.png");
    expect(message).toContain("Galaxy_S27 / SQ010 / SH020");
  });
});

describe("formatBatchMessage", () => {
  it("aggregates counts while jobs are still in flight", () => {
    const jobs = [
      job({ status: "saved" }),
      job({ status: "downloading" }),
      job({ status: "moving" }),
    ];
    const { title, message } = formatBatchMessage(jobs);
    expect(title).toBe("Saving 3 AI assets...");
    expect(message).toContain("1 saved");
  });

  it("shows a completion summary once every job is terminal", () => {
    const jobs = [job({ status: "saved" }), job({ status: "saved" }), job({ status: "failed" })];
    const { title, message } = formatBatchMessage(jobs);
    expect(title).toContain("3 assets processed");
    expect(title).toContain("1 failed");
    expect(message).toContain("2 saved");
  });
});

describe("notifyJobsUpdated", () => {
  it("uses the single-toast path when only one job is active", async () => {
    const manager = await JobManager.create({
      loadPersistedIndexCounters: vi.fn(async () => ({})),
      persistIndexCounters: vi.fn(),
      generateJobId: vi.fn(() => "job-1"),
    });
    const j = manager.detectJob({
      browserDownloadId: 1,
      originalFilename: "x.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      session: session(),
      cachedRootForDisplay: "",
    });
    manager.setResult(j.id, "/dest/path/SH020_IMG_001.png", "SH020_IMG_001.png");

    const create = vi.fn();
    notifyJobsUpdated(manager, { create, clear: vi.fn() });

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toBe("aias-single");
  });

  it("switches to the batch toast once 2+ jobs are active", async () => {
    const manager = await JobManager.create({
      loadPersistedIndexCounters: vi.fn(async () => ({})),
      persistIndexCounters: vi.fn(),
      generateJobId: vi.fn((() => {
        let n = 0;
        return () => `job-${n++}`;
      })()),
    });
    manager.detectJob({
      browserDownloadId: 1,
      originalFilename: "a.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      session: session(),
      cachedRootForDisplay: "",
    });
    manager.detectJob({
      browserDownloadId: 2,
      originalFilename: "b.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      session: session(),
      cachedRootForDisplay: "",
    });

    const create = vi.fn();
    notifyJobsUpdated(manager, { create, clear: vi.fn() });

    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toBe("aias-batch");
  });
});
