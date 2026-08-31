// §J Options page — Phase 1 scope only: Default Root editor + Agent connection
// status. FolderTemplate/multi-preset/bucket CRUD editors are Phase 2 (§O).

import { useEffect, useState } from "react";

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
        setSavedMessage("Saved.");
        setTimeout(() => setSavedMessage(""), 2000);
      } else {
        setSavedMessage(`Failed: ${res?.error ?? "unknown error"}`);
      }
    });
  }

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 480, margin: "24px auto" }}>
      <h1>AI Asset Saver — Settings</h1>

      <section style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 14 }}>Local Agent</h2>
        <p>
          Status:{" "}
          <strong style={{ color: status === "connected" ? "#2a2" : "#a22" }}>
            {status === "checking" ? "checking..." : status === "connected" ? "Connected" : "Not running"}
          </strong>
        </p>
        {status !== "connected" && (
          <p style={{ color: "#666" }}>
            Install and run the AI Asset Saver Agent, then reload this page. See the project README for the
            Windows installer.
          </p>
        )}
      </section>

      <section>
        <h2 style={{ fontSize: 14 }}>Default Root</h2>
        <p style={{ color: "#666" }}>Current: {defaultRoot || "(not set)"}</p>
        <input
          style={{ width: "100%", boxSizing: "border-box", marginBottom: 8 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="D:\AI_Projects or \\nas\studio\AI_Projects"
        />
        <button onClick={save}>Save</button>
        {savedMessage && <span style={{ marginLeft: 8 }}>{savedMessage}</span>}
      </section>
    </div>
  );
}
