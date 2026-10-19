/** Build Electron with esbuild and the renderer with Vite + Tailwind. */
import { build } from "vite";
import { rm } from "node:fs/promises";
import path from "node:path";
import { buildDesktop } from "./build-desktop.mjs";

await rm(path.resolve(import.meta.dirname, "../dist"), { recursive: true, force: true });
await buildDesktop();
await build();
