// §3 Popup (hybrid Inbox surface, small half): AI Session toggle, Agent status,
// a "N new assets" summary, and a button that opens/focuses the full Inbox tab.
// Everything else — Default Root, Batch Defaults, per-asset editing, Organize —
// lives in the Inbox page now (see ../inbox/App.tsx).

import { useEffect, useState } from "react";
import type { SessionState } from "@ai-asset-saver/shared";
import { loadSessionState, saveSessionState, DEFAULT_SESSION_STATE } from "../background/sessionManager.js";
import { loadPendingAssets } from "../background/pendingAssetsStorage.js";
import { PENDING_ASSETS_STORAGE_KEY } from "../background/storageKeys.js";
import { AgentBadge, type AgentStatus } from "../components/AgentBadge.js";
import "../styles/theme.css";

function countOrganizable(assets: Awaited<ReturnType<typeof loadPendingAssets>>): number {
  return Object.values(assets).filter((a) => a.status === "pending" || a.status === "failed").length;
}

async function openInbox(): Promise<void> {
  const inboxUrl = chrome.runtime.getURL("inbox/index.html");
  const existing = await chrome.tabs.query({ url: inboxUrl });
  if (existing[0]?.id !== undefined) {
    await chrome.tabs.update(existing[0].id, { active: true });
    if (existing[0].windowId !== undefined) await chrome.windows.update(existing[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: inboxUrl });
  }
  window.close();
}

export function App() {
  const [session, setSession] = useState<SessionState>(DEFAULT_SESSION_STATE);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("checking");
  const [newAssetCount, setNewAssetCount] = useState(0);

  useEffect(() => {
    loadSessionState().then(setSession);
    loadPendingAssets().then((assets) => setNewAssetCount(countOrganizable(assets)));

    chrome.runtime.sendMessage({ type: "aias-ping-agent" }, (res) => {
      setAgentStatus(res?.connected ? "connected" : "disconnected");
    });

    const listener = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
      if (areaName === "local" && changes[PENDING_ASSETS_STORAGE_KEY]) {
        setNewAssetCount(countOrganizable(changes[PENDING_ASSETS_STORAGE_KEY].newValue ?? {}));
      }
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  function toggleSession(enabled: boolean) {
    setSession((prev) => {
      const next = { ...prev, aiSessionEnabled: enabled };
      void saveSessionState(next);
      return next;
    });
  }

  return (
    <div className="aias-app" style={{ width: 280 }}>
      <h1 className="aias-title">AI Asset Saver</h1>

      <div className={`aias-card${session.aiSessionEnabled ? " aias-session-card--on" : ""}`}>
        <div className="aias-row">
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
        <p className="aias-subtext">
          {session.aiSessionEnabled ? "Detects new image/video downloads" : "Normal downloads are unchanged"}
        </p>
      </div>

      <div className="aias-card">
        <p className="aias-card-title">Inbox</p>
        <p className="aias-row" style={{ margin: 0 }}>
          <span style={{ fontSize: 20, fontWeight: 800 }}>{newAssetCount}</span>
          <span className="aias-subtext" style={{ margin: 0 }}>
            new asset{newAssetCount === 1 ? "" : "s"}
          </span>
        </p>
        <button className="aias-btn" style={{ width: "100%", marginTop: 8 }} onClick={openInbox}>
          Open Inbox
        </button>
      </div>

      <div className="aias-footer">
        <AgentBadge status={agentStatus} />
      </div>
    </div>
  );
}
