// §7 Inbox UI — the full Download → Inbox → Edit → Organize surface. Default
// Root, Batch Defaults, the Pending Asset list, and the Organize action all
// live here; the popup only shows a summary + "Open Inbox" (see ../popup/App.tsx).

import { useEffect, useMemo, useState } from "react";
import {
  buildFilename,
  splitCustomDirectorySegments,
  type AssetBucket,
  type NamingFields,
  type OrganizeLogEntry,
  type PendingAsset,
  type SessionState,
} from "@ai-asset-saver/shared";
import { loadSessionState, saveSessionState, DEFAULT_SESSION_STATE } from "../background/sessionManager.js";
import { loadPendingAssets } from "../background/pendingAssetsStorage.js";
import { loadOrganizeLog } from "../background/organizeLogStorage.js";
import { pendingAssetIndexKey } from "../background/jobManager.js";
import type { RescanCandidate } from "../background/rescanDownloads.js";
import { adapters } from "../adapters/registry.js";
import {
  PENDING_ASSETS_STORAGE_KEY,
  SESSION_STORAGE_KEY,
  INDEX_COUNTERS_STORAGE_KEY,
  ORGANIZE_LOG_STORAGE_KEY,
} from "../background/storageKeys.js";
import { AgentBadge, type AgentStatus } from "../components/AgentBadge.js";
import { Combobox } from "../components/Combobox.js";
import { Field } from "../components/Field.js";
import { Segmented } from "../components/Segmented.js";
import "../styles/theme.css";

const DEFAULT_BUCKETS: AssetBucket[] = [
  { id: "generated", label: "Generated", order: 0 },
  { id: "reference", label: "Reference", order: 1 },
  { id: "character", label: "Character", order: 2 },
  { id: "environment", label: "Environment", order: 3 },
  { id: "prop", label: "Prop", order: 4 },
  { id: "turntable", label: "Turntable", order: 5 },
  { id: "concept", label: "Concept", order: 6 },
  { id: "final", label: "Final", order: 7 },
];

const ORGANIZABLE = new Set(["pending", "failed"]);

// buildFilename() already handles any {token} combination generically (see
// naming.ts), so letting the user freely toggle which tokens are in the
// template needs no shared/background changes — just building the template
// string client-side from whichever tokens are active. Fixed reading order
// (shot, description, source, index) regardless of toggle order.
const NAMING_TOKENS = [
  { key: "shot", label: "Name" },
  { key: "description", label: "Description" },
  { key: "source", label: "Source" },
  { key: "index", label: "Index" },
] as const;

const SOURCE_SUGGESTIONS = adapters.map((a) => a.label);
const CATEGORY_SUGGESTIONS = ["Generated", "Reference", "Character", "Environment", "Prop", "Turntable", "Concept", "Final"];

function activeNamingTokens(template: string): Set<string> {
  return new Set(NAMING_TOKENS.filter((t) => template.includes(`{${t.key}}`)).map((t) => t.key));
}

function buildTemplateFromTokens(tokens: Set<string>): string {
  return NAMING_TOKENS.filter((t) => tokens.has(t.key))
    .map((t) => `{${t.key}}`)
    .join("_");
}

