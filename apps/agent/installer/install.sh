#!/bin/bash
# macOS equivalent of install.ps1 — see that file's header for the shared
# rationale (Chrome launches the Agent per Native Messaging connection; there
# is no background service or login item to install, on any platform).
#
# Usage:
#   ./install.sh --extension-id <id> [--default-root <path>] [--install-dir <path>]
#
# This bundles the Agent into a single self-contained .mjs file (via esbuild —
# see ../build-bundle.mjs) and installs it OUTSIDE the dev repo (default:
# ~/Library/Application Support/DownloadOrganizer/bin). This matters concretely if
# the repo lives under ~/Desktop, ~/Documents, or ~/Downloads: those are
# TCC-protected on modern macOS, and Chrome's native-messaging child process
# gets a silent `file-read-data` sandbox denial reading anything under them
# unless the user has explicitly granted Chrome folder access in System
# Settings — which surfaces as the confusing "Native host has exited." error
# with no further detail. Installing the bundled artifact elsewhere avoids
# needing that permission grant at all.
set -euo pipefail

usage() {
  echo "Usage: $0 --extension-id <id> [--default-root <path>] [--install-dir <path>]" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$SCRIPT_DIR/.."
INSTALL_DIR="$HOME/Library/Application Support/DownloadOrganizer/bin"
EXTENSION_ID=""
DEFAULT_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension-id) EXTENSION_ID="$2"; shift 2 ;;
    --default-root) DEFAULT_ROOT="$2"; shift 2 ;;
    --install-dir) INSTALL_DIR="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -z "$EXTENSION_ID" ]] && usage

# Real Chrome extension IDs are exactly 32 lowercase letters a-p — catch a
# typo/paste error here instead of letting it surface later as a confusing
# "REJECTED connection from unexpected origin" in the Agent's log.
if [[ ! "$EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
  echo "Error: '$EXTENSION_ID' doesn't look like a real Chrome extension ID (expected exactly 32 lowercase letters a-p). Copy it from chrome://extensions again." >&2
  exit 1
fi

echo "Bundling Agent..."
(cd "$AGENT_DIR" && npm run bundle --silent)

mkdir -p "$INSTALL_DIR"
cp "$AGENT_DIR/dist-bundle/agent.mjs" "$INSTALL_DIR/agent.mjs"
chmod +x "$INSTALL_DIR/agent.mjs"

WRAPPER_PATH="$INSTALL_DIR/DownloadOrganizerAgent.sh"
cat > "$WRAPPER_PATH" <<'SH'
#!/bin/bash
# Chrome launches this as a GUI-app child process, which gets a minimal PATH
# (no ~/.zshrc, no Homebrew) — prepend the common Homebrew locations
# explicitly rather than relying on the inherited environment.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/agent.mjs" "$@"
SH
chmod +x "$WRAPPER_PATH"
echo "Installed bundled Agent to: $INSTALL_DIR"

MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$MANIFEST_DIR"
MANIFEST_PATH="$MANIFEST_DIR/com.download_organizer.agent.json"

cat > "$MANIFEST_PATH" <<JSON
{
  "name": "com.download_organizer.agent",
  "description": "Download Organizer Local Agent",
  "path": "$WRAPPER_PATH",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXTENSION_ID/"]
}
JSON
echo "Registered native messaging manifest: $MANIFEST_PATH"

CONFIG_DIR="$HOME/.config/DownloadOrganizer"
mkdir -p "$CONFIG_DIR"

CONFIG_PATH="$CONFIG_DIR/config.json"

if [[ -n "$DEFAULT_ROOT" ]]; then
  mkdir -p "$DEFAULT_ROOT"

  if [[ -f "$CONFIG_PATH" ]]; then
    # Re-running the installer (e.g. the extension got reloaded and received a
    # new ID) must never reset settings the user already customized from the
    # Extension's Settings UI — only patch the two fields the installer
    # actually owns (allowedExtensionId can never be set any other way; see
    # agentConfig.ts's applySyncSettings), leaving everything else untouched.
    if ! python3 - "$CONFIG_PATH" "$DEFAULT_ROOT" "$EXTENSION_ID" <<'PY'
import json, sys
path, default_root, extension_id = sys.argv[1:4]
with open(path) as f:
    config = json.load(f)
config["defaultRoot"] = default_root
config["allowedExtensionId"] = extension_id
with open(path, "w") as f:
    json.dump(config, f, indent=2)
PY
    then
      echo "Error: existing config.json at '$CONFIG_PATH' isn't valid JSON, so it can't be safely updated in place. Back it up, delete it, and re-run this script to reseed defaults." >&2
      exit 1
    fi
    echo "Updated existing config.json: defaultRoot + allowedExtensionId only (folderTemplate/assetBuckets/conflictPolicy/maxConcurrentFileOps left untouched)."
  else
    cat > "$CONFIG_PATH" <<JSON
{
  "defaultRoot": "$DEFAULT_ROOT",
  "folderTemplate": {
    "id": "default",
    "name": "Project / Sequence",
    "levels": [
      { "key": "project", "label": "Project", "order": 0, "required": false },
      { "key": "sequence", "label": "Sequence", "order": 1, "required": false }
    ]
  },
  "assetBuckets": [
    { "id": "generated", "label": "Generated", "order": 0 },
    { "id": "reference", "label": "Reference", "order": 1 },
    { "id": "character", "label": "Character", "order": 2 },
    { "id": "environment", "label": "Environment", "order": 3 },
    { "id": "prop", "label": "Prop", "order": 4 },
    { "id": "turntable", "label": "Turntable", "order": 5 },
    { "id": "concept", "label": "Concept", "order": 6 },
    { "id": "final", "label": "Final", "order": 7 }
  ],
  "conflictPolicy": "uniquify",
  "maxConcurrentFileOps": 2,
  "allowedExtensionId": "$EXTENSION_ID"
}
JSON
    echo "Seeded new AgentConfig: defaultRoot=$DEFAULT_ROOT at $CONFIG_PATH"
  fi
else
  echo "No --default-root given — Agent will start ROOT_NOT_CONFIGURED until set from the popup/options page."
fi

echo "Done. No background service or login item installed (none is needed)."
echo "Re-run this script any time Agent source changes, to rebuild and reinstall the bundle."
