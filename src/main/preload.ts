/*
 * Grungus — preload script (TypeScript).
 *
 * Exposes a minimal, explicitly-allowlisted API to the renderer via
 * contextBridge. The renderer has no Node access (sandbox on,
 * contextIsolation on); it talks to this bridge only. The shape mirrors
 * GrungusPlatform in src/renderer/app.ts.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("grungusPlatform", {
  isElectron: true,
  openAuthBrowser: (url: string): Promise<void> => ipcRenderer.invoke("oauth:open-browser", url),
  loadLegacySettings: (): Promise<string | null> => ipcRenderer.invoke("settings:legacy"),
  /** Persist the login session (JSON-serializable). */
  saveSession: (session: unknown): Promise<unknown> =>
    ipcRenderer.invoke("session:save", session),
  /** Load the persisted session, or null when none/failed. */
  loadSession: (): Promise<unknown> => ipcRenderer.invoke("session:load"),
  /** Delete the persisted session. */
  clearSession: (): Promise<unknown> => ipcRenderer.invoke("session:clear"),
  /** E2EE key-value store — olm pickles (OS-keychain-encrypted in main). */
  cryptoGet: (key: string): Promise<string | null> =>
    ipcRenderer.invoke("crypto:get", key),
  cryptoPut: (key: string, value: string): Promise<void> =>
    ipcRenderer.invoke("crypto:put", key, value),
  /** SSO auth window: resolves with the loginToken from the redirect. */
  ssoLogin: (url: string, callbackPrefix: string): Promise<{ loginToken: string | null }> =>
    ipcRenderer.invoke("sso:login", url, callbackPrefix),
  /** System-browser SSO: start the loopback return channel. */
  ssoLoopbackPrepare: (): Promise<{ redirectUrl: string }> =>
    ipcRenderer.invoke("sso:loopback-prepare"),
  /** System-browser SSO: open the URL externally and await the callback. */
  ssoSystemBrowser: (url: string): Promise<{ loginToken: string | null }> =>
    ipcRenderer.invoke("sso:system-browser", url),
  /** Abort a pending system-browser SSO flow. */
  ssoLoopbackAbort: (): Promise<boolean> => ipcRenderer.invoke("sso:loopback-abort"),
});
