import { build } from "esbuild";
import path from "node:path";

export async function buildDesktop() {
  const root = path.resolve(import.meta.dirname, "..");
  await build({
    entryPoints: {
      main: path.join(root, "src/main/main.ts"),
      preload: path.join(root, "src/main/preload.ts"),
      "capture-preload": path.join(root, "src/main/capture-preload.ts"),
    },
    outdir: path.join(root, "dist"), outExtension: { ".js": ".cjs" },
    bundle: true, platform: "node", format: "cjs", target: "node24",
    external: ["electron"], sourcemap: "external", logLevel: "info",
  });
}
