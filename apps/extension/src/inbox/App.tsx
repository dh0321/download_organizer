// §7 Inbox UI — the full Download → Inbox → Edit → Organize surface. Default
// Root, Batch Defaults, the Pending Asset list, and the Organize action all
// live here; the popup only shows a summary + "Open Inbox" (see ../popup/App.tsx).

import { useEffect, useMemo, useState } from "react";
import {
  buildFilename,
  splitCustomDirectorySegments,
  type AssetBucket,
  type NamingFields,
  type PendingAsset,
  type SessionState,
} from "@ai-asset-saver/shared";
import { loadSessionState, saveSessionState, DEFAULT_SESSION_STATE } from "../background/sessionManager.js";
import { loadPendingAssets } from "../background/pendingAssetsStorage.js";
import { pendingAssetIndexKey } from "../background/jobManager.js";
import { PENDING_ASSETS_STORAGE_KEY, SESSION_STORAGE_KEY, INDEX_COUNTERS_STORAGE_KEY } from "../background/storageKeys.js";
import { AgentBadge, type AgentStatus } from "../components/AgentBadge.js";
import { Field } from "../components/Field.js";
import { Segmented } from "../components/Segmented.js";
import "../styles/theme.css";

const DEFAULT_BUCKETS: AssetBucket[] = [
  { id: "generated", label: "Generated", order: 0 },
  { id: "reference", label: "Reference", order: 1 },
  { id: "select", label: "Select", order: 2 },
  { id: "final", label: "Final", order: 3 },
];

const ORGANIZABLE = new Set(["pending", "failed"]);

// buildFilename() already handles any {token} combination generically (see
// naming.ts), so letting the user freely toggle which tokens are in the
// template needs no shared/background changes — just building the template
// string client-side from whichever tokens are active. Fixed reading order
// (shot, description, source, index) regardless of toggle order.
const NAMING_TOKENS = [
  { key: "shot", label: "Shot" },
  { key: "description", label: "Description" },
  { key: "source", label: "Source" },
  { key: "index", label: "Index" },
] as const;

const SOURCE_SUGGESTIONS = ["ChatGPT", "Gemini"];

function activeNamingTokens(template: string): Set<string> {
  return new Set(NAMING_TOKENS.filter((t) => template.includes(`{${t.key}}`)).map((t) => t.key));
}

