import { BrowserWindow } from "electron";
import path from "node:path";

/** Read only appearance/device preferences from the previous file:// origin. */
export async function readLegacySettings(file = path.join(__dirname, "index.html")): Promise<string | null> {
  const legacy = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  // The current built HTML contains only external module scripts. Block those
  // for this window so reading the old origin cannot boot a second app instance.
  const requests = legacy.webContents.session.webRequest;
  requests.onBeforeRequest((details, callback) => callback({ cancel: details.webContentsId === legacy.webContents.id && details.resourceType === "script" }));
  legacy.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  try {
    await legacy.loadFile(file);
    const raw: unknown = await legacy.webContents.executeJavaScript("localStorage.getItem('grungus-settings')");
    if (typeof raw !== "string" || raw.length > 16_384) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? raw : null;
  } finally { requests.onBeforeRequest(null); legacy.destroy(); }
}
