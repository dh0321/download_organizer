// Background service worker entrypoint — wires session state (now just AI
// Session + Batch Defaults, §2/§8), Pending Asset registration, native
// messaging, and the Organize flow together. See the Download → Inbox →
// Edit → Organize plan.
//
// IMPORTANT: every chrome.*.addListener(...) call in this file happens
// synchronously during the module's top-level evaluation — none of them are
// behind an `await`. MV3 only guarantees an event isn't missed if the listener
// was registered before the service worker's initial script evaluation
// finishes; registering a listener inside an async function that hasn't
// resolved yet leaves a real gap where an early message/download/click can
// arrive with no listener present.

import type { NamingFields } from "@ai-asset-saver/shared";
import { loadSessionState, DEFAULT_SESSION_STATE } from "./sessionManager.js";
import { JobManager } from "./jobManager.js";
import { IntentPingStore } from "./intentPingStore.js";
import { NativeClient } from "./nativeClient.js";
import { registerDownloadListeners } from "./downloadListener.js";
import { scanDownloadsFolder, importRescanCandidates } from "./rescanDownloads.js";
import { runOrganizeFlow } from "./organizeFlow.js";
import { notifyOrganizeResult, notifyError } from "./notifier.js";
import { loadPendingAssets, persistPendingAssets } from "./pendingAssetsStorage.js";
import { loadOrganizeLog, persistOrganizeLog } from "./organizeLogStorage.js";
import { SESSION_STORAGE_KEY, INDEX_COUNTERS_STORAGE_KEY } from "./storageKeys.js";

const intentPingStore = new IntentPingStore();
const nativeClient = new NativeClient();

// A synchronous, in-memory mirror of SessionState kept up to date via the
// storage listener below — onDeterminingFilename must read this synchronously
// (no await), per §F hard-boundary requirement.
let sessionSnapshotCache = DEFAULT_SESSION_STATE;
void loadSessionState().then((s) => {
  sessionSnapshotCache = s;
});

async function loadPersistedIndexCounters(): Promise<Record<string, number>> {
  const result = await chrome.storage.local.get(INDEX_COUNTERS_STORAGE_KEY);
  return (result[INDEX_COUNTERS_STORAGE_KEY] as Record<string, number> | undefined) ?? {};
}

function persistIndexCounters(snapshot: Record<string, number>): void {
  // Fire-and-forget on purpose — never awaited from inside reserveIndexForOrganize (§F-1).
  void chrome.storage.local.set({ [INDEX_COUNTERS_STORAGE_KEY]: snapshot });
}

// Created synchronously (not awaited here) — see downloadListener.ts for how
// listeners registered before this resolves still handle events correctly.
const jobManagerPromise: Promise<JobManager> = JobManager.create({
  loadPendingAssets,
  persistPendingAssets,
  loadPersistedIndexCounters,
  persistIndexCounters,
  loadOrganizeLog,
  persistOrganizeLog,
  generateJobId: () => crypto.randomUUID(),
});

function updateBadge(jm: JobManager): void {
  const count = jm.organizableAssets().length;
  void chrome.action.setBadgeText({ text: count > 0 ? String(count) : "" });
  void chrome.action.setBadgeBackgroundColor({ color: "#18181b" });
}

void jobManagerPromise.then(updateBadge); // restore the badge after a browser/SW restart

/** A brand-new Pending Asset starts pre-filled from the current Batch
 * Defaults (§8) — Shot/Description start empty (only ever set per-asset) and
 * Custom Folder/Filename start off (Auto). */
function buildDefaultNaming(): NamingFields {
  return {
    project: sessionSnapshotCache.batchDefaultProject,
    sequence: sessionSnapshotCache.batchDefaultSequence,
    shot: "",
    bucketId: sessionSnapshotCache.batchDefaultBucketId,
    description: "",
    namingPresetId: "default",
    namingTemplate: "{shot}_{type}_{description}_{index}", // Phase 1: single built-in preset (§O)
    customFilenameEnabled: false,
    customFilename: "",
    customDirectoryEnabled: false,
    customDirectory: "",
  };
}

