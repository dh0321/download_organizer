// Orchestrates one "route-file" request: validate source -> resolve safe
// destination folder (§F-2) -> compute final filename (§H) -> move (§14/§L).

import path from "node:path";
import { buildFilename, type AgentConfig, type MediaType, type NativeRequest, type NativeResponse } from "@ai-asset-saver/shared";
import { resolveSafeDestination, RoutingError } from "./fileRouter.js";
import { moveIntoDestination } from "./fileMover.js";

const TYPE_LABEL: Record<MediaType, string> = { image: "IMG", video: "VID" };

/**
 * §F-2 defense-in-depth: the Agent only ever reads from the Extension's designated
 * staging subfolder inside the OS Downloads directory, never an arbitrary path a
 * buggy/compromised Extension might supply. The exact Downloads path varies per
 * Windows user, so rather than hardcoding it, we require the well-known staging
 * directory name to appear as a path component.
 */
export const STAGING_DIR_NAME = "_AIAssetSaver_staging";

export function assertWithinStagingArea(sourcePath: string): void {
  const segments = sourcePath.split(path.sep);
  if (!segments.includes(STAGING_DIR_NAME)) {
    throw new RoutingError("SOURCE_PATH_INVALID", `sourcePath is not inside the expected staging folder: ${sourcePath}`);
  }
}

type RouteFileRequest = Extract<NativeRequest, { type: "route-file" }>;
type RouteFileResult = Extract<NativeResponse, { type: "route-file-result" }>;

export async function handleRouteFile(agentConfig: AgentConfig, req: RouteFileRequest): Promise<RouteFileResult> {
  try {
    assertWithinStagingArea(req.sourcePath);

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
        customFilenameEnabled: req.naming.customFilenameEnabled,
        customFilename: req.naming.customFilename,
      },
      req.extension,
    );
    const baseName = fullNameWithExt.slice(0, fullNameWithExt.length - req.extension.length);

    const finalPath = await moveIntoDestination(req.sourcePath, destFolder, baseName, req.extension);

    return { type: "route-file-result", jobId: req.jobId, ok: true, finalPath };
  } catch (e) {
    if (e instanceof RoutingError) {
      return { type: "route-file-result", jobId: req.jobId, ok: false, error: e.message, code: e.code };
    }
    return { type: "route-file-result", jobId: req.jobId, ok: false, error: (e as Error).message, code: "IO_ERROR" };
  }
}
