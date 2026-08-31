// §F-1 job-manager: creates a DownloadJob synchronously at detection time, capturing
// a SessionSnapshot and reserving an index before any `await` runs — this is what
// makes concurrent detections race-free (see IndexReservationCounter in
// @ai-asset-saver/shared for the full argument).

import {
  IndexReservationCounter,
  buildIndexKey,
  type DownloadJob,
  type DownloadJobStatus,
  type SessionState,
  type SessionSnapshot,
  type MediaType,
} from "@ai-asset-saver/shared";

export interface JobManagerDeps {
  loadPersistedIndexCounters(): Promise<Record<string, number>>;
  /** Fire-and-forget — never awaited from inside detectJob (must stay synchronous). */
  persistIndexCounters(snapshot: Record<string, number>): void;
  generateJobId(): string;
}

export interface DetectJobParams {
  browserDownloadId: number;
  originalFilename: string;
  extension: string;
  mediaType: MediaType;
  source: string;
  session: SessionState;
  /** display-only cached root, for RecentActivity/audit purposes — never used for
   * actual routing, which is always the Agent's own live AgentConfig.defaultRoot. */
  cachedRootForDisplay: string;
}

function captureSnapshot(session: SessionState, cachedRootForDisplay: string): SessionSnapshot {
  return {
    root: cachedRootForDisplay,
    project: session.currentProject,
    sequence: session.currentSequence,
    shot: session.currentShot,
    bucketId: session.currentBucketId,
    description: session.currentDescription,
    namingPresetId: session.selectedNamingPresetId,
    customFilenameEnabled: session.customFilenameEnabled,
    customFilename: session.customFilename,
  };
}

export class JobManager {
  private readonly counter: IndexReservationCounter;
  private readonly jobs = new Map<string, DownloadJob>();

  private constructor(
    private readonly deps: JobManagerDeps,
    initialCounters: Record<string, number>,
  ) {
    this.counter = new IndexReservationCounter(initialCounters);
  }

  static async create(deps: JobManagerDeps): Promise<JobManager> {
    const initial = await deps.loadPersistedIndexCounters();
    return new JobManager(deps, initial);
  }

  /**
   * Must be called synchronously from within the onDeterminingFilename handler,
   * with no `await` beforehand — this is the entire race-freedom guarantee (§F-1).
   */
  detectJob(params: DetectJobParams): DownloadJob {
    const snapshot = captureSnapshot(params.session, params.cachedRootForDisplay);

    const key = buildIndexKey({
      project: snapshot.project,
      sequence: snapshot.sequence,
      shot: snapshot.shot,
      bucketId: snapshot.bucketId,
      mediaType: params.mediaType,
    });
    const reservedIndex = this.counter.reserveNext(key);
    this.deps.persistIndexCounters(this.counter.snapshot()); // async persistence, not awaited here

    const job: DownloadJob = {
      id: this.deps.generateJobId(),
      browserDownloadId: params.browserDownloadId,
      originalFilename: params.originalFilename,
      extension: params.extension,
      mediaType: params.mediaType,
      source: params.source,
      detectedAt: Date.now(),
      sessionSnapshot: snapshot,
      reservedIndex,
      status: "detected",
    };

    this.jobs.set(job.id, job);
    return job;
  }

  get(jobId: string): DownloadJob | undefined {
    return this.jobs.get(jobId);
  }

  getByBrowserDownloadId(browserDownloadId: number): DownloadJob | undefined {
    for (const job of this.jobs.values()) {
      if (job.browserDownloadId === browserDownloadId) return job;
    }
    return undefined;
  }

  /**
   * Transitions a job's status. Each job's status is independent of every other
   * job's (§F-1 Failure Isolation) — this never touches any job but the one named.
   */
  setStatus(jobId: string, status: DownloadJobStatus, error?: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = status;
    if (error !== undefined) job.error = error;
  }

  setResult(jobId: string, finalPath: string, finalFilename: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.destinationPath = finalPath;
    job.finalFilename = finalFilename;
    job.status = "saved";
  }

  allJobs(): DownloadJob[] {
    return Array.from(this.jobs.values());
  }

  activeJobCount(): number {
    return this.allJobs().filter((j) => !["saved", "failed", "cancelled"].includes(j.status)).length;
  }
}
