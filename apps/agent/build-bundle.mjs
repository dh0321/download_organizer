// Bundles the Agent (src/index.ts + @download-organizer/shared) into a single
// self-contained .mjs file with no node_modules dependency at runtime. This is
// what lets the installed Agent live OUTSIDE the dev repo (e.g. under
// ~/Library/Application Support on macOS) instead of needing to be launched
// from inside the monorepo via tsx — which matters concretely on macOS: a repo
// under ~/Desktop (or ~/Documents/~/Downloads) is TCC-protected, and Chrome's
// child process (the native messaging host) gets denied file-read-data on
// anything under there unless the user grants Chrome Desktop-folder access.
// Bundling once and installing the artifact elsewhere avoids needing that
// permission grant at all.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist-bundle/agent.mjs",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  // No banner needed — esbuild already preserves src/index.ts's own leading
  // "#!/usr/bin/env node" shebang line into the bundled output. Adding one
  // here too produced a duplicate shebang line, which Node's parser rejects.
});

console.log("Agent bundled to dist-bundle/agent.mjs");

// A second, CommonJS-format bundle exists solely as pkg's input (see
// installer/package-windows.mjs) — pkg's Windows/exe packaging has a history
// of flaky ESM support, while CJS is its well-trodden path. ".cjs" extension
// is required since this package.json has "type": "module" — a plain ".js"
// file here would otherwise be parsed as ESM and reject `require`/module.exports.
await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist-bundle/agent.cjs",
  bundle: true,
  format: "cjs",
  platform: "node",
  // Matches package:win's pkg target (node22) — @yao-pkg/pkg-fetch's current
  // release only ships prebuilt base binaries for Node 22/24/26, not 20.
  target: "node22",
});

console.log("Agent bundled to dist-bundle/agent.cjs (for pkg)");
