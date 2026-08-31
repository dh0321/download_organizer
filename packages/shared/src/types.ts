// Shared types used by both the Chrome Extension and the Windows Local Agent.
// See PLAN.md §I (State Model) and §F-2 (Security Principles) for the design rationale.

export interface FolderLevel {
  key: string;
  label: string;
  order: number;
  required: boolean;
}

export interface FolderTemplate {
  id: string;
  name: string;
  levels: FolderLevel[];
}

export interface AssetBucket {
  id: string;
  label: string;
  order: number;
}

export interface NamingPreset {
  id: string;
  label: string;
  /** Token string, e.g. "{shot}_{type}_{description}_{index}" */
  template: string;
}

export type ConflictPolicy = "uniquify";

/**
 * Agent's own local, authoritative copy of Root/FolderTemplate/etc (§F-2 Root Sandbox Policy).
 * The Extension never sends this over the wire per-request; it only requests changes via
 * a "sync-settings" message, and reads a cached copy via "get-settings" for display only.
 */
export interface AgentConfig {
  defaultRoot: string;
  folderTemplate: FolderTemplate;
  assetBuckets: AssetBucket[];
  conflictPolicy: ConflictPolicy;
  maxConcurrentFileOps: number;
  allowedExtensionId: string;
}

/**
 * Extension-side Settings. defaultRoot/folderTemplate/assetBuckets/conflictPolicy/
 * maxConcurrentFileOps are a *display-only cache* mirroring the Agent's AgentConfig
 * (never the source of truth for path construction — see §F-2). namingPresets is
 * owned by the Extension since it is unrelated to path/security.
 */
export interface Settings {
  defaultRoot: string;
  folderTemplate: FolderTemplate;
  assetBuckets: AssetBucket[];
  namingPresets: NamingPreset[];
  conflictPolicy: ConflictPolicy;
  maxConcurrentFileOps: number;
}

export interface SessionState {
  aiSessionEnabled: boolean;
  currentProject: string;
  currentSequence: string;
  currentShot: string;
  currentBucketId: string;
  currentDescription: string;
  selectedNamingPresetId: string;
  customFilenameEnabled: boolean;
  customFilename: string;
  /** §F-1 Index Reservation checkpoint. In-memory counter is authoritative; this is
   * only the persisted restore point used after a service worker restart. */
  lastIndexByKey: Record<string, number>;
}

/** §F-1 — captured once at detection time and never re-read afterwards. */
export interface SessionSnapshot {
  root: string;
  project: string;
  sequence: string;
  shot: string;
  bucketId: string;
  description: string;
  namingPresetId: string;
  customFilenameEnabled: boolean;
  customFilename: string;
}

export type MediaType = "image" | "video";

export type DownloadJobStatus =
  | "detected"
  | "queued"
  | "downloading"
  | "downloaded"
  | "moving"
  | "saved"
  | "failed"
  | "cancelled";

export interface DownloadJob {
  id: string;
  browserDownloadId: number;
  originalFilename: string;
  extension: string;
  mediaType: MediaType;
  source: string;
  detectedAt: number;
  sessionSnapshot: SessionSnapshot;
  reservedIndex: number;
  destinationPath?: string;
  finalFilename?: string;
  status: DownloadJobStatus;
  error?: string;
}

export interface RecentActivityEntry {
  jobId: string;
  finalFilename: string;
  status: DownloadJobStatus;
  updatedAt: number;
}

export interface IntentPing {
  origin: string;
  timestamp: number;
}

export interface AISourceAdapter {
  id: string;
  label: string;
  hostPatterns: string[];
  matchesDownload(ctx: {
    url: string;
    referrer?: string;
    recentIntentPing?: IntentPing;
  }): boolean;
}

/** Logical fields only — never an assembled or absolute path (§F-2 Root Sandbox Policy). */
export interface NamingFields {
  project: string;
  sequence: string;
  shot: string;
  bucketId?: string;
  customFolderName?: string;
  description: string;
  namingPresetId: string;
  /**
   * The resolved token template itself (e.g. "{shot}_{type}_{description}_{index}"),
   * not just its id — the Agent needs the literal template to compute the filename
   * and has no synced copy of the Extension's NamingPreset[] (namingPresets are
   * Extension-owned, §I). This is safe to pass directly: it is a small set of
   * `{token}` placeholders, never a path, and every value it expands to still goes
   * through sanitizeSegment (§H) regardless of template content.
   */
  namingTemplate: string;
  customFilenameEnabled: boolean;
  customFilename: string;
}

export type NativeRequest =
  | {
      type: "route-file";
      jobId: string;
      sourcePath: string;
      extension: string;
      mediaType: MediaType;
      reservedIndex: number;
      naming: NamingFields;
    }
  | {
      // No caller-supplied regex/pattern (§F-2): the Agent derives its own scan
      // pattern from these logical fields so a compromised Extension can never hand
      // the Agent an attacker-controlled regex (ReDoS surface).
      type: "get-max-index";
      naming: Pick<NamingFields, "project" | "sequence" | "shot" | "bucketId" | "customFolderName">;
    }
  | { type: "sync-settings"; settings: Omit<AgentConfig, "allowedExtensionId"> }
  | { type: "get-settings" }
  | { type: "ping" };

export type NativeErrorCode =
  | "OUTSIDE_ROOT"
  | "ROOT_NOT_CONFIGURED"
  | "ROOT_UNAVAILABLE"
  | "SOURCE_PATH_INVALID"
  | "CONFLICT_LIMIT_EXCEEDED"
  | "MISSING_REQUIRED_FIELD"
  | "IO_ERROR";

export type NativeResponse =
  | { type: "route-file-result"; jobId: string; ok: true; finalPath: string }
  | { type: "route-file-result"; jobId: string; ok: false; error: string; code: NativeErrorCode }
  | { type: "get-max-index-result"; maxIndex: number }
  | { type: "sync-settings-result"; ok: boolean }
  | { type: "get-settings-result"; settings: Omit<AgentConfig, "allowedExtensionId"> }
  | { type: "pong" };
