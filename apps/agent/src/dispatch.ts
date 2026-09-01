// Routes a decoded NativeRequest to the right handler. Deliberately separate from
// the stdio framing (see stdio.ts) so this dispatch logic is unit-testable without
// spinning up real process streams. This function IS the Agent's entire API
// surface (§F-2 Minimum Privilege) — there is no other way for a request to cause
// a filesystem operation.

import type { NativeRequest, NativeResponse, OrganizeBatchItemResult } from "@ai-asset-saver/shared";
import type { AgentConfigStore } from "./agentConfig.js";
import type { JobWorkerPool } from "./jobQueue.js";
import { handleRouteFile } from "./routeFile.js";
import { getMaxIndex } from "./getMaxIndex.js";
import { pickDirectory } from "./directoryPicker.js";
import { listDownloadsFolder } from "./listDownloadsFolder.js";

export interface DispatchDeps {
  configStore: AgentConfigStore;
  jobQueue: JobWorkerPool;
  /** Injectable only for tests, so they don't depend on the real machine's
   * ~/Downloads contents (see routeFile.ts's assertWithinDownloads). Omit in
   * production to use the real OS default. */
  downloadsRoot?: string;
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
      return deps.jobQueue.submit(() => handleRouteFile(deps.configStore.get(), req, deps.downloadsRoot));
    }

    case "organize-batch": {
      // §11 Organize Flow: one request covering every selected Pending Asset.
      // Each item is really just a "route-file" — reuse handleRouteFile as-is
      // (same worker-pool concurrency limit, same Failure Isolation: a rejection
      // from one item can never affect another since handleRouteFile always
      // resolves, never rejects, even on error).
      const results: OrganizeBatchItemResult[] = await Promise.all(
        req.items.map(async (item) => {
          const result = await deps.jobQueue.submit(() =>
            handleRouteFile(
              deps.configStore.get(),
              {
                type: "route-file",
                jobId: item.jobId,
                sourcePath: item.sourcePath,
                extension: item.extension,
                mediaType: item.mediaType,
                source: item.source,
                reservedIndex: item.reservedIndex,
                naming: item.naming,
              },
              deps.downloadsRoot,
            ),
          );
          return result.ok
            ? { jobId: item.jobId, ok: true as const, finalPath: result.finalPath }
            : { jobId: item.jobId, ok: false as const, error: result.error, code: result.code };
        }),
      );
      return { type: "organize-batch-result", results };
    }

    case "pick-directory": {
      try {
        const path = await pickDirectory();
        return { type: "pick-directory-result", ok: true, path };
      } catch (e) {
        return { type: "pick-directory-result", ok: false, error: (e as Error).message };
      }
    }

    case "list-downloads-folder": {
      try {
        const files = await listDownloadsFolder(deps.downloadsRoot);
        return { type: "list-downloads-folder-result", ok: true, files };
      } catch (e) {
        return { type: "list-downloads-folder-result", ok: false, error: (e as Error).message };
      }
    }
  }
}
