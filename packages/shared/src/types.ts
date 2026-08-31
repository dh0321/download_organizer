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

/**
 * Extension-wide state. Under the Download → Inbox → Edit → Organize flow
 * (see the plan), there is no more "current in-flight download configuration"
 * to hold — every Pending Asset carries its own independent NamingFields that
 * can be edited any time before Organize (see PendingAsset below). What's left
 * here is just the AI Session switch plus "Batch Defaults": the Project/
 * Sequence/Save As values a newly-detected asset is pre-filled with, and that
 * "Apply defaults to selected" can push onto already-listed assets on request.
 */
export interface SessionState {
  aiSessionEnabled: boolean;
  batchDefaultProject: string;
  batchDefaultSequence: string;
  batchDefaultBucketId: string;
}

export type MediaType = "image" | "video";

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
  /** See SessionState.customDirectoryEnabled for the full explanation — distinct
   * from customFolderName above (that's a Phase-2, single-segment bucket
   * replacement; this is a multi-segment full-path override). Optional (like
   * bucketId/customFolderName above) so existing call sites that don't use
   * Custom Directory don't need to pass it. */
  customDirectoryEnabled?: boolean;
  customDirectory?: string;
}

/**
 * A file that has finished downloading (untouched, still in the OS Downloads
 * folder) and is waiting in the Inbox for the user to review/edit and click
 * "Organize" — see the Download → Inbox → Edit → Organize plan. No filesystem
 * operation happens until it is included in an "organize-batch" request.
 */
export type PendingAssetStatus = "pending" | "organizing" | "organized" | "failed";

export interface PendingAsset {
  id: string;
  browserDownloadId: number;
  /** Absolute path in the OS Downloads folder, captured once when the download
   * completed (§F-1 Session Snapshot equivalent — never re-read afterwards). */
  sourcePath: string;
  originalFilename: string;
  extension: string;
  mediaType: MediaType;
  source: string;
  downloadedAt: number;
  status: PendingAssetStatus;
  errorMessage?: string;
  /** UI multi-select state, persisted so it survives a popup/tab close+reopen. */
  selected: boolean;
  /** Folder/filename Auto vs Custom is expressed by the existing
   * customDirectoryEnabled/customFilenameEnabled flags already on NamingFields —
   * no separate mode enum needed, single source of truth. */
  naming: NamingFields;
}

/** One item in a batch "Organize" request — same shape as a "route-file"
 * request minus the discriminant, since organizing one asset IS routing one
 * file; a batch is just several of these run through the same worker pool. */
export interface OrganizeBatchItem {
  jobId: string;
  sourcePath: string;
  extension: string;
  mediaType: MediaType;
  /** The AI source this asset came from (e.g. "chatgpt", "gemini", or
   * whatever the user edited it to) — available as the {source} naming
   * token (§H) so filenames can include it. */
  source: string;
  reservedIndex: number;
  naming: NamingFields;
}

export interface OrganizeBatchItemResult {
  jobId: string;
  ok: boolean;
  finalPath?: string;
  error?: string;
  code?: NativeErrorCode;
}

export type NativeRequest =
  | {
      type: "route-file";
      jobId: string;
      sourcePath: string;
      extension: string;
      mediaType: MediaType;
      source: string;
      reservedIndex: number;
      naming: NamingFields;
    }
  | {
      // §11 Organize Flow: one Native Messaging round trip per Organize click,
      // covering every selected Pending Asset. Failure Isolation (§F-1) still
      // applies per item — one item failing never blocks or rolls back others.
      type: "organize-batch";
      items: OrganizeBatchItem[];
    }
  | {
      // No caller-supplied regex/pattern (§F-2): the Agent derives its own scan
      // pattern from these logical fields so a compromised Extension can never hand
      // the Agent an attacker-controlled regex (ReDoS surface).
      type: "get-max-index";
      naming: Pick<
        NamingFields,
        "project" | "sequence" | "shot" | "bucketId" | "customFolderName" | "customDirectoryEnabled" | "customDirectory"
      >;
    }
  | { type: "sync-settings"; settings: Omit<AgentConfig, "allowedExtensionId"> }
  | { type: "get-settings" }
  | { type: "ping" }
  /**
   * Popups can't get a real filesystem path from the browser (Chrome never
   * exposes absolute paths to web/extension content, by design) — so the
   * native OS folder dialog is shown by the Agent itself (a real local
   * process), which returns the chosen path as a plain string.
   */
  | { type: "pick-directory" };

export type NativeErrorCode =
  | "OUTSIDE_ROOT"
  | "ROOT_NOT_CONFIGURED"
  | "ROOT_UNAVAILABLE"
  | "SOURCE_PATH_INVALID"
  | "SOURCE_NOT_FOUND"
  | "CONFLICT_LIMIT_EXCEEDED"
  | "MISSING_REQUIRED_FIELD"
  | "IO_ERROR";

export type NativeResponse =
  | { type: "route-file-result"; jobId: string; ok: true; finalPath: string }
  | { type: "route-file-result"; jobId: string; ok: false; error: string; code: NativeErrorCode }
  | { type: "organize-batch-result"; results: OrganizeBatchItemResult[] }
  | { type: "get-max-index-result"; maxIndex: number }
  | { type: "sync-settings-result"; ok: boolean }
  | { type: "get-settings-result"; settings: Omit<AgentConfig, "allowedExtensionId"> }
  | { type: "pong" }
  | { type: "pick-directory-result"; ok: true; path: string | null } // null = user cancelled the dialog
  | { type: "pick-directory-result"; ok: false; error: string };
