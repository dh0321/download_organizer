# AI Asset Saver

Chrome (Windows) extension that automatically renames and routes AI-generated
images/videos from ChatGPT and Gemini into project folders, only while "AI
Session" is on. See `PLAN.md` for the original v1 plan and the plan-mode
history for the current design (Root Sandbox Policy, concurrent-download job
queue, etc.).

## Structure

```
packages/shared/   Pure TS: sanitize/naming/path/index-reservation logic + shared types.
                    Used by BOTH the extension and the agent — the single source
                    of truth so the popup's preview can never drift from what the
                    Agent actually writes to disk.
apps/agent/         Windows Local Agent (Node.js/TS). Owns Default Root/FolderTemplate
                    (Root Sandbox Policy — see fileRouter.ts) and does the actual
                    filesystem work via Native Messaging.
apps/extension/     Chrome MV3 extension: background service worker, popup,
                    options page, content script, per-site adapters.
```

## Setup

```
npm install
```

## Testing

```
npm run test          # runs every workspace's vitest suite
```

As of this writing: 31 tests in `packages/shared`, 37 in `apps/agent`, 39 in
`apps/extension` — all runnable on macOS/Linux/Windows alike, since they cover
pure logic and mocked/real-tmp-dir filesystem behavior, not live Chrome APIs.

**What is NOT covered by these tests** (needs a real Windows machine and/or a
real Chrome browser — see PLAN.md §Q "Risks / Unknowns" and the Phase 0 spike):

- Real `chrome.downloads` event shapes for actual ChatGPT/Gemini downloads
  (the intent-ping correlation heuristic in `adapters/base.ts` is unverified
  against live sites).
- Native Messaging registration end-to-end (this repo cannot run Chrome or
  touch the Windows registry).
- Windows-specific filesystem behavior: MAX_PATH truncation at the real limit,
  a genuine NTFS junction escape, a disconnected mapped network drive/NAS
  timing out. The equivalent logic is tested with symlinks/tmp dirs on macOS,
  which exercises the same code paths but not the OS-specific edge cases.

## Building the extension

```
cd apps/extension
npm run build     # vite build (popup/options) + esbuild (background/content-script)
```

Output lands in `apps/extension/dist/` with the exact layout `manifest.json`
expects (`background/index.js`, `content-scripts/intentPing.js`,
`popup/index.html`, `options/index.html`). Load it via
`chrome://extensions` → Developer mode → "Load unpacked" → select `dist/`.

Before doing this for real development, pin a `"key"` field in
`apps/extension/public/manifest.json` so the extension ID stays stable across
reloads (the Native Messaging host's `allowed_origins` is keyed to it).

## Running the Agent locally (development, not Windows-specific)

```
cd apps/agent
npx tsx src/index.ts   # or: npm run build && node dist/index.js
```

Set `AIAS_ALLOWED_EXTENSION_ID` to your dev extension's ID so the Agent's
own origin check (§F-2 defense-in-depth) doesn't reject it. `%APPDATA%` (or
`~/.config` outside Windows) will get an `AIAssetSaver/config.json` written to
it on first `sync-settings` call.

## Installing the Agent on Windows

There are two ways to get an executable for the native-messaging-host manifest
to point at. For a first end-to-end test, skip packaging entirely and use a
`.bat` wrapper around Node — it's faster to iterate on and needs nothing beyond
Node.js itself:

### Quick path: test with Node directly (no packaging)

1. Install [Node.js LTS](https://nodejs.org) on the Windows machine.
2. Copy this whole repo over (or `git clone` it) and run, in **PowerShell**:
   ```powershell
   npm install
   cd apps\agent
   npm run build          # tsc -> apps\agent\dist\index.js
   ```
3. Create `apps\agent\AIAssetSaverAgent.bat` next to `dist\`:
   ```bat
   @echo off
   node "%~dp0dist\index.js" %*
   ```
   (Chrome's native-messaging manifest `path` can point at a `.bat` — Windows
   resolves it through `cmd.exe` transparently. This avoids needing `pkg`/Node
   SEA cross-compilation just to test.)
4. Build and load the extension unpacked (see above), then copy its **Extension
   ID** from `chrome://extensions` (it will likely differ from any ID you got
   loading it on another machine, unless a `"key"` is pinned in the manifest).
5. In an elevated-or-not PowerShell (no admin needed — this only touches HKCU):
   ```powershell
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass  # only for this session
   apps\agent\installer\install.ps1 -ExtensionId <extension-id-from-step-4> `
     -AgentExePath "C:\full\path\to\apps\agent\AIAssetSaverAgent.bat" `
     -DefaultRoot "D:\AI_Projects"
   ```
   **Always pass `-DefaultRoot`** on this first run (even a placeholder you'll
   change later from the popup) — it's what seeds `config.json`'s
   `allowedExtensionId`; without it the Agent stays `"unconfigured"` and
   rejects every real connection (this is logged clearly — see below).
6. Reload the extension in `chrome://extensions`, open the popup — the
   **Agent** status line at the bottom should flip from "not running" to
   "connected" within a couple seconds.
7. Turn AI Session ON, go to ChatGPT or Gemini, download a supported
   image/video, and check it lands under the configured Default Root with the
   expected filename, and that `chrome://downloads` doesn't keep a stray
   staging entry around.

### Debugging on Windows

Chrome launches the Agent as a child process per connection with no visible
console window, so **the log file is the primary debugging tool**:

```
%APPDATA%\AIAssetSaver\agent.log
```

It records every startup, the caller-origin check result, every request
type/jobId received, and every response/error — tail it (`Get-Content -Wait
$env:APPDATA\AIAssetSaver\agent.log`) while testing. On the Extension side,
`chrome://extensions` → the "service worker" link → Console tab shows anything
the background script logged (this is how the `runtime.lastError` bug during
initial testing was caught and fixed).

### Packaging into a real `.exe` (later, for actual distribution)

Once the Node-based flow above works end-to-end, package `apps/agent` into a
single `.exe` with `pkg` (cross-compiles `win-x64` from macOS — see PLAN.md
appendix) and point `install.ps1 -AgentExePath` at that instead of the `.bat`.

**Status: the installer script and the whole Agent side have not yet been run
on a real Windows machine** — everything above is a correct-per-spec first
draft (this is exactly the Phase 0 validation PLAN.md calls out as required
before relying on it).
