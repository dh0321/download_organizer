// Bundles the background service worker (ESM — Chrome loads it natively per
// manifest.json's "type": "module") and the content script (IIFE — classic
// content scripts cannot resolve ES module imports, so everything must be
// inlined into one self-contained file). Kept separate from vite.config.ts,
// which only builds the popup/options React pages — see that file's header
// comment for why.
import { build } from "esbuild";

await build({
  entryPoints: ["src/background/index.ts"],
  outfile: "dist/background/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome110",
});

await build({
  entryPoints: ["src/content-scripts/intentPing.ts"],
  outfile: "dist/content-scripts/intentPing.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome110",
});

console.log("background + content script bundled.");
