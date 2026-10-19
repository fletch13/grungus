import { BrowserWindow, type DesktopCapturerSource } from "electron";
import path from "node:path";
import { rendererUrl } from "./app-assets.ts";

/** A separate sandboxed window with a bridge limited to this one capture request. */
export function chooseCaptureSource(
  parent: BrowserWindow, sources: DesktopCapturerSource[], audioAvailable: boolean
): Promise<{ source: DesktopCapturerSource; audio: boolean } | null> {
  return new Promise(resolve => {
    const picker = new BrowserWindow({
      parent, modal: true, width: 760, height: 600, show: false,
      title: "Choose what to share", autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "capture-preload.cjs"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    let settled = false;
    const finish = (choice: { source: DesktopCapturerSource; audio: boolean } | null): void => {
      if (settled) return;
      settled = true;
      resolve(choice);
      if (!picker.isDestroyed()) picker.destroy();
    };
    picker.webContents.ipc.handle("capture:sources", event => {
      if (event.senderFrame !== picker.webContents.mainFrame) throw new Error("Invalid picker frame");
      return {
        audioAvailable,
        sources: sources.map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() })),
      };
    });
    picker.webContents.ipc.handle("capture:choose", (event, id: unknown, audio: unknown) => {
      if (event.senderFrame !== picker.webContents.mainFrame) throw new Error("Invalid picker frame");
      const source = sources.find(candidate => candidate.id === id);
      finish(source ? { source, audio: audioAvailable && audio === true } : null);
    });
    picker.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    picker.webContents.on("will-navigate", event => event.preventDefault());
    picker.on("closed", () => finish(null));
    picker.once("ready-to-show", () => picker.show());
    void picker.loadURL(rendererUrl("capture-picker.html")).catch(() => finish(null));
  });
}
