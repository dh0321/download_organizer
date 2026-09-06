// §J Options page — Phase 1 scope only: Default Root editor + Agent connection
// status. FolderTemplate/multi-preset/bucket CRUD editors are Phase 2 (§O).

import { useEffect, useState } from "react";
import "../styles/theme.css";

export function App() {
  const [defaultRoot, setDefaultRoot] = useState("");
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<"checking" | "connected" | "disconnected">("checking");
  const [savedMessage, setSavedMessage] = useState("");

  useEffect(() => {
    chrome.runtime.sendMessage({ type: "aias-get-display-settings" }, (res) => {
      if (res?.ok) {
        setDefaultRoot(res.settings.defaultRoot ?? "");
        setDraft(res.settings.defaultRoot ?? "");
      }
    });
    chrome.runtime.sendMessage({ type: "aias-ping-agent" }, (res) => {
      setStatus(res?.connected ? "connected" : "disconnected");
    });
  }, []);

  function save() {
    chrome.runtime.sendMessage({ type: "aias-set-default-root", root: draft }, (res) => {
      if (res?.ok) {
        setDefaultRoot(draft);
        setSavedMessage("Saved");
        setTimeout(() => setSavedMessage(""), 2000);
      } else {
        setSavedMessage(`Failed: ${res?.error ?? "unknown error"}`);
      }
    });
  }

  const modifier = status === "connected" ? "aias-badge-on" : status === "checking" ? "aias-badge-neutral" : "";
  const statusText = status === "checking" ? "Checking…" : status === "connected" ? "Connected" : "Not running";

  return (
    <div style={{ minHeight: "100vh" }}>
      <div className="aias-app" style={{ maxWidth: 440, margin: "0 auto", paddingTop: 32 }}>
        <h1 className="aias-title" style={{ fontSize: 22 }}>
          Download Organizer — Settings
        </h1>

        <div className="aias-card">
          <p className="aias-card-title">Local App</p>
          <span className={`aias-badge ${modifier}`.trim()}>
            <span className="aias-badge-dot" />
            {statusText}
          </span>
          {status !== "connected" && (
            <p className="aias-subtext">
              Install and run the Download Organizer Local App, then reload this page. See the project README for the
              Windows installer.
            </p>
          )}
        </div>

        <div className="aias-card">
          <p className="aias-card-title">Default root</p>
          <p className="aias-subtext" style={{ margin: "0 0 8px" }}>
            Current: {defaultRoot || "(not set)"}
          </p>
          <input
            className="aias-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="D:\AI_Projects or \\nas\studio\AI_Projects"
          />
          <div className="aias-row" style={{ marginTop: 10 }}>
            <button className="aias-btn" onClick={save}>
              Save
            </button>
            {savedMessage && <span className="aias-subtext">{savedMessage}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
