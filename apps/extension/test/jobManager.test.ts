import { describe, it, expect, vi } from "vitest";
import { JobManager } from "../src/background/jobManager.js";
import type { SessionState } from "@ai-asset-saver/shared";

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    aiSessionEnabled: true,
    currentProject: "Galaxy_S27",
    currentSequence: "SQ010",
    currentShot: "SH020",
    currentBucketId: "generated",
    currentDescription: "woman red dress closeup",
    selectedNamingPresetId: "default",
    customFilenameEnabled: false,
    customFilename: "",
    lastIndexByKey: {},
    ...overrides,
  };
}

function makeDeps() {
  let nextId = 0;
  const persisted: Record<string, number>[] = [];
  return {
    deps: {
      loadPersistedIndexCounters: vi.fn(async () => ({})),
      persistIndexCounters: vi.fn((snapshot: Record<string, number>) => {
        persisted.push(snapshot);
      }),
      generateJobId: vi.fn(() => `job-${nextId++}`),
    },
    persisted,
  };
}

describe("JobManager", () => {
  it("assigns unique, sequential indices for 5 near-simultaneous detections (§F-1)", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);

    const jobs = [1, 2, 3, 4, 5].map(() =>
      manager.detectJob({
        browserDownloadId: 100,
        originalFilename: "x.png",
        extension: ".png",
        mediaType: "image",
        source: "chatgpt",
        session: session(),
        cachedRootForDisplay: "D:\\AI_Projects",
      }),
    );

    expect(jobs.map((j) => j.reservedIndex)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(5);
  });

  it("keeps each job's reservedIndex fixed no matter what order they later complete in", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const jobs = [1, 2, 3, 4, 5].map(() =>
      manager.detectJob({
        browserDownloadId: 1,
        originalFilename: "x.mov",
        extension: ".mov",
        mediaType: "video",
        source: "gemini",
        session: session(),
        cachedRootForDisplay: "",
      }),
    );

    // Simulate completion arriving out of order: 025, 023, 027, 024, 026 pattern.
    const completionOrder = [jobs[2], jobs[0], jobs[4], jobs[1], jobs[3]];
    for (const job of completionOrder) {
      manager.setStatus(job.id, "saved");
    }

    expect(manager.get(jobs[0].id)?.reservedIndex).toBe(1);
    expect(manager.get(jobs[2].id)?.reservedIndex).toBe(3);
    expect(manager.get(jobs[4].id)?.reservedIndex).toBe(5);
    expect(manager.allJobs().every((j) => j.status === "saved")).toBe(true);
  });

  it("freezes a Session Snapshot at detection time — later SessionState mutation does not affect it", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const liveSession = session({ currentProject: "OriginalProject", currentDescription: "original desc" });

    const job = manager.detectJob({
      browserDownloadId: 1,
      originalFilename: "x.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      session: liveSession,
      cachedRootForDisplay: "",
    });

    // User changes Project/Description in the popup mid-flight.
    liveSession.currentProject = "ChangedProject";
    liveSession.currentDescription = "changed desc";

    expect(job.sessionSnapshot.project).toBe("OriginalProject");
    expect(job.sessionSnapshot.description).toBe("original desc");
  });

  it("does not reuse the reservedIndex of a cancelled job (index gap policy)", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);
    const s = session();

    const job1 = manager.detectJob({
      browserDownloadId: 1,
      originalFilename: "a.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      session: s,
      cachedRootForDisplay: "",
    });
    const job2 = manager.detectJob({
      browserDownloadId: 2,
      originalFilename: "b.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      session: s,
      cachedRootForDisplay: "",
    });
    manager.setStatus(job2.id, "cancelled");

    const job3 = manager.detectJob({
      browserDownloadId: 3,
      originalFilename: "c.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      session: s,
      cachedRootForDisplay: "",
    });

    expect(job1.reservedIndex).toBe(1);
    expect(job2.reservedIndex).toBe(2);
    expect(job3.reservedIndex).toBe(3); // not re-issued as 2, even though job2 was cancelled
  });

  it("tracks independent counters per project/sequence/shot/bucket/mediaType key", async () => {
    const { deps } = makeDeps();
    const manager = await JobManager.create(deps);

    const jobShotA = manager.detectJob({
      browserDownloadId: 1,
      originalFilename: "a.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      session: session({ currentShot: "SH010" }),
      cachedRootForDisplay: "",
    });
    const jobShotB = manager.detectJob({
      browserDownloadId: 2,
      originalFilename: "b.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      session: session({ currentShot: "SH020" }),
      cachedRootForDisplay: "",
    });

    expect(jobShotA.reservedIndex).toBe(1);
    expect(jobShotB.reservedIndex).toBe(1); // independent key, starts at 1 too
  });

  it("restores index counters from a persisted checkpoint after a simulated service worker restart", async () => {
    const { deps: firstRunDeps } = makeDeps();
    const manager1 = await JobManager.create(firstRunDeps);
    manager1.detectJob({
      browserDownloadId: 1,
      originalFilename: "a.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      session: session(),
      cachedRootForDisplay: "",
    });

    const lastPersisted = firstRunDeps.persistIndexCounters.mock.calls.at(-1)?.[0];

    const manager2 = await JobManager.create({
      loadPersistedIndexCounters: vi.fn(async () => lastPersisted),
      persistIndexCounters: vi.fn(),
      generateJobId: vi.fn(() => "job-restart"),
    });
    const job = manager2.detectJob({
      browserDownloadId: 2,
      originalFilename: "b.png",
      extension: ".png",
      mediaType: "image",
      source: "chatgpt",
      session: session(),
      cachedRootForDisplay: "",
    });

    expect(job.reservedIndex).toBe(2); // continues from 1, not reset to 1
  });
});
