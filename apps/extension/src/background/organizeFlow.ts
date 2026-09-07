// §11 Organize Flow orchestrator — the one place that turns selected Pending
// Assets into a single organize-batch Native Messaging request. Kept separate
// from background/index.ts's message-passing wiring so the two-phase
// "await every distinct destination's list-destination-files round trip,
// THEN reserve indices synchronously with no `await` in between" sequencing
// (§F-1) is unit-testable without a real chrome.runtime/native host.

import { pickAvailableIndex, type NativeRequest, type NativeResponse, type OrganizeBatchItem, type OrganizeBatchItemResult, type PendingAsset } from "@download-organizer/shared";
import { JobManager, pendingAssetIndexKey } from "./jobManager.js";

export interface OrganizeFlowDeps {
  jobManager: JobManager;
  sendToAgent(req: NativeRequest, timeoutMs?: number): Promise<NativeResponse>;
}

export interface OrganizeFlowResult {
  ok: boolean;
  results?: OrganizeBatchItemResult[];
  error?: string;
}

/** Thin adapter from a PendingAsset to shared naming.ts's pickAvailableIndex
 * — also used, independently, by the Inbox's live preview (App.tsx) against
 * a listing fetched on demand instead of this batch's real one. */
function reserveIndexForAsset(asset: PendingAsset, takenFilenames: Set<string>): number {
  const { naming, extension, source } = asset;
  if (naming.customFilenameEnabled) return 1;
  return pickAvailableIndex(
    naming.namingTemplate,
    { project: naming.project, sequence: naming.sequence, shot: naming.shot, description: naming.description, type: "", source },
    extension,
    takenFilenames,
  );
}

/** organize-batch moves real files (large videos especially, on possibly slow
 * or networked destinations) — the generic default timeout (see
 * nativeClient.ts's DEFAULT_TIMEOUT_MS, sized for quick metadata round trips)
 * is nowhere near enough for that. Scaled by item count so a big batch gets
 * proportionally more time; a fast image batch just never comes close to
 * hitting it. */
function organizeBatchTimeoutMs(itemCount: number): number {
  const BASE_MS = 60_000;
  const PER_ITEM_MS = 60_000;
  return BASE_MS + itemCount * PER_ITEM_MS;
}

export async function runOrganizeFlow(deps: OrganizeFlowDeps, assetIds: string[]): Promise<OrganizeFlowResult> {
  const { jobManager } = deps;
  const assets = assetIds
    .map((id) => jobManager.get(id))
    .filter((a): a is PendingAsset => !!a && (a.status === "pending" || a.status === "failed"));

  if (assets.length === 0) return { ok: true, results: [] };

  // Step 1 (§11): ask the Agent for every distinct destination's real current
  // file listing BEFORE reserving anything — the only point `await` is
  // allowed, since no index has been handed out yet and nothing is marked
  // "organizing". This doubles as the up-front Agent-connectivity check
  // (§12): if the Agent is unreachable, it fails here, before touching any
  // asset's status.
  const representativeByKey = new Map<string, PendingAsset>();
  for (const asset of assets) {
    const key = pendingAssetIndexKey(asset);
    if (!representativeByKey.has(key)) representativeByKey.set(key, asset);
  }

  const takenFilenamesByKey = new Map<string, Set<string>>();
  try {
    await Promise.all(
      Array.from(representativeByKey.entries()).map(async ([key, representative]) => {
        const res = await deps.sendToAgent({
          type: "list-destination-files",
          naming: {
            project: representative.naming.project,
            sequence: representative.naming.sequence,
            shot: representative.naming.shot,
            bucketId: representative.naming.bucketId,
            customFolderName: representative.naming.customFolderName,
            customDirectoryEnabled: representative.naming.customDirectoryEnabled,
            customDirectory: representative.naming.customDirectory,
          },
        });
        if (res.type === "list-destination-files-result") {
          takenFilenamesByKey.set(key, new Set(res.files));
        }
      }),
    );
  } catch (err) {
    return { ok: false, error: `Agent unreachable: ${(err as Error).message}` };
  }

  // Step 2 (§11): reserve indices synchronously, no `await` between calls —
  // the same race-free technique index reservation has always used (§F-1),
  // just resolved against each destination's real (just-fetched) file
  // listing instead of a counter carried over from earlier sessions.
  for (const asset of assets) {
    jobManager.setStatus(asset.id, "organizing");
  }
  const items: OrganizeBatchItem[] = assets.map((asset) => {
    const takenFilenames = takenFilenamesByKey.get(pendingAssetIndexKey(asset)) ?? new Set<string>();
    return {
      jobId: asset.id,
      sourcePath: asset.sourcePath,
      extension: asset.extension,
      mediaType: asset.mediaType,
      source: asset.source,
      reservedIndex: reserveIndexForAsset(asset, takenFilenames),
      naming: asset.naming,
    };
  });

  // Step 3: one Native Messaging round trip for the whole batch (§F-1 Failure
  // Isolation is enforced Agent-side — see dispatch.ts's "organize-batch" case).
  let response: NativeResponse;
  try {
    response = await deps.sendToAgent({ type: "organize-batch", items }, organizeBatchTimeoutMs(items.length));
  } catch (err) {
    // Agent dropped mid-flight — never leave anything stuck in "organizing".
    for (const asset of assets) {
      jobManager.setStatus(asset.id, "failed", `Agent unreachable: ${(err as Error).message}`);
    }
    return { ok: false, error: `Agent unreachable: ${(err as Error).message}` };
  }

  if (response.type !== "organize-batch-result") {
    for (const asset of assets) {
      jobManager.setStatus(asset.id, "failed", "Unexpected Agent response");
    }
    return { ok: false, error: "Unexpected Agent response" };
  }

  for (const result of response.results) {
    if (result.ok) {
      jobManager.markOrganized(result.jobId, result.finalPath ?? "");
    } else {
      jobManager.setStatus(result.jobId, "failed", `${result.code}: ${result.error}`);
    }
  }

  return { ok: true, results: response.results };
}