// "en-US" is pinned explicitly everywhere below (not the browser/OS default
// locale) so date/time text is always plain English regardless of the user's
// system language — otherwise e.g. AM/PM and month names render in whatever
// locale the OS happens to be set to.
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(ms: number): string {
  const date = new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${date}, ${formatTime(ms)}`;
}

/** Stable per-local-day grouping key for the Rescan picker (§3-3) — distinct
 * from the human-readable label so a group's identity doesn't depend on
 * locale-formatting details. */
function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Coarse relative time for the "Recently Organized" log — entries only live
 * for LOG_RETENTION_MS (3 days, see jobManager.ts), so minute/hour/day is
 * granular enough; never shown alongside a full timestamp. */
function formatRelativeTime(ms: number): string {
  const diffMs = Date.now() - ms;
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Inbox list order: newest download first. Applied wherever assets are set
 * directly from a raw storage snapshot (initial load, storage.onChanged) —
 * every other setAssets call site only maps/filters the existing array, which
 * preserves whatever order was already established here. */
function sortByDownloadedAtDesc(list: PendingAsset[]): PendingAsset[] {
  return [...list].sort((a, b) => b.downloadedAt - a.downloadedAt);
}

/**
 * Folder/Filename each show ONE input shared by Auto and Custom (see the plan
 * — Auto/Custom must occupy the exact same slot, and typing into the Auto
 * value promotes it to Custom). That input's value must have the same
 * "shape" the raw Custom field expects, which differs from what the bottom
 * Full Path line shows:
 *   - folderRelativePreview: segments only, no Default Root prefix — matches
 *     what customDirectory itself holds (Root-relative).
 *   - filenameBasePreview: no extension — matches what customFilename itself
 *     holds (the extension is shown as a fixed suffix beside the input).
 * fullPathPreview keeps the full Root+folder+filename absolute form, for the
 * card's bottom summary line, which is unaffected by any of this.
 */
/** Strips stray leading/trailing "\" or "/" from a single segment value —
 * defensive against a raw naming field (Project/Sequence/Shot/Category) that
 * happens to contain one (e.g. pasted from a path), which would otherwise
 * show up as a doubled separator once joined with its neighbors. The real
 * Organize operation already sanitizes every segment on the Agent side
 * (sanitizeSegment strips slashes entirely); this is the client-preview
 * equivalent, kept separate since preview text also needs to stay readable
 * pre-sanitization. */
function stripSeparators(s: string): string {
  return s.replace(/^[\\/]+|[\\/]+$/g, "");
}

/** Only strips the trailing separator — Default Root is a single absolute
 * path, not a segment, so a leading "/" (or a bare drive letter) must be
 * preserved. Fixes the "//" that appeared when Default Root itself ended in
 * a separator (e.g. typed/copied with a trailing slash, or a drive root like
 * "D:\"). */
function stripTrailingSeparator(s: string): string {
  return s.replace(/[\\/]+$/, "");
}

function computePreview(
  asset: PendingAsset,
  defaultRoot: string,
  indexCounters: Record<string, number>,
  buckets: AssetBucket[],
  pathSep: "\\" | "/",
): { folderRelativePreview: string; folderFullPreview: string; filenameBasePreview: string; fullPathPreview: string } {
  const bucketLabel = buckets.find((b) => b.id === asset.naming.bucketId)?.label ?? asset.naming.bucketId ?? "";

  let folderSegments: string[] = [];
  let folderMessage: string | null = null;
  if (asset.naming.customDirectoryEnabled) {
    if (!asset.naming.customDirectory?.trim()) {
      folderMessage = "(enter a folder below)";
    } else {
      try {
        folderSegments = splitCustomDirectorySegments(asset.naming.customDirectory);
      } catch {
        folderMessage = "(invalid folder — check for unsupported characters)";
      }
    }
  } else {
    // Project/Sequence/Category are all optional (§ Workspace scope widening)
    // — any or all may be blank, in which case the file just lands one level
    // higher. An entirely empty result is a valid "save straight into Default
    // Root" state, not an error. Shot/Asset Name is deliberately NOT part of
    // the folder — it's the filename identifier, not a folder level (matches
    // DEFAULT_FOLDER_TEMPLATE on the Agent side).
    folderSegments = [asset.naming.project, asset.naming.sequence, bucketLabel]
      .map(stripSeparators)
      .filter(Boolean);
  }

  const folderRelativePreview = folderMessage ?? (folderSegments.length ? folderSegments.join(pathSep) : "(root)");
  const folderFullPreview = !defaultRoot
    ? "(set a Default Root)"
    : (folderMessage ?? [stripTrailingSeparator(defaultRoot), ...folderSegments].join(pathSep));

  const previewIndex = (indexCounters[pendingAssetIndexKey(asset)] ?? 0) + 1;

  let filenameFullPreview: string;
  if (asset.naming.customFilenameEnabled && !asset.naming.customFilename.trim()) {
    filenameFullPreview = "(enter a filename below)";
  } else {
    try {
      filenameFullPreview = buildFilename(
        asset.naming.namingTemplate,
        {
          project: asset.naming.project,
          sequence: asset.naming.sequence,
          shot: asset.naming.shot,
          description: asset.naming.description,
          type: asset.mediaType === "image" ? "IMG" : "VID",
          index: previewIndex,
          source: asset.source,
          customFilenameEnabled: asset.naming.customFilenameEnabled,
          customFilename: asset.naming.customFilename,
        },
        asset.extension,
      );
    } catch {
      filenameFullPreview = "(invalid filename)";
    }
  }
  const filenameBasePreview = filenameFullPreview.endsWith(asset.extension)
    ? filenameFullPreview.slice(0, -asset.extension.length)
    : filenameFullPreview;

  const fullPathPreview =
    !defaultRoot || folderMessage ? folderFullPreview : `${folderFullPreview}${pathSep}${filenameFullPreview}`;
  return { folderRelativePreview, folderFullPreview, filenameBasePreview, fullPathPreview };
}

/**
 * Custom Directory is structurally Root-relative (see splitCustomDirectorySegments)
 * — so a folder chosen via the native OS picker (which returns an absolute path)
 * must be re-expressed relative to Default Root before it can be stored. Returns
 * null when `picked` isn't actually inside `root` at all (caller shows an error
 * and refuses the value, rather than guessing). Case-insensitive prefix compare
 * matches the same Windows-filesystem assumption `isWithinRoot` makes on the
 * Agent side (apps/agent/src/fileRouter.ts) — this is the client-side mirror of
 * that check, purely for a friendly error message before ever sending anything.
 */
function relativeToRoot(picked: string, root: string): string | null {
  const stripTrailingSep = (p: string) => p.replace(/[\\/]+$/, "");
  const normPicked = stripTrailingSep(picked);
  const normRoot = stripTrailingSep(root);
  if (normPicked.toLowerCase() === normRoot.toLowerCase()) return "";
  const lowerPicked = normPicked.toLowerCase();
  const lowerRoot = normRoot.toLowerCase();
  if (lowerPicked.startsWith(`${lowerRoot}/`) || lowerPicked.startsWith(`${lowerRoot}\\`)) {
    return normPicked.slice(normRoot.length + 1);
  }
  return null;
}

/**
 * Neither `<img src="file://...">` nor `fetch("file://...")` is allowed from
 * a chrome-extension:// document — confirmed live ("Not allowed to load
 * local resource") — this is Chrome blocking local-file reads from any
 * regular renderer page, regardless of the "Allow access to file URLs"
 * toggle (that only governs content scripts / host-permission matching on
 * file: pages, not in-page subresource loads). `chrome.downloads.getFileIcon`
 * sidesteps this entirely: Chrome itself reads the file (using its own OS
 * icon/thumbnail generation) and hands back a ready-to-use data: URL, so the
 * page never touches the filesystem directly.
 */
function Thumbnail({ asset }: { asset: PendingAsset }) {
  const [iconUrl, setIconUrl] = useState<string | null>(null);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    // A Rescan-via-folder-scan asset has no real chrome.downloads id (see
    // PendingAsset.browserDownloadId) — fall straight to the generic icon.
    if (asset.browserDownloadId == null) {
      setErrored(true);
      return;
    }
    chrome.downloads.getFileIcon(asset.browserDownloadId, { size: 32 }, (url) => {
      if (chrome.runtime.lastError || !url) {
        setErrored(true);
        return;
      }
      setIconUrl(url);
    });
  }, [asset.browserDownloadId]);

  if (iconUrl && !errored) {
    // eslint-disable-next-line jsx-a11y/alt-text
    return <img className="aias-thumb" src={iconUrl} onError={() => setErrored(true)} />;
  }
  return <div className="aias-thumb aias-thumb-fallback">{asset.mediaType.toUpperCase()}</div>;
}

function STATUS_LABEL(status: PendingAsset["status"]): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "organizing":
      return "Organizing…";
    case "organized":
      return "Organized";
    case "failed":
      return "Failed";
  }
}

/** Rescan picker (§3-3) — grouped by local day so a large backlog is scannable
 * instead of one flat list; only the most recent day starts expanded. */
function RescanImportModal({
  candidates,
  selectedIds,
  expandedDays,
  importing,
  onToggleSelected,
  onToggleDay,
  onToggleDayExpanded,
  onSelectAll,
  onCancel,
  onConfirm,
}: {
  candidates: RescanCandidate[];
  selectedIds: Set<string>;
  expandedDays: Set<string>;
  importing: boolean;
  onToggleSelected: (id: string, next: boolean) => void;
  onToggleDay: (ids: string[], next: boolean) => void;
  onToggleDayExpanded: (key: string) => void;
  onSelectAll: (next: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const groups = useMemo(() => {
    const byKey = new Map<string, { key: string; label: string; items: RescanCandidate[] }>();
    for (const c of candidates) {
      const key = dayKey(c.downloadedAt);
      if (!byKey.has(key)) byKey.set(key, { key, label: dayLabel(c.downloadedAt), items: [] });
      byKey.get(key)!.items.push(c);
    }
    return Array.from(byKey.values()).sort((a, b) => b.items[0].downloadedAt - a.items[0].downloadedAt);
  }, [candidates]);

  const allSelected = candidates.length > 0 && candidates.every((c) => selectedIds.has(c.sourcePath));

  return (
    <div className="aias-modal-overlay">
      <div className="aias-modal-card">
        <div className="aias-row">
          <p className="aias-card-title" style={{ margin: 0 }}>
            Import from Downloads · {candidates.length} found
          </p>
          <button className="aias-btn aias-btn-ghost aias-btn-sm" onClick={() => onSelectAll(!allSelected)}>
            {allSelected ? "Deselect all" : "Select all"}
          </button>
        </div>
        <div className="aias-divider" />

        <div className="aias-modal-list">
          {groups.map((group) => {
            const expanded = expandedDays.has(group.key);
            const dayIds = group.items.map((c) => c.sourcePath);
            const dayAllSelected = dayIds.every((id) => selectedIds.has(id));
            return (
              <div key={group.key} className="aias-modal-day-group">
                <div className="aias-modal-day-header" onClick={() => onToggleDayExpanded(group.key)}>
                  <span>
                    {expanded ? "▾" : "▸"} {group.label} ({group.items.length})
                  </span>
                  <button
                    className="aias-btn aias-btn-ghost aias-btn-sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleDay(dayIds, !dayAllSelected);
                    }}
                  >
                    {dayAllSelected ? "Deselect day" : "Select day"}
                  </button>
                </div>
                {expanded &&
                  group.items.map((c) => (
                    <label key={c.sourcePath} className="aias-inbox-row" style={{ cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        className="aias-checkbox-lg"
                        checked={selectedIds.has(c.sourcePath)}
                        onChange={(e) => onToggleSelected(c.sourcePath, e.target.checked)}
                      />
                      <span className="aias-inbox-row-text">
                        <strong>{c.originalFilename}</strong>
                        <p className="aias-subtext" style={{ margin: "2px 0 0" }}>
                          {c.source ? c.source.toLowerCase() : "no source"} · {formatTime(c.downloadedAt)}
                        </p>
                      </span>
                    </label>
                  ))}
              </div>
            );
          })}
        </div>

        <div className="aias-divider" />
        <div className="aias-row">
          <span className="aias-subtext" style={{ margin: 0 }}>
            {selectedIds.size} selected
          </span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="aias-btn aias-btn-ghost" disabled={importing} onClick={onCancel}>
              Cancel
            </button>
            <button className="aias-btn" disabled={importing || selectedIds.size === 0} onClick={onConfirm}>
              {importing ? "Importing…" : `Import ${selectedIds.size}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<SessionState>(DEFAULT_SESSION_STATE);
  const [assets, setAssets] = useState<PendingAsset[]>([]);
  const [indexCounters, setIndexCounters] = useState<Record<string, number>>({});
  const [defaultRoot, setDefaultRoot] = useState("");
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("checking");
  const [editingRoot, setEditingRoot] = useState(false);
  const [rootDraft, setRootDraft] = useState("");
  const [pickingRoot, setPickingRoot] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [organizing, setOrganizing] = useState(false);
  const [organizeError, setOrganizeError] = useState("");
  const [rescanning, setRescanning] = useState(false);
  const [rescanMessage, setRescanMessage] = useState("");
  const [rescanCandidates, setRescanCandidates] = useState<RescanCandidate[] | null>(null);
  const [rescanSelectedIds, setRescanSelectedIds] = useState<Set<string>>(new Set());
  const [rescanExpandedDays, setRescanExpandedDays] = useState<Set<string>>(new Set());
  const [importingRescan, setImportingRescan] = useState(false);
  const [buckets] = useState<AssetBucket[]>(DEFAULT_BUCKETS);
  const [focusedAssetId, setFocusedAssetId] = useState<string | null>(null);
  // Native Messaging always talks to an Agent on this same machine, so the
  // OS Chrome itself reports is exactly the OS the Agent's real paths use —
  // every path composed/shown for preview purposes follows this, instead of
  // a hardcoded "\\" (§ path separator unification).
  const [pathSep, setPathSep] = useState<"\\" | "/">("\\");
  const [pickingFolder, setPickingFolder] = useState(false);
  const [folderPickerError, setFolderPickerError] = useState("");
  const [organizeLog, setOrganizeLog] = useState<OrganizeLogEntry[]>([]);
  const [organizeLogExpanded, setOrganizeLogExpanded] = useState(false);
  const [confirmingEmptyInbox, setConfirmingEmptyInbox] = useState(false);

  useEffect(() => {
    loadSessionState().then(setSession);
    loadPendingAssets().then((map) => setAssets(sortByDownloadedAtDesc(Object.values(map))));
    loadOrganizeLog().then(setOrganizeLog);
    chrome.storage.local.get(INDEX_COUNTERS_STORAGE_KEY).then((result) => {
      setIndexCounters((result[INDEX_COUNTERS_STORAGE_KEY] as Record<string, number>) ?? {});
    });
    chrome.runtime.sendMessage({ type: "aias-get-display-settings" }, (res) => {
      if (res?.ok) setDefaultRoot(res.settings.defaultRoot ?? "");
    });
    chrome.runtime.sendMessage({ type: "aias-ping-agent" }, (res) => {
      setAgentStatus(res?.connected ? "connected" : "disconnected");
    });
    chrome.runtime.getPlatformInfo((info) => setPathSep(info.os === "win" ? "\\" : "/"));
    // Auto-cleanup trigger (§3): every fresh Inbox page load/reload sweeps
    // already-"organized" assets out of the active list and into the
    // organize log — see JobManager.pruneOrganizedIntoLog. The resulting
    // storage changes are picked up by the listener below.
    chrome.runtime.sendMessage({ type: "aias-prune-organized" });

    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local") return;
      if (changes[PENDING_ASSETS_STORAGE_KEY]) {
        setAssets(sortByDownloadedAtDesc(Object.values(changes[PENDING_ASSETS_STORAGE_KEY].newValue ?? {})));
      }
      if (changes[SESSION_STORAGE_KEY]) {
        setSession({ ...DEFAULT_SESSION_STATE, ...changes[SESSION_STORAGE_KEY].newValue });
      }
      if (changes[INDEX_COUNTERS_STORAGE_KEY]) {
        setIndexCounters(changes[INDEX_COUNTERS_STORAGE_KEY].newValue ?? {});
      }
      if (changes[ORGANIZE_LOG_STORAGE_KEY]) {
        setOrganizeLog(changes[ORGANIZE_LOG_STORAGE_KEY].newValue ?? []);
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  // The "Empty Inbox" button needs a second click within a few seconds to
  // actually confirm (§3) — never a native confirm() dialog, to match this
  // page's own custom UI style. Resets automatically if the user doesn't
  // follow through.
  useEffect(() => {
    if (!confirmingEmptyInbox) return;
    const t = setTimeout(() => setConfirmingEmptyInbox(false), 4000);
    return () => clearTimeout(t);
  }, [confirmingEmptyInbox]);

  const organizable = useMemo(() => assets.filter((a) => ORGANIZABLE.has(a.status)), [assets]);
  const selected = useMemo(() => organizable.filter((a) => a.selected), [organizable]);
  const allSelected = organizable.length > 0 && organizable.every((a) => a.selected);

  // Keep the focused (right-panel) asset valid as the asset list changes —
  // default to the first asset, or nothing if the list is empty.
  useEffect(() => {
    if (focusedAssetId && assets.some((a) => a.id === focusedAssetId)) return;
    setFocusedAssetId(assets[0]?.id ?? null);
  }, [assets, focusedAssetId]);

  const focusedAsset = assets.find((a) => a.id === focusedAssetId) ?? null;

  function toggleSession(enabled: boolean) {
    setSession((prev) => {
      const next = { ...prev, aiSessionEnabled: enabled };
      void saveSessionState(next);
      return next;
    });
  }

  function updateBatchDefault<K extends keyof SessionState>(key: K, value: SessionState[K]) {
    setSession((prev) => {
      const next = { ...prev, [key]: value };
      void saveSessionState(next);
      return next;
    });
  }

  function saveRoot() {
    chrome.runtime.sendMessage({ type: "aias-set-default-root", root: rootDraft }, (res) => {
      if (res?.ok) {
        setDefaultRoot(rootDraft);
        setEditingRoot(false);
      }
    });
  }

  function browseForRoot() {
    setPickerError("");
    setPickingRoot(true);
    chrome.runtime.sendMessage({ type: "aias-pick-directory" }, (res) => {
      setPickingRoot(false);
      if (res?.ok && res.path) {
        chrome.runtime.sendMessage({ type: "aias-set-default-root", root: res.path }, (saveRes) => {
          if (saveRes?.ok) setDefaultRoot(res.path);
        });
      } else if (res?.ok && res.path === null) {
        // user cancelled the dialog — no-op
      } else {
        setPickerError(res?.error ?? "Couldn't open the folder picker — Local App may not be running.");
        setRootDraft(defaultRoot);
        setEditingRoot(true);
      }
    });
  }

  function browseForFolder(assetId: string) {
    if (!defaultRoot) {
      setFolderPickerError("Set a Default Root first.");
      return;
    }
    setFolderPickerError("");
    setPickingFolder(true);
    chrome.runtime.sendMessage({ type: "aias-pick-directory" }, (res) => {
      setPickingFolder(false);
      if (res?.ok && res.path) {
        const relative = relativeToRoot(res.path, defaultRoot);
        if (relative === null) {
          setFolderPickerError(`Choose a folder inside Default Root (${defaultRoot})`);
          return;
        }
        const normalized = splitCustomDirectorySegments(relative).join(pathSep);
        patchNaming(assetId, { customDirectoryEnabled: true, customDirectory: normalized });
      } else if (res?.ok && res.path === null) {
        // user cancelled the dialog — no-op
      } else {
        setFolderPickerError(res?.error ?? "Couldn't open the folder picker — Local App may not be running.");
      }
    });
  }

  function toggleAssetSelected(id: string, next: boolean) {
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, selected: next } : a)));
    chrome.runtime.sendMessage({ type: "aias-set-selected", id, selected: next });
  }

  function toggleSelectAll() {
    const next = !allSelected;
    const ids = organizable.map((a) => a.id);
    const idSet = new Set(ids);
    setAssets((prev) => prev.map((a) => (idSet.has(a.id) ? { ...a, selected: next } : a)));
    chrome.runtime.sendMessage({ type: "aias-set-selected-many", ids, selected: next });
  }

  function rescanDownloads() {
    setRescanning(true);
    setRescanMessage("");
    chrome.runtime.sendMessage({ type: "aias-rescan-scan" }, (res) => {
      setRescanning(false);
      if (res?.error) {
        setRescanMessage(res.error);
        return;
      }
      const candidates: RescanCandidate[] = res?.candidates ?? [];
      if (candidates.length === 0) {
        setRescanMessage("No new downloads found");
        return;
      }
      setRescanCandidates(candidates);
      setRescanSelectedIds(new Set(candidates.map((c) => c.sourcePath)));
      setRescanExpandedDays(new Set()); // every day group starts collapsed
    });
  }

  function cancelRescanImport() {
    setRescanCandidates(null);
  }

  function confirmRescanImport() {
    if (!rescanCandidates) return;
    const chosen = rescanCandidates.filter((c) => rescanSelectedIds.has(c.sourcePath));
    setImportingRescan(true);
    chrome.runtime.sendMessage({ type: "aias-rescan-import", candidates: chosen }, (res) => {
      setImportingRescan(false);
      setRescanCandidates(null);
      const count = res?.addedCount ?? 0;
      setRescanMessage(count > 0 ? `${count} new asset${count === 1 ? "" : "s"} imported` : "No assets imported");
    });
  }

  function patchNaming(id: string, patch: Partial<NamingFields>) {
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, naming: { ...a.naming, ...patch } } : a)));
    chrome.runtime.sendMessage({ type: "aias-update-naming", id, patch });
  }

  function updateSource(id: string, source: string) {
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, source } : a)));
    chrome.runtime.sendMessage({ type: "aias-update-source", id, source });
  }

  function applyDefaultsToSelected() {
    const defaults = {
      project: session.batchDefaultProject,
      sequence: session.batchDefaultSequence,
      bucketId: session.batchDefaultBucketId,
    };
    setAssets((prev) => prev.map((a) => (a.selected && ORGANIZABLE.has(a.status) ? { ...a, naming: { ...a.naming, ...defaults } } : a)));
    chrome.runtime.sendMessage({ type: "aias-apply-defaults-to-selected", defaults });
  }

  /** Untracks a single asset — never touches the real file on disk (§4). */
  function removeAsset(id: string) {
    setAssets((prev) => prev.filter((a) => a.id !== id));
    chrome.runtime.sendMessage({ type: "aias-remove-asset", id });
  }

  /** Deletes every tracked asset regardless of status (§3) — requires a
   * second click within a few seconds to confirm, since it's irreversible
   * for not-yet-organized work. */
  function emptyInbox() {
    if (!confirmingEmptyInbox) {
      setConfirmingEmptyInbox(true);
      return;
    }
    setConfirmingEmptyInbox(false);
    setAssets([]);
    chrome.runtime.sendMessage({ type: "aias-empty-inbox" });
  }

  function organize() {
    setOrganizing(true);
    setOrganizeError("");
    const ids = selected.map((a) => a.id);
    chrome.runtime.sendMessage({ type: "aias-organize", ids }, (res) => {
      setOrganizing(false);
      if (!res?.ok) setOrganizeError(res?.error ?? "Organize failed");
    });
  }

  return (
    <div style={{ minHeight: "100vh" }}>
      <div className="aias-app aias-inbox-shell" style={{ maxWidth: 1020, margin: "0 auto" }}>
        <div className="aias-row" style={{ alignItems: "flex-start" }}>
          <div>
            <h1 className="aias-title" style={{ fontSize: 20 }}>
              {organizable.length} new asset{organizable.length === 1 ? "" : "s"}
            </h1>
            <p className="aias-subtext" style={{ margin: 0 }}>
              Downloaded files stay in Downloads until you organize them.
            </p>
          </div>
          <div className="aias-row" style={{ gap: 8 }}>
            <strong>Watch Mode</strong>
            <label className="aias-toggle">
              <input
                type="checkbox"
                checked={session.aiSessionEnabled}
                onChange={(e) => toggleSession(e.target.checked)}
              />
              <span className="aias-toggle-track" />
            </label>
          </div>
        </div>

        <div className="aias-card">
          <p className="aias-card-title">Default root</p>
          {editingRoot ? (
            <div style={{ display: "flex", gap: 6 }}>
              <input
                className="aias-input"
                style={{ margin: 0 }}
                value={rootDraft}
                onChange={(e) => setRootDraft(e.target.value)}
                placeholder={pathSep === "\\" ? "D:\\AI_Projects" : "/Users/you/AI_Projects"}
              />
              <button className="aias-btn" onClick={saveRoot}>
                Save
              </button>
            </div>
          ) : (
            <div className="aias-row">
              <span className="aias-mono" style={{ flex: 1 }}>
                {defaultRoot || "(not set)"}
              </span>
              <button className="aias-btn aias-btn-ghost" disabled={pickingRoot} onClick={browseForRoot}>
                {pickingRoot ? "Waiting…" : "Edit"}
              </button>
            </div>
          )}
          {pickerError && <p className="aias-subtext">{pickerError}</p>}
        </div>

        <div className="aias-card">
          <p className="aias-card-title">Workspace</p>
          <div className="aias-row-2col" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <Field
              label="Project"
              optional
              value={session.batchDefaultProject}
              onChange={(v) => updateBatchDefault("batchDefaultProject", v)}
            />
            <Field
              label="Sequence"
              optional
              value={session.batchDefaultSequence}
              onChange={(v) => updateBatchDefault("batchDefaultSequence", v)}
            />
            <label className="aias-field">
              Category
              <span className="aias-field-optional">optional</span>
              <Combobox
                value={session.batchDefaultBucketId}
                options={CATEGORY_SUGGESTIONS}
                placeholder="Generated"
                onChange={(v) => updateBatchDefault("batchDefaultBucketId", v)}
              />
            </label>
          </div>
          <div className="aias-row" style={{ marginTop: 10 }}>
            <span className="aias-subtext" style={{ margin: 0 }}>
              {selected.length} selected
            </span>
            <button className="aias-btn aias-btn-ghost" disabled={selected.length === 0} onClick={applyDefaultsToSelected}>
              Apply defaults to selected
            </button>
          </div>
        </div>

        {assets.length === 0 && (
          <div className="aias-card">
            <p className="aias-subtext" style={{ margin: 0 }}>
              No downloads yet. Turn Watch Mode on and download an image or video.
            </p>
          </div>
        )}

        {assets.length > 0 && (
          <div className="aias-inbox-split">
            <div className="aias-inbox-list-pane">
              <div className="aias-inbox-list-header">
                <div className="aias-row">
                  <p className="aias-card-title" style={{ margin: 0 }}>
                    Inbox
                  </p>
                  <span className="aias-subtext" style={{ margin: 0 }}>
                    {assets.length} file{assets.length === 1 ? "" : "s"}
                  </span>
                </div>
                {rescanMessage && (
                  <p className="aias-subtext" style={{ margin: "4px 0 0" }}>
                    {rescanMessage}
                  </p>
                )}
                <div className="aias-inbox-list-actions">
                  <button className="aias-btn aias-btn-ghost aias-btn-sm" disabled={rescanning} onClick={rescanDownloads}>
                    {rescanning ? "Scanning…" : "Rescan Downloads"}
                  </button>
                  <button className="aias-btn aias-btn-ghost aias-btn-sm" onClick={emptyInbox}>
                    {confirmingEmptyInbox ? "Click again to confirm" : "Empty Inbox"}
                  </button>
                  <button
                    className="aias-btn aias-btn-ghost aias-btn-sm"
                    disabled={organizable.length === 0}
                    onClick={toggleSelectAll}
                  >
                    {allSelected ? "Deselect all" : "Select all"}
                  </button>
                </div>
              </div>

              <div className="aias-inbox-list">
                {assets.map((asset) => {
                  const rowDisabled = !ORGANIZABLE.has(asset.status);
                  return (
                    <div
                      key={asset.id}
                      className={`aias-inbox-row${asset.id === focusedAssetId ? " active" : ""}`}
                      onClick={() => setFocusedAssetId(asset.id)}
                    >
                      <input
                        type="checkbox"
                        className="aias-checkbox-lg"
                        checked={asset.selected && !rowDisabled}
                        disabled={rowDisabled}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => toggleAssetSelected(asset.id, e.target.checked)}
                      />
                      <div className="aias-inbox-row-text">
                        <strong>{asset.originalFilename}</strong>
                        <p className="aias-subtext" style={{ margin: "2px 0 0" }}>
                          {asset.source ? asset.source.toLowerCase() : "no source"} · {formatTime(asset.downloadedAt)}
                        </p>
                      </div>
                      <span
                        className={`aias-badge aias-inbox-row-badge${asset.status === "organized" ? " aias-badge-on" : ""}`}
                      >
                        <span className="aias-badge-dot" />
                        {STATUS_LABEL(asset.status)}
                      </span>
                      <button
                        type="button"
                        className="aias-inbox-row-dismiss"
                        disabled={asset.status === "organizing"}
                        title={
                          asset.status === "organizing"
                            ? "Can't remove while organizing"
                            : "Remove from Inbox (keeps the file in Downloads)"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          removeAsset(asset.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="aias-inbox-detail-pane">
              {!focusedAsset && <p className="aias-inbox-empty-detail">Select a file on the left to edit it.</p>}
              {focusedAsset && (() => {
                const asset = focusedAsset;
                const preview = computePreview(asset, defaultRoot, indexCounters, buckets, pathSep);
                const disabled = !ORGANIZABLE.has(asset.status);
                return (
                  <>
                    <div className="aias-row" style={{ alignItems: "flex-start" }}>
                      <div className="aias-asset-header">
                        <Thumbnail asset={asset} />
                        <div>
                          <strong>{asset.originalFilename}</strong>
                          <p className="aias-subtext" style={{ margin: "2px 0 0" }}>
                            {asset.source ? asset.source.toUpperCase() : "UNKNOWN SOURCE"} ·{" "}
                            {asset.extension.replace(".", "").toUpperCase()} · downloaded {formatDateTime(asset.downloadedAt)}
                          </p>
                        </div>
                      </div>
                      <div className="aias-asset-header-actions">
                        <button
                          className="aias-btn aias-btn-outline aias-btn-sm"
                          disabled={asset.browserDownloadId == null}
                          title={
                            asset.browserDownloadId == null
                              ? "Not available for files found via Rescan folder scan"
                              : undefined
                          }
                          onClick={() => {
                            if (asset.browserDownloadId != null) chrome.downloads.open(asset.browserDownloadId);
                          }}
                        >
                          Open file
                        </button>
                      </div>
                    </div>

                    {asset.status === "failed" && asset.errorMessage && (
                      <p className="aias-subtext" style={{ color: "#b3413f" }}>
                        {asset.errorMessage}
                      </p>
                    )}

                    <div
                      className={`aias-row-2col${disabled ? " aias-disabled" : ""}`}
                      style={{ marginTop: 8, gridTemplateColumns: "1fr 1fr 1fr" }}
                    >
                      <Field
                        label="Shot / Asset Name"
                        optional
                        disabled={disabled}
                        value={asset.naming.shot}
                        onChange={(v) => patchNaming(asset.id, { shot: v })}
                      />
                      <Field
                        label="Description"
                        optional
                        disabled={disabled}
                        value={asset.naming.description}
                        placeholder="closeup, wide shot, ..."
                        onChange={(v) => patchNaming(asset.id, { description: v })}
                      />
                      <label className="aias-field">
                        Source
                        <span className="aias-field-optional">optional</span>
                        <Combobox
                          value={asset.source}
                          options={SOURCE_SUGGESTIONS}
                          placeholder="ChatGPT"
                          disabled={disabled}
                          onChange={(v) => updateSource(asset.id, v)}
                        />
                      </label>
                    </div>

                    <div className={disabled ? "aias-disabled" : ""}>
                      <div className="aias-row" style={{ marginTop: 12 }}>
                        <p className="aias-card-title" style={{ margin: 0 }}>
                          Filename
                        </p>
                        <Segmented
                          value={asset.naming.customFilenameEnabled}
                          disabled={disabled}
                          // Deliberately no auto-fill here (unlike Folder's toggle) — switching to
                          // Custom starts from a genuinely blank input, not a pre-written default.
                          onChange={(v) => patchNaming(asset.id, { customFilenameEnabled: v })}
                        />
                      </div>
                      {!asset.naming.customFilenameEnabled && (
                        <div className="aias-chip-row" style={{ marginTop: 6 }}>
                          {NAMING_TOKENS.map((t) => {
                            const active = activeNamingTokens(asset.naming.namingTemplate).has(t.key);
                            return (
                              <button
                                key={t.key}
                                type="button"
                                disabled={disabled}
                                className={`aias-chip${active ? " active" : ""}`}
                                onClick={() => {
                                  const tokens = activeNamingTokens(asset.naming.namingTemplate);
                                  if (active) {
                                    if (tokens.size === 1) return; // keep at least one token active
                                    tokens.delete(t.key);
                                  } else {
                                    tokens.add(t.key);
                                  }
                                  patchNaming(asset.id, { namingTemplate: buildTemplateFromTokens(tokens) });
                                }}
                              >
                                {t.label} {active ? "✓" : "+"}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <input
                          className="aias-input"
                          style={{ margin: 0, flex: 1 }}
                          disabled={disabled}
                          value={asset.naming.customFilenameEnabled ? asset.naming.customFilename : preview.filenameBasePreview}
                          placeholder="hero_woman_master"
                          onChange={(e) => patchNaming(asset.id, { customFilenameEnabled: true, customFilename: e.target.value })}
                        />
                        <span className="aias-subtext" style={{ alignSelf: "center", margin: 0 }}>
                          {asset.extension}
                        </span>
                      </div>

                      <div className="aias-row" style={{ marginTop: 12 }}>
                        <p className="aias-card-title" style={{ margin: 0 }}>
                          Folder
                        </p>
                        <Segmented
                          value={asset.naming.customDirectoryEnabled ?? false}
                          disabled={disabled}
                          onChange={(v) =>
                            patchNaming(asset.id, {
                              customDirectoryEnabled: v,
                              // Switching to Custom via the toggle (not by typing) starts
                              // from the current Auto value instead of blank — but never
                              // from a bracketed placeholder message (§ guard).
                              ...(v && !asset.naming.customDirectory && !preview.folderRelativePreview.startsWith("(")
                                ? { customDirectory: preview.folderRelativePreview }
                                : {}),
                            })
                          }
                        />
                      </div>
                      <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                        <input
                          className="aias-input"
                          style={{ margin: 0, flex: 1 }}
                          disabled={disabled}
                          value={
                            asset.naming.customDirectoryEnabled ? (asset.naming.customDirectory ?? "") : preview.folderFullPreview
                          }
                          placeholder={pathSep === "\\" ? "ClientA\\ReviewBatch2" : "ClientA/ReviewBatch2"}
                          onFocus={() => {
                            // Auto shows the fully-resolved absolute path — editing it directly
                            // would have to be re-expressed as a Root-relative value anyway, so
                            // focusing the field promotes to Custom first (seeded from the
                            // Root-relative preview, same as the segmented toggle) and every
                            // keystroke from then on edits that relative value, never the
                            // absolute text (§ Filename already works this way).
                            if (asset.naming.customDirectoryEnabled) return;
                            patchNaming(asset.id, {
                              customDirectoryEnabled: true,
                              ...(!asset.naming.customDirectory && !preview.folderRelativePreview.startsWith("(")
                                ? { customDirectory: preview.folderRelativePreview }
                                : {}),
                            });
                          }}
                          onChange={(e) => patchNaming(asset.id, { customDirectoryEnabled: true, customDirectory: e.target.value })}
                        />
                        {asset.naming.customDirectoryEnabled && (
                          <button
                            className="aias-btn aias-btn-outline aias-btn-sm"
                            disabled={disabled || pickingFolder || !defaultRoot}
                            title={!defaultRoot ? "Set a Default Root first" : undefined}
                            onClick={() => browseForFolder(asset.id)}
                          >
                            {pickingFolder ? "Browsing…" : "Browse"}
                          </button>
                        )}
                      </div>
                      {asset.naming.customDirectoryEnabled && folderPickerError && (
                        <p className="aias-subtext" style={{ color: "#b3413f" }}>
                          {folderPickerError}
                        </p>
                      )}
                      {asset.naming.customDirectoryEnabled && (
                        <p className="aias-subtext" style={{ margin: "4px 0 0", wordBreak: "break-all" }}>
                          {preview.folderFullPreview}
                        </p>
                      )}

                      <div className="aias-divider" style={{ marginTop: 24, marginBottom: 16 }} />
                      <p className="aias-card-title" style={{ marginTop: 0 }}>
                        Full path
                      </p>
                      <p className="aias-mono" style={{ margin: 0 }}>
                        {preview.fullPathPreview}
                      </p>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {organizeLog.length > 0 && (
          <div className="aias-card aias-organize-log">
            <div
              className="aias-row"
              style={{ cursor: "pointer" }}
              onClick={() => setOrganizeLogExpanded((v) => !v)}
            >
              <p className="aias-card-title" style={{ margin: 0 }}>
                {organizeLogExpanded ? "▾" : "▸"} Recently Organized ({organizeLog.length})
              </p>
            </div>
            {organizeLogExpanded &&
              organizeLog.map((entry) => (
                <div key={entry.id} className="aias-organize-log-item">
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.originalFilename} → <span className="aias-mono">{entry.finalPath || "(no destination recorded)"}</span>
                  </span>
                  <span className="aias-subtext" style={{ margin: 0, flexShrink: 0 }}>
                    {formatRelativeTime(entry.loggedAt)}
                  </span>
                </div>
              ))}
          </div>
        )}

        <div className="aias-footer" style={{ justifyContent: "flex-start" }}>
          <AgentBadge status={agentStatus} />
        </div>
      </div>

      {organizable.length > 0 && (
        <div className="aias-organize-bar">
          <div style={{ maxWidth: 1020, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <strong>{selected.length} asset{selected.length === 1 ? "" : "s"} ready</strong>
              <p className="aias-subtext" style={{ margin: 0 }}>
                Files move only after you confirm.
              </p>
              {organizeError && (
                <p className="aias-subtext" style={{ color: "#b3413f" }}>
                  {organizeError}
                </p>
              )}
            </div>
            <button
              className="aias-btn"
              disabled={selected.length === 0 || organizing || agentStatus !== "connected"}
              onClick={organize}
            >
              {organizing ? "Organizing…" : `Organize ${selected.length} Asset${selected.length === 1 ? "" : "s"}`}
            </button>
          </div>
        </div>
      )}

      {rescanCandidates && (
        <RescanImportModal
          candidates={rescanCandidates}
          selectedIds={rescanSelectedIds}
          expandedDays={rescanExpandedDays}
          importing={importingRescan}
          onToggleSelected={(id, next) =>
            setRescanSelectedIds((prev) => {
              const s = new Set(prev);
              if (next) s.add(id);
              else s.delete(id);
              return s;
            })
          }
          onToggleDay={(ids, next) =>
            setRescanSelectedIds((prev) => {
              const s = new Set(prev);
              for (const id of ids) {
                if (next) s.add(id);
                else s.delete(id);
              }
              return s;
            })
          }
          onToggleDayExpanded={(key) =>
            setRescanExpandedDays((prev) => {
              const s = new Set(prev);
              if (s.has(key)) s.delete(key);
              else s.add(key);
              return s;
            })
          }
          onSelectAll={(next) =>
            setRescanSelectedIds(next ? new Set(rescanCandidates.map((c) => c.sourcePath)) : new Set())
          }
          onCancel={cancelRescanImport}
          onConfirm={confirmRescanImport}
        />
      )}
    </div>
  );
}
