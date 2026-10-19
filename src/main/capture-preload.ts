import { contextBridge, ipcRenderer } from "electron";
contextBridge.exposeInMainWorld("capturePicker", {
  sources: () => ipcRenderer.invoke("capture:sources"),
  choose: (id: string | null, audio: boolean) => ipcRenderer.invoke("capture:choose", id, audio),
});
