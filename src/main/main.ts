import { installYoutubeEmbedHeaders } from "./youtube-embed.ts";
/*
 * Grungus — Electron main process (TypeScript).
 *
 * Owns the window lifecycle and the session store. All Matrix networking
 * happens in the renderer against the homeserver directly; the main process
 * only persists the access token, encrypted with safeStorage when the
 * platform keychain is available (plain file fallback, see README security
 * notes).
 *
 * esbuild bundles this to dist/main.cjs. Vite emits index.html and hashed
 * renderer assets, served over the secure grungus://app origin.
 */
import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import { readLegacySettings } from "./legacy-settings.ts";
import { registerAppAssets, rendererUrl } from "./app-assets.ts";
import { chooseCaptureSource } from "./capture-picker.ts";
import { CryptoVault } from "./crypto-vault.ts";
import { startSsoLoopback, type SsoLoopback } from "./sso-loopback.ts";

const SMOKE = process.argv.includes("--smoke");
if (SMOKE && process.env.GRUNGUS_SMOKE_PROFILE) app.setPath("userData", process.env.GRUNGUS_SMOKE_PROFILE);
const DEBUG = process.argv.includes("--debug");
const SESSION_FILE = "grungus-session.json";

ipcMain.handle("oauth:open-browser", async (_event, value: string): Promise<void> => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid sign-in URL");
  await shell.openExternal(url.href);
});

function sessionPath(): string {
  return path.join(app.getPath("userData"), SESSION_FILE);
}

/* ---- session persistence (access token encrypted at rest when available) ---- */

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

function cryptoVault(): CryptoVault {
  return new CryptoVault(cryptoVaultPath(), safeStorage);
}

ipcMain.handle("crypto:get", (_event, key: string): string | null => {
  const map = cryptoVault().read();
  return Object.prototype.hasOwnProperty.call(map, String(key)) ? map[String(key)]! : null;
});

ipcMain.handle("crypto:put", (_event, key: string, value: string): boolean => {
  cryptoVault().put(String(key), String(value));
  return true;
});

/* Read legacy local preferences once; sessions and crypto remain in their native vaults. */
let legacySettings: Promise<string | null> | undefined;
ipcMain.handle("settings:legacy", () => legacySettings ??= readLegacySettings());

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

  let pickingCapture = false;
  win.webContents.session.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (pickingCapture || request.frame !== win.webContents.mainFrame) { callback({}); return; }
      pickingCapture = true;
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } });
        const choice = await chooseCaptureSource(win, sources, request.audioRequested && process.platform === "win32");
        callback(choice ? { video: choice.source, ...(choice.audio ? { audio: "loopback" as const } : {}) } : {});
      } catch {
        callback({});
      } finally { pickingCapture = false; }
    }
  );

  installYoutubeEmbedHeaders(win.webContents);

  /* Production assets use a secure standard scheme; development uses local Vite. */
  void win.loadURL(rendererUrl());

  win.once("ready-to-show", () => {
    /* open using the full screen — a 1280x800 window on a desktop
       display looks like the app ignores the monitor */
    win.maximize();
    win.show();
    if (SMOKE) {
      void (async () => {
        await win.webContents.executeJavaScript(`new Promise((resolve, reject) => {
          const deadline = Date.now() + 8000;
          const check = () => {
            const login = document.querySelector('login-view .login-card');
            if (login && getComputedStyle(document.querySelector('login-view')).display === 'grid' && document.querySelector('#startup-screen')?.hidden && !document.querySelector('#root')?.inert) return resolve(true);
            if (Date.now() > deadline) return reject(new Error('Vite renderer did not initialize'));
            setTimeout(check, 50);
          };
          check();
        })`);
        await win.webContents.executeJavaScript(`Promise.all(['olm.wasm', 'livekit-client.e2ee.worker.js'].map(async file => {
          const response = await fetch(new URL(file, document.baseURI));
          if (!response.ok) throw new Error('Missing runtime asset: ' + file);
          if (file.endsWith('.wasm')) await WebAssembly.compile(await response.arrayBuffer());
        }))`);
        console.log("[grungus] smoke: Vite renderer, Tailwind styles, and crypto assets ready");
        app.exit(0);
      })().catch(error => { console.error("[grungus] smoke:", error); app.exit(1); });
    }
  });

  /* F11 toggles true fullscreen (the OS/windowing default is a resized
     window, not fullscreen) */
  win.webContents.on("before-input-event", (_e, input) => {
    if (input.type === "keyDown" && input.key === "F11") {
      win.setFullScreen(!win.isFullScreen());
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
    registerAppAssets();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
