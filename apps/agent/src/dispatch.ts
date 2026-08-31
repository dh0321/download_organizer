// Routes a decoded NativeRequest to the right handler. Deliberately separate from
// the stdio framing (see stdio.ts) so this dispatch logic is unit-testable without
// spinning up real process streams. This function IS the Agent's entire API
// surface (§F-2 Minimum Privilege) — there is no other way for a request to cause
// a filesystem operation.

import type { NativeRequest, NativeResponse } from "@ai-asset-saver/shared";
import type { AgentConfigStore } from "./agentConfig.js";
import type { JobWorkerPool } from "./jobQueue.js";
import { handleRouteFile } from "./routeFile.js";
import { getMaxIndex } from "./getMaxIndex.js";

export interface DispatchDeps {
  configStore: AgentConfigStore;
  jobQueue: JobWorkerPool;
}

export async function dispatch(deps: DispatchDeps, req: NativeRequest): Promise<NativeResponse> {
  switch (req.type) {
    case "ping":
      return { type: "pong" };

    case "get-settings": {
      const { allowedExtensionId: _allowedExtensionId, ...settings } = deps.configStore.get();
      return { type: "get-settings-result", settings };
    }

    case "sync-settings": {
      await deps.configStore.applySyncSettings(req.settings);
      return { type: "sync-settings-result", ok: true };
    }

    case "get-max-index": {
      const maxIndex = await getMaxIndex(deps.configStore.get(), req.naming);
      return { type: "get-max-index-result", maxIndex };
    }

    case "route-file": {
      // Routed through the concurrency-limited worker pool (§F-1 Processing Queue) —
      // never executed inline, so a burst of route-file requests never runs more
      // filesystem operations at once than maxConcurrentFileOps allows.
      return deps.jobQueue.submit(() => handleRouteFile(deps.configStore.get(), req));
    }
  }
}