function buildTemplateFromTokens(tokens: Set<string>): string {
  return NAMING_TOKENS.filter((t) => tokens.has(t.key))
    .map((t) => `{${t.key}}`)
    .join("_");
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
function computePreview(
  asset: PendingAsset,
  defaultRoot: string,
  indexCounters: Record<string, number>,
  buckets: AssetBucket[],
): { folderRelativePreview: string; filenameBasePreview: string; fullPathPreview: string } {
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
  } else if (!asset.naming.project.trim()) {
    folderMessage = "(set Project in Batch Defaults)";
  } else {
    folderSegments = [asset.naming.project, asset.naming.sequence, asset.naming.shot, bucketLabel].filter(Boolean);
  }

  const folderRelativePreview = folderMessage ?? folderSegments.join("\\");
  const folderFullPreview = !defaultRoot
    ? "(set a Default Root)"
    : (folderMessage ?? [defaultRoot, ...folderSegments].join("\\"));

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
    !defaultRoot || folderMessage ? folderFullPreview : `${folderFullPreview}\\${filenameFullPreview}`;
  return { folderRelativePreview, filenameBasePreview, fullPathPreview };
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
  const [buckets] = useState<AssetBucket[]>(DEFAULT_BUCKETS);

  useEffect(() => {
    loadSessionState().then(setSession);
    loadPendingAssets().then((map) => setAssets(Object.values(map)));
    chrome.storage.local.get(INDEX_COUNTERS_STORAGE_KEY).then((result) => {
      setIndexCounters((result[INDEX_COUNTERS_STORAGE_KEY] as Record<string, number>) ?? {});
    });
    chrome.runtime.sendMessage({ type: "aias-get-display-settings" }, (res) => {
      if (res?.ok) setDefaultRoot(res.settings.defaultRoot ?? "");
    });
    chrome.runtime.sendMessage({ type: "aias-ping-agent" }, (res) => {
      setAgentStatus(res?.connected ? "connected" : "disconnected");
    });

    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName !== "local") return;
      if (changes[PENDING_ASSETS_STORAGE_KEY]) {
        setAssets(Object.values(changes[PENDING_ASSETS_STORAGE_KEY].newValue ?? {}));
      }
      if (changes[SESSION_STORAGE_KEY]) {
        setSession({ ...DEFAULT_SESSION_STATE, ...changes[SESSION_STORAGE_KEY].newValue });
      }
      if (changes[INDEX_COUNTERS_STORAGE_KEY]) {
        setIndexCounters(changes[INDEX_COUNTERS_STORAGE_KEY].newValue ?? {});
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  const organizable = useMemo(() => assets.filter((a) => ORGANIZABLE.has(a.status)), [assets]);
  const selected = useMemo(() => organizable.filter((a) => a.selected), [organizable]);
  const allSelected = organizable.length > 0 && selected.length === organizable.length;

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
        setPickerError(res?.error ?? "Couldn't open the folder picker — Agent may not be running.");
        setRootDraft(defaultRoot);
        setEditingRoot(true);
      }
    });
  }

  function toggleAssetSelected(id: string, next: boolean) {
    setAssets((prev) => prev.map((a) => (a.id === id ? { ...a, selected: next } : a)));
    chrome.runtime.sendMessage({ type: "aias-set-selected", id, selected: next });
  }

  function toggleSelectAll() {
    const next = !allSelected;
    setAssets((prev) => prev.map((a) => (ORGANIZABLE.has(a.status) ? { ...a, selected: next } : a)));
    chrome.runtime.sendMessage({ type: "aias-set-all-selected", selected: next });
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
      {/* Shared by every asset card's Source input (list="aias-source-options") —
          a fixed suggestion list that still allows freely typing any value. */}
      <datalist id="aias-source-options">
        {SOURCE_SUGGESTIONS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <div className="aias-app aias-inbox-shell" style={{ maxWidth: 760, margin: "0 auto" }}>
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
            <strong>AI Session</strong>
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
                placeholder="D:\AI_Projects"
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
          <p className="aias-card-title">Batch defaults</p>
          <div className="aias-row-2col" style={{ gridTemplateColumns: "1fr 1fr 1fr" }}>
            <Field
              label="Project"
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
              Save As
              <select
                className="aias-select"
                value={session.batchDefaultBucketId}
                onChange={(e) => updateBatchDefault("batchDefaultBucketId", e.target.value)}
              >
                {buckets.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
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

        <div className="aias-row" style={{ marginTop: 4 }}>
          <p className="aias-card-title" style={{ margin: 0 }}>
            Inbox
          </p>
          <button className="aias-btn aias-btn-ghost" disabled={organizable.length === 0} onClick={toggleSelectAll}>
            {allSelected ? "Deselect all" : "Select all"}
          </button>
        </div>

        {assets.length === 0 && (
          <div className="aias-card">
            <p className="aias-subtext" style={{ margin: 0 }}>
              No AI downloads yet. Turn AI Session on and download an image or video from ChatGPT or Gemini.
            </p>
          </div>
        )}

        {assets.map((asset) => {
          const preview = computePreview(asset, defaultRoot, indexCounters, buckets);
          const disabled = !ORGANIZABLE.has(asset.status);
          return (
            <div key={asset.id} className="aias-card">
              <div className="aias-row" style={{ alignItems: "flex-start" }}>
                <div className="aias-asset-header">
                  <input
                    type="checkbox"
                    className="aias-checkbox-lg"
                    checked={asset.selected && !disabled}
                    disabled={disabled}
                    onChange={(e) => toggleAssetSelected(asset.id, e.target.checked)}
                  />
                  <Thumbnail asset={asset} />
                  <div>
                    <strong>{asset.originalFilename}</strong>
                    <p className="aias-subtext" style={{ margin: "2px 0 0" }}>
                      {asset.source.toUpperCase()} · {asset.extension.replace(".", "").toUpperCase()} · downloaded{" "}
                      {formatTime(asset.downloadedAt)}
                    </p>
                  </div>
                </div>
                <div className="aias-asset-header-actions">
                  <span className={`aias-badge${asset.status === "organized" ? " aias-badge-on" : ""}`}>
                    <span className="aias-badge-dot" />
                    {STATUS_LABEL(asset.status)}
                  </span>
                  <button
                    className="aias-btn aias-btn-outline aias-btn-sm"
                    onClick={() => chrome.downloads.open(asset.browserDownloadId)}
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
                  label="Shot"
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
                  <input
                    className="aias-input"
                    disabled={disabled}
                    value={asset.source}
                    list="aias-source-options"
                    placeholder="ChatGPT"
                    onChange={(e) => updateSource(asset.id, e.target.value)}
                  />
                </label>
              </div>

              <div className={disabled ? "aias-disabled" : ""}>
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
                <input
                  className="aias-input"
                  style={{ marginTop: 6 }}
                  disabled={disabled}
                  value={asset.naming.customDirectoryEnabled ? (asset.naming.customDirectory ?? "") : preview.folderRelativePreview}
                  placeholder="ClientA\ReviewBatch2"
                  onChange={(e) => patchNaming(asset.id, { customDirectoryEnabled: true, customDirectory: e.target.value })}
                />

                <div className="aias-row" style={{ marginTop: 12 }}>
                  <p className="aias-card-title" style={{ margin: 0 }}>
                    Filename
                  </p>
                  <Segmented
                    value={asset.naming.customFilenameEnabled}
                    disabled={disabled}
                    onChange={(v) =>
                      patchNaming(asset.id, {
                        customFilenameEnabled: v,
                        ...(v && !asset.naming.customFilename && !preview.filenameBasePreview.startsWith("(")
                          ? { customFilename: preview.filenameBasePreview }
                          : {}),
                      })
                    }
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

                <p className="aias-card-title" style={{ marginTop: 12 }}>
                  Full path
                </p>
                <p className="aias-mono" style={{ margin: 0 }}>
                  {preview.fullPathPreview}
                </p>
              </div>
            </div>
          );
        })}

        <div className="aias-footer" style={{ justifyContent: "flex-start" }}>
          <AgentBadge status={agentStatus} />
        </div>
      </div>

      {organizable.length > 0 && (
        <div className="aias-organize-bar">
          <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
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
    </div>
  );
}
