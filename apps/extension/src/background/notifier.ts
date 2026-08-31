// §D notifier / §F-1 Batch UI — single toast for one job, aggregated toast once 2+
// jobs are in flight. Uses chrome.notifications so it doesn't depend on the popup
// being open (§16 UI principle: don't force a popup open on every download).

import type { DownloadJob } from "@ai-asset-saver/shared";
import type { JobManager } from "./jobManager.js";

const SINGLE_NOTIFICATION_ID = "aias-single";
const BATCH_NOTIFICATION_ID = "aias-batch";

function isTerminal(job: DownloadJob): boolean {
  return job.status === "saved" || job.status === "failed" || job.status === "cancelled";
}

export function formatSingleSavedMessage(job: DownloadJob): { title: string; message: string } {
  const s = job.sessionSnapshot;
  const breadcrumb = [s.project, s.sequence, s.shot].filter(Boolean).join(" / ");
  return {
    title: "Saved",
    message: `${job.finalFilename ?? job.originalFilename}\n${breadcrumb}`,
  };
}

export function formatBatchMessage(jobs: DownloadJob[]): { title: string; message: string } {
  const saved = jobs.filter((j) => j.status === "saved").length;
  const downloading = jobs.filter((j) => j.status === "downloading" || j.status === "detected" || j.status === "queued").length;
  const moving = jobs.filter((j) => j.status === "moving" || j.status === "downloaded").length;
  const failed = jobs.filter((j) => j.status === "failed").length;
  const allDone = jobs.every(isTerminal);

  if (allDone) {
    const failedSuffix = failed > 0 ? ` (${failed} failed)` : "";
    return { title: `${jobs.length} assets processed${failedSuffix}`, message: `${saved} saved${failedSuffix}` };
  }

  const parts = [`${saved} saved`];
  if (moving > 0) parts.push(`${moving} downloading`);
  if (downloading > 0) parts.push(`${downloading} queued`);
  return { title: `Saving ${jobs.length} AI assets...`, message: parts.join(" · ") };
}

export interface NotifierDeps {
  create(id: string, options: chrome.notifications.NotificationOptions<true>): void;
  clear(id: string): void;
}

const chromeNotifierDeps: NotifierDeps = {
  create: (id, options) => chrome.notifications.create(id, options),
  clear: (id) => chrome.notifications.clear(id),
};

/**
 * Call after every job status transition. Batches automatically once 2+ jobs are
 * active in the same short window — never spams one toast per file (§16, §F-1).
 */
export function notifyJobsUpdated(jobManager: JobManager, deps: NotifierDeps = chromeNotifierDeps): void {
  const jobs = jobManager.allJobs();
  const recentJobs = jobs.filter((j) => Date.now() - j.detectedAt < 60_000); // ignore stale history

  if (recentJobs.length <= 1) {
    const job = recentJobs[0];
    if (job && job.status === "saved") {
      const { title, message } = formatSingleSavedMessage(job);
      deps.create(SINGLE_NOTIFICATION_ID, {
        type: "basic",
        iconUrl: "icon-128.png",
        title,
        message,
      });
    }
    return;
  }

  const { title, message } = formatBatchMessage(recentJobs);
  deps.create(BATCH_NOTIFICATION_ID, {
    type: "basic",
    iconUrl: "icon-128.png",
    title,
    message,
  });
}

export function notifyError(title: string, message: string, deps: NotifierDeps = chromeNotifierDeps): void {
  deps.create(`aias-error-${Date.now()}`, {
    type: "basic",
    iconUrl: "icon-128.png",
    title,
    message,
  });
}