registerDownloadListeners({
  jobManagerPromise,
  intentPingStore,
  getSession: () => sessionSnapshotCache,
  buildDefaultNaming,
  onAssetRegistered: () => {
    void jobManagerPromise.then(updateBadge);
  },
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "aias-intent-ping") {
    intentPingStore.record(message.origin, message.timestamp);
    return; // no response expected
  }

  if (message?.type === "aias-get-display-settings") {
    // Inbox's Default Root display only — never the source of truth for routing (§F-2).
    nativeClient
      .send({ type: "get-settings" })
      .then((res) => {
        if (res.type === "get-settings-result") {
          sendResponse({ ok: true, settings: res.settings });
        } else {
          sendResponse({ ok: false, error: "unexpected response" });
        }
      })
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // keep the message channel open for the async sendResponse
  }

  if (message?.type === "aias-set-default-root") {
    nativeClient
      .send({ type: "get-settings" })
      .then((current) => {
        if (current.type !== "get-settings-result") throw new Error("unexpected response");
        return nativeClient.send({
          type: "sync-settings",
          settings: { ...current.settings, defaultRoot: message.root },
        });
      })
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === "aias-ping-agent") {
    nativeClient
      .send({ type: "ping" }, 3000)
      .then(() => sendResponse({ connected: true }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }

  if (message?.type === "aias-pick-directory") {
    // Long timeout: this is waiting on a human clicking through a native OS
    // dialog, not a normal fast round-trip.
    nativeClient
      .send({ type: "pick-directory" }, 5 * 60 * 1000)
      .then((res) => {
        if (res.type === "pick-directory-result") sendResponse(res);
        else sendResponse({ type: "pick-directory-result", ok: false, error: "unexpected response" });
      })
      .catch((err) => sendResponse({ type: "pick-directory-result", ok: false, error: String(err) }));
    return true;
  }

  if (message?.type === "aias-update-naming") {
    void jobManagerPromise.then((jm) => {
      jm.updateNaming(message.id, message.patch);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "aias-update-source") {
    void jobManagerPromise.then((jm) => {
      jm.updateSource(message.id, message.source);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "aias-set-selected") {
    void jobManagerPromise.then((jm) => {
      jm.setSelected(message.id, message.selected);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "aias-set-all-selected") {
    void jobManagerPromise.then((jm) => {
      jm.setAllSelected(message.selected);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "aias-set-selected-many") {
    void jobManagerPromise.then((jm) => {
      jm.setSelectedByIds(message.ids, message.selected);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "aias-apply-defaults-to-selected") {
    void jobManagerPromise.then((jm) => {
      jm.applyDefaultsToSelected(message.defaults);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "aias-organize") {
    void jobManagerPromise.then(async (jm) => {
      const result = await runOrganizeFlow(
        { jobManager: jm, sendToAgent: (req, timeoutMs) => nativeClient.send(req, timeoutMs) },
        message.ids,
      );
      updateBadge(jm);
      if (result.ok && result.results) {
        notifyOrganizeResult(result.results);
      } else if (!result.ok) {
        notifyError("Couldn't organize assets", result.error ?? "Unknown error");
      }
      sendResponse(result);
    });
    return true;
  }

  if (message?.type === "aias-rescan-scan") {
    void jobManagerPromise.then(async (jm) => {
      try {
        const result = await scanDownloadsFolder(jm, (req) => nativeClient.send(req));
        sendResponse(result);
      } catch (err) {
        // Without this, a native-message failure (e.g. timeout, Local App not
        // running) would leave sendResponse uncalled and the Inbox stuck on
        // "Scanning…" forever — every other native-messaging handler in this
        // file already guards against exactly this.
        sendResponse({ error: String(err) });
      }
    });
    return true;
  }

  if (message?.type === "aias-rescan-import") {
    void jobManagerPromise.then(async (jm) => {
      const result = importRescanCandidates(jm, message.candidates, buildDefaultNaming);
      updateBadge(jm);
      sendResponse(result);
    });
    return true;
  }

  if (message?.type === "aias-prune-organized") {
    // Auto-cleanup trigger: fired once by the Inbox page on every fresh
    // load/reload, never from a timer — see JobManager.pruneOrganizedIntoLog.
    void jobManagerPromise.then((jm) => {
      jm.pruneOrganizedIntoLog();
      updateBadge(jm);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "aias-empty-inbox") {
    void jobManagerPromise.then((jm) => {
      jm.emptyInbox();
      updateBadge(jm);
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message?.type === "aias-remove-asset") {
    void jobManagerPromise.then((jm) => {
      jm.removeAsset(message.id);
      updateBadge(jm);
      sendResponse({ ok: true });
    });
    return true;
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[SESSION_STORAGE_KEY]) {
    sessionSnapshotCache = { ...DEFAULT_SESSION_STATE, ...changes[SESSION_STORAGE_KEY].newValue };
  }
});
