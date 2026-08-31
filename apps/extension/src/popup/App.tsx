import { useEffect, useState } from "react";
import { buildFilename, buildIndexKey, type AssetBucket, type SessionState } from "@ai-asset-saver/shared";
import { loadSessionState, saveSessionState, DEFAULT_SESSION_STATE } from "../background/sessionManager.js";
import { INDEX_COUNTERS_STORAGE_KEY } from "../background/storageKeys.js";

const NAMING_TEMPLATE = "{shot}_{type}_{description}_{index}"; // Phase 1: single built-in preset (§O)
const DEFAULT_BUCKETS: AssetBucket[] = [
  { id: "generated", label: "Generated", order: 0 },
  { id: "reference", label: "Reference", order: 1 },
  { id: "select", label: "Select", order: 2 },
  { id: "final", label: "Final", order: 3 },
];

type AgentStatus = "checking" | "connected" | "disconnected";

export function App() {
  const [session, setSession] = useState<SessionState>(DEFAULT_SESSION_STATE);
  const [loaded, setLoaded] = useState(false);
  const [defaultRoot, setDefaultRoot] = useState("");
  const [buckets] = useState<AssetBucket[]>(DEFAULT_BUCKETS);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("checking");
  const [editingRoot, setEditingRoot] = useState(false);
  const [rootDraft, setRootDraft] = useState("");
  const [previewIndex, setPreviewIndex] = useState(1);

  useEffect(() => {
    loadSessionState().then((s) => {
      setSession(s);
      setLoaded(true);
    });

    chrome.runtime.sendMessage({ type: "aias-get-display-settings" }, (res) => {
      if (res?.ok) setDefaultRoot(res.settings.defaultRoot ?? "");
    });

    chrome.runtime.sendMessage({ type: "aias-ping-agent" }, (res) => {
      setAgentStatus(res?.connected ? "connected" : "disconnected");
    });
  }, []);

  useEffect(() => {
    if (!loaded) return;
    const key = buildIndexKey({
      project: session.currentProject,
      sequence: session.currentSequence,
      shot: session.currentShot,
      bucketId: session.currentBucketId,
      mediaType: "image",
    });
    chrome.storage.local.get(INDEX_COUNTERS_STORAGE_KEY).then((result) => {
      const counters = (result[INDEX_COUNTERS_STORAGE_KEY] as Record<string, number>) ?? {};
      setPreviewIndex((counters[key] ?? 0) + 1);
    });
  }, [loaded, session.currentProject, session.currentSequence, session.currentShot, session.currentBucketId]);

  function update<K extends keyof SessionState>(key: K, value: SessionState[K]) {
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

  const bucketLabel = buckets.find((b) => b.id === session.currentBucketId)?.label ?? session.currentBucketId;

  let filenamePreview = "";
  try {
    filenamePreview = buildFilename(
      NAMING_TEMPLATE,
      {
        project: session.currentProject,
        sequence: session.currentSequence,
        shot: session.currentShot,
        description: session.currentDescription,
        type: "IMG",
        index: previewIndex,
        customFilenameEnabled: session.customFilenameEnabled,
        customFilename: session.customFilename,
      },
      ".png",
    );
  } catch {
    filenamePreview = "(invalid filename — check Description/Project for unsupported characters)";
  }

  const destinationSegments = [session.currentProject, session.currentSequence, session.currentShot, bucketLabel].filter(
    Boolean,
  );

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", fontSize: 13, padding: 12, width: 320 }}>
      <h1 style={{ fontSize: 15, margin: "0 0 8px" }}>AI Asset Saver</h1>

      <section style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong>AI Session</strong>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={session.aiSessionEnabled}
            onChange={(e) => update("aiSessionEnabled", e.target.checked)}
          />
          {session.aiSessionEnabled ? "ON" : "OFF"}
        </label>
      </section>
      <p style={{ color: "#666", marginTop: 0 }}>
        {session.aiSessionEnabled ? "Automatic asset routing is active" : "Normal downloads are unchanged"}
      </p>

      <section style={{ marginBottom: 10 }}>
        <strong>DEFAULT ROOT</strong>
        {editingRoot ? (
          <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
            <input
              style={{ flex: 1 }}
              value={rootDraft}
              onChange={(e) => setRootDraft(e.target.value)}
              placeholder="D:\AI_Projects"
            />
            <button onClick={saveRoot}>Save</button>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
            <code>{defaultRoot || "(not set)"}</code>
            <button
              onClick={() => {
                setRootDraft(defaultRoot);
                setEditingRoot(true);
              }}
            >
              Edit
            </button>
          </div>
        )}
      </section>

      <section style={{ marginBottom: 10 }}>
        <strong>WORKSPACE</strong>
        <Field label="Project" required value={session.currentProject} onChange={(v) => update("currentProject", v)} />
        <Field
          label="Sequence"
          optional
          value={session.currentSequence}
          onChange={(v) => update("currentSequence", v)}
        />
        <Field label="Shot" optional value={session.currentShot} onChange={(v) => update("currentShot", v)} />
        <label style={{ display: "block", marginTop: 6 }}>
          Save As
          <select
            style={{ display: "block", width: "100%" }}
            value={session.currentBucketId}
            onChange={(e) => update("currentBucketId", e.target.value)}
          >
            {buckets.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
      </section>

      <section style={{ marginBottom: 10 }}>
        <strong>FILE NAMING</strong>
        <div style={{ marginTop: 4 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={session.customFilenameEnabled}
              onChange={(e) => update("customFilenameEnabled", e.target.checked)}
            />
            Use custom filename
          </label>
        </div>
        {session.customFilenameEnabled ? (
          <Field
            label="Filename"
            value={session.customFilename}
            onChange={(v) => update("customFilename", v)}
          />
        ) : (
          <Field
            label="Description"
            optional
            value={session.currentDescription}
            onChange={(v) => update("currentDescription", v)}
          />
        )}
      </section>

      <section style={{ marginBottom: 10 }}>
        <strong>NEXT FILE</strong>
        <div style={{ fontFamily: "monospace", marginTop: 4, wordBreak: "break-all" }}>{filenamePreview}</div>
      </section>

      <section style={{ marginBottom: 10 }}>
        <strong>SAVE DESTINATION</strong>
        <div style={{ fontFamily: "monospace", marginTop: 4, wordBreak: "break-all" }}>
          {defaultRoot || "(set a Default Root)"}
          {destinationSegments.map((seg) => (
            <div key={seg}>&nbsp;&nbsp;{seg}</div>
          ))}
        </div>
      </section>

      <footer style={{ fontSize: 11, color: agentStatus === "connected" ? "#2a2" : "#a22" }}>
        Agent:{" "}
        {agentStatus === "checking" ? "checking..." : agentStatus === "connected" ? "connected" : "not running"}
      </footer>
    </div>
  );
}

function Field(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  optional?: boolean;
}) {
  return (
    <label style={{ display: "block", marginTop: 6 }}>
      {props.label} {props.optional ? <span style={{ color: "#999" }}>optional</span> : null}
      <input
        style={{ display: "block", width: "100%", boxSizing: "border-box" }}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
      />
    </label>
  );
}
