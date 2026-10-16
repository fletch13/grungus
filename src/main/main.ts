/*
 * Grungus — Electron main process (TypeScript).
 *
 * Owns the window lifecycle and the session store. All Matrix networking
 * happens in the renderer against the homeserver directly; the main process
 * only persists the access token, encrypted with safeStorage when the
 * platform keychain is available (plain file fallback, see README security
 * notes).
 *
 * esbuild bundles this to dist/main.js (CJS); "main" in package.json
 * points there. dist/ also holds preload.js, index.html, renderer.js.
 */
import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { startSsoLoopback, type SsoLoopback } from "./sso-loopback.ts";

const SMOKE = process.argv.includes("--smoke");
const DEBUG = process.argv.includes("--debug");
const SESSION_FILE = "grungus-session.json";

function sessionPath(): string {
  return path.join(app.getPath("userData"), SESSION_FILE);
}

/* ---- session persistence (access token stays on the main-process side) ---- */

ipcMain.handle("session:save", (_event, session: unknown): boolean => {
  const payload = JSON.stringify(session ?? null);
  let stored: string;
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

ipcMain.handle("session:load", (): unknown => {
  try {
    const raw = fs.readFileSync(sessionPath(), "utf8");
    const parsed = JSON.parse(raw) as {
      v?: number;
      encrypted?: boolean;
      data?: string;
    };
    if (!parsed || typeof parsed.data !== "string") return null;
    const payload = parsed.encrypted
      ? safeStorage.decryptString(Buffer.from(parsed.data, "base64"))
      : parsed.data;
    const session: unknown = JSON.parse(payload);
    return session && typeof session === "object" ? session : null;
  } catch {
    return null;
  }
});

ipcMain.handle("session:clear", (): boolean => {
  try {
    fs.unlinkSync(sessionPath());
  } catch {
    /* nothing to clear */
  }
  return true;
});

/* ---- E2EE crypto vault (olm pickles — sensitive, keychain-encrypted) ---- */

const CRYPTO_VAULT_FILE = "grungus-crypto-vault.json";

function cryptoVaultPath(): string {
  return path.join(app.getPath("userData"), CRYPTO_VAULT_FILE);
}

function readCryptoVault(): Record<string, string> {
  try {
    const raw = fs.readFileSync(cryptoVaultPath(), "utf8");
    const parsed = JSON.parse(raw) as {
      v?: number;
      encrypted?: boolean;
      data?: string;
    };
    if (!parsed || typeof parsed.data !== "string") return {};
    const payload = parsed.encrypted
      ? safeStorage.decryptString(Buffer.from(parsed.data, "base64"))
      : parsed.data;
    const map = JSON.parse(payload) as Record<string, string>;
    return map && typeof map === "object" ? map : {};
  } catch {
    return {};
  }
}

function writeCryptoVault(map: Record<string, string>): void {
  const payload = JSON.stringify(map);
  const stored = safeStorage.isEncryptionAvailable()
    ? JSON.stringify({
        v: 1,
        encrypted: true,
        data: safeStorage.encryptString(payload).toString("base64"),
      })
    : JSON.stringify({ v: 1, encrypted: false, data: payload });
  fs.writeFileSync(cryptoVaultPath(), stored, { mode: 0o600 });
}

ipcMain.handle("crypto:get", (_event, key: string): string | null => {
  const map = readCryptoVault();
  const k = String(key);
  return Object.prototype.hasOwnProperty.call(map, k) ? map[k]! : null;
});

ipcMain.handle("crypto:put", (_event, key: string, value: string): boolean => {
  const map = readCryptoVault();
  map[String(key)] = String(value);
  writeCryptoVault(map);
  return true;
});

/* ---- SSO (Electron): system browser with a loopback capture ---- */

let activeSsoLoopback: SsoLoopback | null = null;

function abortSsoLoopback(): void {
  activeSsoLoopback?.close();
  activeSsoLoopback = null;
}

/** Start the loopback listener; the renderer embeds its URL as redirectUrl. */
ipcMain.handle("sso:loopback-prepare", async (): Promise<{ redirectUrl: string }> => {
  abortSsoLoopback();
  const loopback = await startSsoLoopback();
  activeSsoLoopback = loopback;
  return { redirectUrl: loopback.redirectUrl };
});

/** Open the SSO URL in the HOST SYSTEM BROWSER (passkeys/WebAuthn are
 *  OS-native there) and wait for the loopback callback. */
ipcMain.handle(
  "sso:system-browser",
  async (_event, url: string): Promise<{ loginToken: string | null }> => {
    const loopback = activeSsoLoopback;
    if (!loopback) return { loginToken: null };
    await shell.openExternal(url);
    const loginToken = await loopback.waitForToken(300_000);
    activeSsoLoopback = null;
    return { loginToken };
  }
);

ipcMain.handle("sso:loopback-abort", (): boolean => {
  abortSsoLoopback();
  return true;
});

/* ---- SSO (Electron): embedded auth window fallback ---- */

ipcMain.handle(
  "sso:login",
  (
    _event,
    url: string,
    callbackPrefix: string
  ): Promise<{ loginToken: string | null }> => {
    return new Promise((resolve) => {
      const authWin = new BrowserWindow({
        width: 640,
        height: 760,
        show: true,
        title: "Sign in",
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      let settled = false;
      const finish = (result: { loginToken: string | null }): void => {
        if (settled) return;
        settled = true;
        try {
          authWin.destroy();
        } catch {
          /* already gone */
        }
        resolve(result);
      };
      const intercept = (targetUrl: string): boolean => {
        if (targetUrl.startsWith(callbackPrefix)) {
          const token = new URL(targetUrl).searchParams.get("loginToken");
          finish({ loginToken: token });
          return true;
        }
        return false;
      };
      /* the callback redirect is intercepted BEFORE any connection is
         attempted — the callback host never needs to exist */
      authWin.webContents.on("will-redirect", (event, targetUrl) => {
        if (intercept(targetUrl)) event.preventDefault();
      });
      authWin.webContents.on("will-navigate", (event, targetUrl) => {
        if (intercept(targetUrl)) event.preventDefault();
      });
      authWin.on("closed", () => finish({ loginToken: null }));
      void authWin.loadURL(url);
    });
  }
);

/* ---- window lifecycle ---- */

function createWindow(): BrowserWindow {
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
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });

  /* screenshare: getDisplayMedia from the renderer — pick the primary
     screen automatically (a source-picker UI can come later) */
  win.webContents.session.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"] });
        const primary = sources[0];
        callback(primary ? { video: primary, audio: "loopback" } : {});
      } catch {
        callback({});
      }
    }
  );

  /* dist/ holds main.js, preload.js, index.html, renderer.js, styles/ */
  void win.loadFile(path.join(__dirname, "index.html"));

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
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  void app.whenReady().then(() => {
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
