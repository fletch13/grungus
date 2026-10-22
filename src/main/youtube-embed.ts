import type { WebContents } from "electron";
/** Identify the desktop app to YouTube, whose player requires an HTTPS Referer. */
export function youtubeEmbedHeaders(url: string, headers: Record<string, string>): Record<string, string> {
  const target = new URL(url);
  if (target.origin !== "https://www.youtube-nocookie.com" || !/^\/embed\/[A-Za-z0-9_-]{11}$/.test(target.pathname)) return headers;
  const result = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== "referer"));
  return { ...result, Referer: "https://com.fletch13.grungus/" };
}
export function installYoutubeEmbedHeaders(contents: WebContents): void {
  contents.session.webRequest.onBeforeSendHeaders({ urls: ["https://www.youtube-nocookie.com/embed/*"] }, (details, callback) => {
    callback({ requestHeaders: details.webContentsId === contents.id && details.resourceType === "subFrame" ? youtubeEmbedHeaders(details.url, details.requestHeaders) : details.requestHeaders });
  });
}
