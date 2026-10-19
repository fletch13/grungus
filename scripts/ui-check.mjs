import { build } from "esbuild";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import electron from "electron";

const directory = await mkdtemp(path.join(os.tmpdir(), "grungus-ui-"));
try {
  await build({ entryPoints: ["tests/ui-browser.ts"], outfile: path.join(directory, "ui.js"), bundle: true, platform: "browser", format: "iife", target: "es2022" });
  await writeFile(path.join(directory, "index.html"), '<!doctype html><html><head><meta charset="utf-8"><title>Grungus UI tests</title></head><body><script src="ui.js"></script></body></html>');
  await writeFile(path.join(directory, "main.cjs"), `
    const { app, BrowserWindow } = require("electron");
    app.setPath("userData", ${JSON.stringify(path.join(directory, "profile"))});
    const timer = setTimeout(() => { console.error("UI tests timed out"); app.exit(1); }, 30000);
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      try {
        await win.loadFile(${JSON.stringify(path.join(directory, "index.html"))});
        const result = await win.webContents.executeJavaScript("window.uiTestResult");
        if (result.error) throw new Error(result.error);
        console.log(result.message);
        clearTimeout(timer);
        app.exit(0);
      } catch (error) { console.error(error); app.exit(1); }
    });
  `);
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(directory, "main.cjs")], { stdio: "inherit", env: environment });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  process.exitCode = code ?? 1;
} finally { await rm(directory, { recursive: true, force: true }); }
