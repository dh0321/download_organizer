// §11 Organize Flow notification. Under the old immediate-move flow, downloads
// trickled in and completed independently, so this module tracked an
// in-flight job list and picked single-vs-batch toast wording. Under Organize,
// there is exactly one request/response per click — so this only needs to
// summarize the one organize-batch-result that just came back. Uses
// chrome.notifications so the summary reaches the user even if the Inbox tab
// isn't open.

import type { OrganizeBatchItemResult } from "@download-organizer/shared";

const ORGANIZE_RESULT_NOTIFICATION_ID = "aias-organize-result";

export function formatOrganizeResultMessage(results: OrganizeBatchItemResult[]): { title: string; message: string } {
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  if (failed === 0) {
    return {
      title: `${succeeded} asset${succeeded === 1 ? "" : "s"} organized`,
      message: "Files were moved into your project folders.",
    };
  }
  if (succeeded === 0) {
    return {
      title: `Organize failed for ${failed} asset${failed === 1 ? "" : "s"}`,
      message: "Open the Inbox to see what went wrong and retry.",
    };
  }
  return {
    title: `${succeeded} organized, ${failed} failed`,
    message: "The failed items are still in the Inbox — fix and retry.",
  };
}

export interface NotifierDeps {
  create(id: string, options: chrome.notifications.NotificationOptions<true>): void;
}

const chromeNotifierDeps: NotifierDeps = {
  create: (id, options) => chrome.notifications.create(id, options),
};

export function notifyOrganizeResult(results: OrganizeBatchItemResult[], deps: NotifierDeps = chromeNotifierDeps): void {
  if (results.length === 0) return;
  const { title, message } = formatOrganizeResultMessage(results);
  deps.create(ORGANIZE_RESULT_NOTIFICATION_ID, {
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
