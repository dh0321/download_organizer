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
  // Confirmed live: without this, adding jimp crashed the bundled agent.mjs
  // instantly on load with "Dynamic require of 'fs' is not supported" — a
  // well-known esbuild limitation (not specific to jimp/gifwrap) where a
  // bundled CJS dependency's own `require("fs")` call can't be statically
  // inlined into ESM output, and esbuild's fallback shim just throws unless
  // a real `require` is already in scope. createRequire supplies that real
  // one. Doesn't include a shebang line itself, so this doesn't reintroduce
  // the duplicate-shebang problem a banner once caused here before.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
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
