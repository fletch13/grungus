import { app, net, protocol } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const APP_ORIGIN = "grungus://app";
protocol.registerSchemesAsPrivileged([{
  scheme: "grungus", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

export function rendererUrl(page = "index.html"): string {
  const development = process.env.GRUNGUS_RENDERER_URL;
  if (!app.isPackaged && development) {
    const url = new URL(development);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("Renderer development server must use loopback HTTP");
    return new URL(page, `${url.origin}/`).href;
  }
  return `${APP_ORIGIN}/${page}`;
}

/** Serve only bundled renderer assets, including hashed modules, WASM, and workers. */
export function registerAppAssets(): void {
  protocol.handle("grungus", request => {
    const url = new URL(request.url);
    if (url.host !== "app" || request.method !== "GET") return new Response(null, { status: 404 });
    let name: string;
    try { name = decodeURIComponent(url.pathname); } catch { return new Response(null, { status: 400 }); }
    const base = path.resolve(__dirname);
    const file = path.resolve(base, `.${name === "/" ? "/index.html" : name}`);
    const relative = path.relative(base, file);
    const allowed = /\.(?:html|js|css|wasm|png|svg|ico|woff2?)$/.test(file);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !allowed) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(file).href).catch(() => new Response(null, { status: 404 }));
  });
}
