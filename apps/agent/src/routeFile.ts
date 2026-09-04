// Orchestrates one "route-file" request: validate source -> resolve safe
// destination folder (§F-2) -> compute final filename (§H) -> move (§14/§L).

import path from "node:path";
import os from "node:os";
import { realpath as realpathAsync } from "node:fs/promises";
import { buildFilename, type AgentConfig, type MediaType, type NativeRequest, type NativeResponse } from "@ai-asset-saver/shared";
import { resolveSafeDestination, isWithinRoot, RoutingError } from "./fileRouter.js";
import { moveIntoDestination } from "./fileMover.js";

const TYPE_LABEL: Record<MediaType, string> = { image: "IMG", video: "VID", audio: "AUD" };

/**
 * §F-2 defense-in-depth, relaxed for the Inbox/Organize flow (§4/§13 of the plan):
 * downloads are no longer redirected into a staging subfolder at download time —
 * they stay wherever Chrome's default Downloads location puts them, untouched,
 * until the user clicks Organize. So the Agent's source-side boundary check widens
 * from "must be inside the staging subfolder" to "must resolve (after following
 * symlinks) inside the OS default Downloads directory" — same prefix-boundary
 * technique as assertWithinRoot, just against a different, non-configurable root.
 *
 * Known limitation (documented in README): the Agent has no way to ask Chrome
 * what its actually-configured download directory is, so this hardcodes the OS
 * default (~/Downloads). If a user has pointed Chrome at a different download
 * folder, sourcePath will legitimately fail this check.
 */
export function defaultDownloadsRoot(): string {
  return path.join(os.homedir(), "Downloads");
}

export async function assertWithinDownloads(sourcePath: string, downloadsRoot: string = defaultDownloadsRoot()): Promise<string> {
  let resolvedSource: string;
  try {
    resolvedSource = await realpathAsync(sourcePath);
  } catch {
    throw new RoutingError("SOURCE_NOT_FOUND", `Source file not found — it may have been moved or deleted: ${sourcePath}`);
  }

  let resolvedDownloadsRoot: string;
  try {
    resolvedDownloadsRoot = await realpathAsync(downloadsRoot);
  } catch {
    resolvedDownloadsRoot = downloadsRoot;
  }

  if (!isWithinRoot(resolvedSource, resolvedDownloadsRoot)) {
    throw new RoutingError("SOURCE_PATH_INVALID", `sourcePath is not inside the OS Downloads folder: ${sourcePath}`);
  }

  return resolvedSource;
}

type RouteFileRequest = Extract<NativeRequest, { type: "route-file" }>;
type RouteFileResult = Extract<NativeResponse, { type: "route-file-result" }>;

export async function handleRouteFile(
  agentConfig: AgentConfig,
  req: RouteFileRequest,
  // Injectable only for tests (see routeFile.test.ts) so they don't depend on the
  // real machine's ~/Downloads contents; production call sites always use the
  // default.
  downloadsRoot: string = defaultDownloadsRoot(),
): Promise<RouteFileResult> {
  try {
    const resolvedSourcePath = await assertWithinDownloads(req.sourcePath, downloadsRoot);

    const destFolder = await resolveSafeDestination(agentConfig, req.naming);

    const fullNameWithExt = buildFilename(
      req.naming.namingTemplate,
      {
        project: req.naming.project,
        sequence: req.naming.sequence,
        shot: req.naming.shot,
        description: req.naming.description,
        type: TYPE_LABEL[req.mediaType],
        index: req.reservedIndex,
        source: req.source,
        customFilenameEnabled: req.naming.customFilenameEnabled,
        customFilename: req.naming.customFilename,
      },
      req.extension,
    );
    const baseName = fullNameWithExt.slice(0, fullNameWithExt.length - req.extension.length);

    const finalPath = await moveIntoDestination(resolvedSourcePath, destFolder, baseName, req.extension);

    return { type: "route-file-result", jobId: req.jobId, ok: true, finalPath };
  } catch (e) {
    if (e instanceof RoutingError) {
      return { type: "route-file-result", jobId: req.jobId, ok: false, error: e.message, code: e.code };
    }
    return { type: "route-file-result", jobId: req.jobId, ok: false, error: (e as Error).message, code: "IO_ERROR" };
  }
}
