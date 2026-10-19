/** Smoke-test the production renderer with an isolated profile. */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electron from "electron";
const profile = await mkdtemp(path.join(os.tmpdir(), "grungus-smoke-"));
const environment = { ...process.env, GRUNGUS_SMOKE_PROFILE: profile };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.GRUNGUS_RENDERER_URL;
try {
  const child = spawn(process.argv[2] ?? electron, process.argv[2] ? ["--smoke"] : [".", "--smoke"], { stdio: "inherit", env: environment });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  process.exitCode = code ?? 1;
} finally { await rm(profile, { recursive: true, force: true }); }
