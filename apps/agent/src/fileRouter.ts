// §F-2 Root Sandbox Policy — the ONLY place that turns logical naming fields into a
// real filesystem path. The Extension never sends a path; it sends NamingFields, and
// this module resolves them against the Agent's own AgentConfig.defaultRoot, then
// verifies (twice — before and after folder creation) that the result cannot have
// escaped the Root, guarding against '..'-style injection and Windows junction/
// symlink redirection alike.

import { realpath as realpathAsync, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  resolveDestinationFolderSegments,
  MissingRequiredFieldError,
  type AgentConfig,
  type NamingFields,
  type NativeErrorCode,
} from "@ai-asset-saver/shared";
import { PathTraversalError } from "@ai-asset-saver/shared";

export class RoutingError extends Error {
  constructor(
    public readonly code: NativeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

/** Exported for direct unit testing of the prefix-boundary logic (see fileRouter.test.ts). */
export function assertWithinRoot(candidate: string, root: string): void {
  // Case-insensitive comparison because Windows filesystems are case-insensitive by
  // default (this also means "D:\AI_Projects2" must never match root "D:\AI_Projects"
  // — hence comparing against root + separator, not a bare string prefix).
  const normCandidate = candidate.toLowerCase();
  const normRoot = root.toLowerCase();
  const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;

  if (normCandidate !== normRoot && !normCandidate.startsWith(rootWithSep)) {
    throw new RoutingError("OUTSIDE_ROOT", `Resolved path escapes Default Root: ${candidate}`);
  }
}

async function ensureFolderExists(target: string): Promise<void> {
  await mkdir(target, { recursive: true });
}

async function resolveRealRoot(agentConfig: AgentConfig): Promise<string> {
  if (!agentConfig.defaultRoot) {
    throw new RoutingError("ROOT_NOT_CONFIGURED", "Default Root is not configured on the Agent");
  }
  try {
    return await realpathAsync(agentConfig.defaultRoot);
  } catch {
    throw new RoutingError(
      "ROOT_UNAVAILABLE",
      `Default Root does not exist or is unreachable: ${agentConfig.defaultRoot}`,
    );
  }
}

export type FolderNamingFields = Pick<NamingFields, "project" | "sequence" | "shot" | "bucketId" | "customFolderName">;

function computeCandidatePath(agentConfig: AgentConfig, root: string, naming: FolderNamingFields): string {
  const bucketOrCustomFolderName = naming.bucketId
    ? (agentConfig.assetBuckets.find((b) => b.id === naming.bucketId)?.label ?? naming.bucketId)
    : (naming.customFolderName ?? "");

  let segments: string[];
  try {
    segments = resolveDestinationFolderSegments(agentConfig.folderTemplate.levels, naming, bucketOrCustomFolderName);
  } catch (e) {
    if (e instanceof MissingRequiredFieldError) {
      throw new RoutingError("MISSING_REQUIRED_FIELD", e.message);
    }
    if (e instanceof PathTraversalError) {
      throw new RoutingError("OUTSIDE_ROOT", e.message);
    }
    throw e;
  }

  const candidate = path.normalize(path.join(root, ...segments));
  assertWithinRoot(candidate, root); // lexical check, before touching the filesystem
  return candidate;
}

/**
 * Resolves and creates (lazily) the final destination *folder* for a route-file
 * request, guaranteed to be a descendant of agentConfig.defaultRoot. Never called
 * with — and never trusts — any path-shaped value from the Extension.
 */
export async function resolveSafeDestination(
  agentConfig: AgentConfig,
  naming: NamingFields,
  mkdirFn: (target: string) => Promise<void> = ensureFolderExists,
): Promise<string> {
  const root = await resolveRealRoot(agentConfig);
  const candidate = computeCandidatePath(agentConfig, root, naming);

  await mkdirFn(candidate);

  let resolvedAfterCreate: string;
  try {
    resolvedAfterCreate = await realpathAsync(candidate);
  } catch (e) {
    throw new RoutingError("IO_ERROR", `Failed to resolve created folder "${candidate}": ${(e as Error).message}`);
  }
  // Re-check after creation: guards against a junction/symlink planted inside the
  // tree that silently redirected part of the path during creation (§L, §F-2).
  assertWithinRoot(resolvedAfterCreate, root);

  return resolvedAfterCreate;
}

/**
 * Read-only variant used by get-max-index (§F-1): computes the same candidate
 * folder but never creates it. Returns null if the folder doesn't exist yet
 * (meaning: no prior saves there, so max index is trivially 0).
 */
export async function resolveExistingDestinationOrNull(
  agentConfig: AgentConfig,
  naming: FolderNamingFields,
): Promise<string | null> {
  const root = await resolveRealRoot(agentConfig);
  const candidate = computeCandidatePath(agentConfig, root, naming);

  if (!existsSync(candidate)) return null;

  const resolved = await realpathAsync(candidate);
  assertWithinRoot(resolved, root);
  return resolved;
}
