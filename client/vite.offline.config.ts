/**
 * Vite config for the OFFLINE single-file build (spec §7).
 *
 * Produces client/dist-offline/offline.html — ONE self-contained HTML file
 * (all JS/CSS/fonts/SVG inlined) that runs from file:// with no server and
 * no network. Entry: client/offline.html -> src/offline/main-offline.tsx.
 *
 * - vite-plugin-singlefile inlines every emitted chunk/asset into the html
 *   and (removeViteModuleLoader) drops the modulepreload loader.
 * - assetsInlineLimit is maxed so the woff2 fonts referenced by
 *   src/offline/fonts-offline.css become data: URIs instead of files.
 * - No alias: the engine is reached via the relative re-export shim
 *   client/src/offline/engine/index.ts (spec §1). server.fs.allow widens
 *   dev-server file access to the repo root so `vite dev` can serve
 *   ../server/src/engine and ../shared sources; irrelevant to `vite build`.
 * - socket.io-client is never imported from the offline entry graph, so it
 *   is tree-shaken out entirely.
 */
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";

/**
 * theme.css (existing source — must not be edited) declares @font-face rules
 * against url("/fonts/...") in public/. In the single-file build those are
 * dead references to files that do not ship (publicDir is disabled below);
 * src/offline/fonts-offline.css provides the same faces as data: URIs. Strip
 * the dead blocks at build time so the emitted html contains ZERO external
 * url() references. Blocks are brace-flat, so the regex is safe.
 */
function stripPublicFontFaces(): Plugin {
  return {
    name: "offline:strip-public-font-faces",
    enforce: "pre",
    transform(code, id) {
      if (!id.split("?")[0].endsWith("theme.css")) return null;
      return {
        code: code.replace(/@font-face\s*\{[^}]*\/fonts\/[^}]*\}/g, ""),
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [
    stripPublicFontFaces(),
    react(),
    viteSingleFile({ removeViteModuleLoader: true }),
  ],
  publicDir: false, // nothing in public/ can ship inside a single file
  server: {
    port: 5174,
    fs: { allow: [path.resolve(__dirname, "..")] }, // dev: reach ../server/src/engine + ../shared
  },
  build: {
    outDir: "dist-offline",
    assetsInlineLimit: 100_000_000, // maxed — everything becomes data: URIs
    rollupOptions: { input: path.resolve(__dirname, "offline.html") },
    chunkSizeWarningLimit: 4000,
  },
});
