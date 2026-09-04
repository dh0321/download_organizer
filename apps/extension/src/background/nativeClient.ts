// §D native-client — wraps chrome.runtime.connectNative, correlating requests to
// responses so multiple route-file requests can be in flight at once (§F-1).
// `connectNativeFn` is injected so this class is unit-testable without a real
// Chrome runtime (see test/nativeClient.test.ts) — defaults to the real API.

import type { NativeRequest, NativeResponse } from "@ai-asset-saver/shared";

export const NATIVE_HOST_NAME = "com.ai_asset_saver.agent";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface NativePort {
  postMessage(message: NativeRequest): void;
  onMessage: { addListener(cb: (msg: NativeResponse) => void): void };
  /** errorMessage carries chrome.runtime.lastError.message when the disconnect
   * was caused by a connection failure (e.g. "Specified native messaging host
   * not found") — see defaultConnectNative for why reading it matters. */
  onDisconnect: { addListener(cb: (errorMessage?: string) => void): void };
}

type ConnectNativeFn = (hostName: string) => NativePort;

interface PendingEntry {
  resolve: (r: NativeResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Chrome sets `chrome.runtime.lastError` when a native-messaging connection
 * fails (e.g. the host isn't installed/registered yet) and only clears the
 * "Unchecked runtime.lastError" console warning if something actually reads
 * `.message` — so this wrapper always reads it inside the onDisconnect
 * callback (the only point at which it's valid) and threads it through to our
 * own NativePort abstraction instead of leaving it unread.
 */
function defaultConnectNative(hostName: string): NativePort {
  const port = chrome.runtime.connectNative(hostName);
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: { addListener: (cb) => port.onMessage.addListener(cb as (msg: unknown) => void) },
    onDisconnect: {
      addListener: (cb) =>
        port.onDisconnect.addListener(() => {
          cb(chrome.runtime.lastError?.message);
        }),
    },
  };
}

export class NativeClientDisconnectedError extends Error {}

/**
 * §D — one instance per Extension lifetime. Reconnects lazily on the next send()
 * after a disconnect, rather than eagerly retrying in the background, so an idle
 * AI Session OFF period never keeps attempting a connection (§F-2 Safety Boundary).
 */
type OrganizeProgressListener = (completed: number, total: number) => void;

export class NativeClient {
  private port: NativePort | null = null;
  private pendingByJobId = new Map<string, PendingEntry>();
  private pendingByType = new Map<NativeResponse["type"], PendingEntry[]>();
  private organizeProgressListeners = new Set<OrganizeProgressListener>();

  constructor(private readonly connectNativeFn: ConnectNativeFn = defaultConnectNative) {}

  /** "organize-progress" is an unsolicited push from the Agent (see
   * dispatch.ts's organize-batch case), not a response to any particular
   * send() call — subscribe here instead. Returns an unsubscribe function. */
  onOrganizeProgress(cb: OrganizeProgressListener): () => void {
    this.organizeProgressListeners.add(cb);
    return () => this.organizeProgressListeners.delete(cb);
  }

  private ensureConnected(): NativePort {
    if (this.port) return this.port;
    const port = this.connectNativeFn(NATIVE_HOST_NAME);
    port.onMessage.addListener((msg) => this.handleMessage(msg));
    port.onDisconnect.addListener((errorMessage) => this.handleDisconnect(errorMessage));
    this.port = port;
    return port;
  }

  private handleDisconnect(errorMessage?: string): void {
    this.port = null;
    const err = new NativeClientDisconnectedError(
      errorMessage ? `Native Messaging host disconnected: ${errorMessage}` : "Native Messaging host disconnected",
    );
    for (const entry of this.pendingByJobId.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pendingByJobId.clear();
    for (const entries of this.pendingByType.values()) {
      for (const entry of entries) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
    }
    this.pendingByType.clear();
  }

  private handleMessage(msg: NativeResponse): void {
    if (msg.type === "organize-progress") {
      // Never touches pendingByJobId/pendingByType — this isn't a response to
      // any awaited send() call, just a push notification for anyone listening.
      for (const cb of this.organizeProgressListeners) cb(msg.completed, msg.total);
      return;
    }

    if (msg.type === "route-file-result") {
      const entry = this.pendingByJobId.get(msg.jobId);
      if (!entry) return; // no longer awaited (e.g. timed out already) — drop silently
      this.pendingByJobId.delete(msg.jobId);
      clearTimeout(entry.timer);
      entry.resolve(msg);
      return;
    }

    const queue = this.pendingByType.get(msg.type);
    const entry = queue?.shift();
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.resolve(msg);
  }

  private awaitJobResponse(jobId: string, timeoutMs: number): Promise<NativeResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingByJobId.delete(jobId);
        reject(new Error(`Timed out waiting for route-file-result (jobId=${jobId})`));
      }, timeoutMs);
      this.pendingByJobId.set(jobId, { resolve, reject, timer });
    });
  }

  private awaitTypedResponse(responseType: NativeResponse["type"], timeoutMs: number): Promise<NativeResponse> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this.pendingByType.get(responseType);
        if (queue) {
          const idx = queue.findIndex((e) => e.resolve === resolve);
          if (idx >= 0) queue.splice(idx, 1);
        }
        reject(new Error(`Timed out waiting for ${responseType}`));
      }, timeoutMs);
      const entry: PendingEntry = { resolve, reject, timer };
      const queue = this.pendingByType.get(responseType) ?? [];
      queue.push(entry);
      this.pendingByType.set(responseType, queue);
    });
  }

  send(request: NativeRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<NativeResponse> {
    const port = this.ensureConnected();

    const waitPromise =
      request.type === "route-file"
        ? this.awaitJobResponse(request.jobId, timeoutMs)
        : this.awaitTypedResponse(responseTypeFor(request.type), timeoutMs);

    port.postMessage(request);
    return waitPromise;
  }

  disconnectForTesting(): void {
    this.handleDisconnect();
  }
}

function responseTypeFor(requestType: NativeRequest["type"]): NativeResponse["type"] {
  switch (requestType) {
    case "ping":
      return "pong";
    case "get-settings":
      return "get-settings-result";
    case "sync-settings":
      return "sync-settings-result";
    case "get-max-index":
      return "get-max-index-result";
    case "route-file":
      return "route-file-result";
    case "organize-batch":
      return "organize-batch-result";
    case "pick-directory":
      return "pick-directory-result";
    case "list-downloads-folder":
      return "list-downloads-folder-result";
  }
}
