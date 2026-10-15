/*
 * Grungus — esbuild build script.
 *
 * Three outputs into dist/:
 *   main.js     Electron main process (CJS — package.json "main")
 *   preload.js preload bridge (CJS, sandbox-compatible single file)
 *   renderer.js the whole renderer as ONE classic-script IIFE — no ES
 *              modules, because Chromium/Electron block module scripts
 *              loaded from file:// (CORS), and the app loads via loadFile.
 *
 * Plus static copies: index.html and styles/.
 *
 * Run: npm run build
 */
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

const common = {
  bundle: true,
  sourcemap: "external",
  logLevel: "info",
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  ...common,
  entryPoints: [path.join(root, "src/main/main.ts")],
  outfile: path.join(dist, "main.cjs"), // .cjs: package.json is type:module
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
});

await build({
  ...common,
  entryPoints: [path.join(root, "src/main/preload.ts")],
  outfile: path.join(dist, "preload.cjs"),
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
});

await build({
  ...common,
  entryPoints: [path.join(root, "src/renderer/index.ts")],
  outfile: path.join(dist, "renderer.js"),
  platform: "browser",
  format: "iife",
  target: "es2022",
});

await cp(path.join(root, "src/renderer/index.html"), path.join(dist, "index.html"));
await cp(
  path.join(root, "src/renderer/styles"),
  path.join(dist, "styles"),
  { recursive: true }
);

console.log("grungus: build complete -> dist/");
