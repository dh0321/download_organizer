import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Builds ONLY the popup and options pages (React, ESM, normal bundler output).
// The background service worker and content script are bundled separately via
// esbuild (see build-background.mjs) because content scripts cannot load ES
// modules the way extension pages can — see intentPing.ts's header comment.
//
// root is set to src/ so the output paths are dist/popup/... and dist/options/...
// (matching manifest.json) instead of Vite's default dist/src/popup/....
export default defineConfig({
  root: path.resolve(__dirname, "src"),
  plugins: [react()],
  publicDir: path.resolve(__dirname, "public"), // copies manifest.json into dist/
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: path.resolve(__dirname, "src/popup/index.html"),
        options: path.resolve(__dirname, "src/options/index.html"),
      },
    },
  },
});
