/*
 * Grungus — Electron main process.
 *
 * Owns the window lifecycle and the session store. All Matrix networking
 * happens in the renderer against the homeserver directly; the main process
 * only persists the access token, encrypted with safeStorage when the
 * platform keychain is available (plain file fallback, see README security
 * notes).
 */
"use strict";

const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const SMOKE = process.argv.includes("--smoke");
const DEBUG = process.argv.includes("--debug");
const SESSION_FILE = "grungus-session.json";

function sessionPath() {
  return path.join(app.getPath("userData"), SESSION_FILE);
}

/* ---- session persistence (access token stays on the main-process side) ---- */

ipcMain.handle("session:save", (_event, session) => {
  const payload = JSON.stringify(session ?? null);
  let stored;
  if (safeStorage.isEncryptionAvailable()) {
    stored = JSON.stringify({
      v: 2,
      encrypted: true,
      data: safeStorage.encryptString(payload).toString("base64"),
    });
  } else {
    stored = JSON.stringify({ v: 2, encrypted: false, data: payload });
  }
  fs.writeFileSync(sessionPath(), stored, { mode: 0o600 });
  return true;
});

ipcMain.handle("session:load", () => {
  try {
    const raw = fs.readFileSync(sessionPath(), "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.data !== "string") return null;
    const payload = parsed.encrypted
      ? safeStorage.decryptString(Buffer.from(parsed.data, "base64"))
      : parsed.data;
    const session = JSON.parse(payload);
    return session && typeof session === "object" ? session : null;
  } catch {
    return null;
  }
});

ipcMain.handle("session:clear", () => {
  try {
    fs.unlinkSync(sessionPath());
  } catch {
    /* nothing to clear */
  }
  return true;
});

/* ---- window lifecycle ---- */

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    backgroundColor: "#1e1f22",
    title: "Grungus",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  win.once("ready-to-show", () => {
    win.show();
    if (SMOKE) {
      console.log("[grungus] smoke: window ready");
      setTimeout(() => app.exit(0), 500);
    }
  });

  win.webContents.on("did-fail-load", (_e, code, desc) => {
    console.error(`[grungus] load failed: ${code} ${desc}`);
    if (SMOKE) app.exit(1);
  });

  if (DEBUG) win.webContents.openDevTools({ mode: "detach" });

  return win;
}

/* Single-instance lock: re-launching focuses the existing window. */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
