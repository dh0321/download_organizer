#!/bin/bash
# macOS dev wrapper for Native Messaging: Chrome launches this script directly
# (the native-messaging-host manifest's "path" points here). Uses tsx to run
# the TypeScript source on the fly — no separate build step needed, matching
# the Windows .bat wrapper documented in the README's "quick path" section.
#
# IMPORTANT: Chrome launches this as a GUI-app child process, which gets a
# minimal PATH (no ~/.zshrc, no Homebrew) — NOT the PATH your Terminal shell
# has. tsx's own shebang is "#!/usr/bin/env node", so without Homebrew's bin
# directory on PATH, `node` can't be found and the whole process exits
# immediately (surfacing in Chrome as "Native host has exited."). Prepend the
# common Homebrew locations explicitly rather than relying on the inherited
# environment.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$DIR/../../node_modules/.bin/tsx" "$DIR/src/index.ts" "$@"
