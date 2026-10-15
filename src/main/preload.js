/*
 * Grungus — preload script.
 *
 * Exposes a minimal, explicitly-allowlisted API to the renderer via
 * contextBridge. The renderer has no Node access (sandbox on,
 * contextIsolation on); it talks to this bridge only.
 */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("grungusPlatform", {
  isElectron: true,
  /** Persist the login session (JSON-serializable). Resolves true. */
  saveSession: (session) => ipcRenderer.invoke("session:save", session),
  /** Load the persisted session, or null when none/failed. */
  loadSession: () => ipcRenderer.invoke("session:load"),
  /** Delete the persisted session. Resolves true. */
  clearSession: () => ipcRenderer.invoke("session:clear"),
});
