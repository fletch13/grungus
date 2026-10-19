import { createServer } from "vite";
import { spawn } from "node:child_process";
import electron from "electron";
import { buildDesktop } from "./build-desktop.mjs";

await buildDesktop();
const server = await createServer();
await server.listen();
server.printUrls();
const environment = { ...process.env, GRUNGUS_RENDERER_URL: "http://127.0.0.1:5173" };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], { stdio: "inherit", env: environment });
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  child.kill();
  await server.close();
  process.exitCode = code;
}
child.once("error", error => { console.error(error); void close(1); });
child.once("exit", code => { void close(code ?? 0); });
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
