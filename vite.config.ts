import { defineConfig, type Plugin } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const runtimeAssets = new Map([
  ["olm.wasm", { file: "node_modules/@matrix-org/olm/olm.wasm", mime: "application/wasm" }],
  ["livekit-client.e2ee.worker.js", { file: "node_modules/livekit-client/dist/livekit-client.e2ee.worker.js", mime: "text/javascript" }],
]);

function cryptoAssets(): Plugin {
  return {
    name: "grungus-crypto-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = new URL(req.url ?? "/", "http://localhost").pathname.slice(1);
        const asset = runtimeAssets.get(name);
        if (!asset) return next();
        res.setHeader("Content-Type", asset.mime);
        res.end(readFileSync(path.join(root, asset.file)));
      });
    },
    generateBundle() {
      for (const [fileName, asset] of runtimeAssets) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(path.join(root, asset.file)) });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  root: path.join(root, "src/renderer"),
  base: "./",
  plugins: [tailwindcss(), cryptoAssets(), {
    name: "grungus-development-csp",
    transformIndexHtml(html) {
      // Vite injects style elements for HMR. Packaged builds retain the strict CSP.
      return command === "serve" ? html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'") : html;
    },
  }],
  resolve: {
    alias: Object.fromEntries(["fs", "path", "crypto"].map(name => [name, path.join(root, "src/renderer/shims/empty.ts")])),
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: {
    outDir: path.join(root, "dist"),
    emptyOutDir: false,
    target: "es2022",
    sourcemap: true,
    rolldownOptions: {
      input: {
        app: path.join(root, "src/renderer/index.html"),
        capture: path.join(root, "src/renderer/capture-picker.html"),
      },
    },
  },
}));
