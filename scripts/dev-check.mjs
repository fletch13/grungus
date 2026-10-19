/** Verify Vite's development server, CSP, and runtime assets with an isolated Electron profile. */
import { createServer } from "vite";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { buildDesktop } from "./build-desktop.mjs";
const profile = await mkdtemp(path.join(os.tmpdir(), "grungus-dev-check-"));
const server = await createServer({ server: { port: 0, strictPort: false } });
try {
  await buildDesktop();
  await server.listen();
  const address = server.httpServer.address();
  const environment = { ...process.env, GRUNGUS_RENDERER_URL: `http://127.0.0.1:${address.port}`, GRUNGUS_SMOKE_PROFILE: profile };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [".", "--smoke"], { stdio: "inherit", env: environment });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  process.exitCode = code ?? 1;
} finally {
  await server.close();
  await rm(profile, { recursive: true, force: true });
}
