/** Exercise the actual Vite build in a sandboxed Electron renderer. */
import { build, loadConfigFromFile } from "vite";
import { build as bundle } from "esbuild";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import electron from "electron";

const directory = await mkdtemp(path.join(os.tmpdir(), "grungus-ui-"));
try {
  const { config } = await loadConfigFromFile({ command: "build", mode: "test" });
  await build({ ...config, configFile: false, root: process.cwd(), base: "./", build: {
    ...config.build, outDir: directory, emptyOutDir: false,
    rolldownOptions: { input: { tests: path.resolve("tests/ui.html") } },
  } });
  await bundle({ entryPoints: ["src/main/legacy-settings.ts"], outfile: path.join(directory, "legacy.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"] });
  await writeFile(path.join(directory, "legacy.html"), "<!doctype html><title>Legacy settings fixture</title>");
  const screenshots = process.env.GRUNGUS_UI_SCREENSHOTS ? path.resolve(process.env.GRUNGUS_UI_SCREENSHOTS) : null;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  await writeFile(path.join(directory, "main.cjs"), `
    const { app, BrowserWindow, net, protocol } = require("electron");
    const path = require("node:path");
    const { pathToFileURL } = require("node:url");
    const fs = require("node:fs");
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("ozone-platform", "x11");
    app.setPath("userData", ${JSON.stringify(path.join(directory, "profile"))});
    protocol.registerSchemesAsPrivileged([{ scheme: "grungus-test", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
    const timer = setTimeout(() => { console.error("UI tests timed out"); app.exit(1); }, 30000);
    app.whenReady().then(async () => {
      protocol.handle("grungus-test", request => net.fetch(pathToFileURL(path.join(${JSON.stringify(directory)}, new URL(request.url).pathname)).href));
      const win = new BrowserWindow({ width: 1440, height: 960, show: ${Boolean(screenshots)}, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      win.webContents.on("console-message", event => { if (event.level === "error") console.error(event.message); });
      try {
        const legacy = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
        await legacy.loadFile(${JSON.stringify(path.join(directory, "legacy.html"))});
        await legacy.webContents.executeJavaScript("localStorage.setItem('grungus-settings', JSON.stringify({theme:'light',fontScale:1.1}))");
        legacy.destroy();
        const { readLegacySettings } = require(${JSON.stringify(path.join(directory, "legacy.cjs"))});
        const preferences = JSON.parse(await readLegacySettings(${JSON.stringify(path.join(directory, "legacy.html"))}));
        if (preferences.theme !== "light" || preferences.fontScale !== 1.1) throw new Error("Legacy preferences were not recovered");
        await win.loadURL("grungus-test://app/tests/ui.html");
        const result = await win.webContents.executeJavaScript("window.uiTestResult");
        if (result.error) throw new Error(result.error);
        console.log(result.message);
        const screenshotDir = ${JSON.stringify(screenshots)};
        if (screenshotDir) {
          for (const scene of ["workspace", "login", "settings", "light", "mobile", "background", "background-light", "info", "threads", "room-settings", "space-settings"]) {
            win.setSize(scene === "mobile" ? 480 : 1440, scene === "mobile" ? 850 : 960);
            await win.webContents.executeJavaScript("window.showPreview(" + JSON.stringify(scene) + ")");
            await new Promise(resolve => setTimeout(resolve, 150));
            fs.writeFileSync(path.join(screenshotDir, scene + ".png"), (await win.webContents.capturePage()).toPNG());
          }
        }
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
