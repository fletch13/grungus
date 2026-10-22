/** Authenticated media transport and bounded blob caches. */
import { BlobCache } from "./blob-cache.ts";
import { decryptAttachment, type EncryptedFile } from "./attachments.ts";
import { HttpError } from "./matrix-types.ts";
interface MediaHost { readonly baseUrl: string; readonly accessToken: string | null; }
export class MatrixMedia {
  private host: MediaHost;
  private _avatarCache = new BlobCache(128, 8 * 1024 * 1024);
  private _mediaCache = new BlobCache();
  constructor(host: MediaHost) { this.host = host; }
  async uploadMedia(
    filename: string,
    mimeType: string,
    bytes: Uint8Array
  ): Promise<string> {
    const url = new URL(
      `${this.host.baseUrl}/_matrix/media/v3/upload`
    );
    url.searchParams.set("filename", filename);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": mimeType,
        ...(this.host.accessToken ? { Authorization: `Bearer ${this.host.accessToken}` } : {}),
      },
      body: bytes as unknown as BodyInit,
    });
    const data = (await res.json().catch(() => ({}))) as {
      content_uri?: string;
      errcode?: string;
      error?: string;
    };
    if (!res.ok || !data.content_uri) {
      throw new HttpError(res.status, data as never);
    }
    return data.content_uri;
  }

  private async _downloadMedia(path: string, signal: AbortSignal): Promise<Response> {
    const options: RequestInit = {
      signal,
      headers: this.host.accessToken ? { Authorization: `Bearer ${this.host.accessToken}` } : {},
    };
    const modern = await fetch(`${this.host.baseUrl}/_matrix/client/v1/media/${path}`, options);
    // Old homeservers may not implement authenticated media yet.
    if (modern.status !== 404) return modern;
    await modern.body?.cancel();
    return fetch(`${this.host.baseUrl}/_matrix/media/v3/${path}`, options);
  }

  clearMediaCache(): void {
    this._avatarCache.clear();
    this._mediaCache.clear();
  }

  private _parseMxc(mxc: string): { server: string; mediaId: string } | null {
    if (typeof mxc !== "string" || !mxc.startsWith("mxc://")) return null;
    const rest = mxc.slice("mxc://".length).split("/");
    const server = rest.shift();
    const mediaId = rest.join("/");
    if (!server || !mediaId) return null;
    return { server, mediaId };
  }

  async avatarSrc(mxc: string | null | undefined, size = 64): Promise<string | null> {
    if (typeof URL.createObjectURL !== "function") return null;
    const parsed = mxc ? this._parseMxc(mxc) : null;
    if (!parsed) return null;

    const key = `${mxc}@${size}`;
    const parameters = new URLSearchParams({ width: String(size), height: String(size), method: "scale" });
    const path = `thumbnail/${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}?${parameters}`;
    return this._avatarCache.get(key, async signal => {
      const res = await this._downloadMedia(path, signal);
      return res.ok ? res.blob() : null;
    });
  }

  async mediaSrc(mxc: string | null | undefined, file?: EncryptedFile, mimeType = "application/octet-stream"): Promise<string | null> {
    if (typeof URL.createObjectURL !== "function") return null;
    const parsed = mxc ? this._parseMxc(mxc) : null;
    if (!parsed) return null;

    const cacheKey = JSON.stringify([mxc, file, mimeType]);
    const path = `download/${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`;
    return this._mediaCache.get(cacheKey, async signal => {
      const res = await this._downloadMedia(path, signal);
      if (!res.ok) return null;
      if (!file) {
        const blob = await res.blob();
        return mimeType !== "application/octet-stream" ? new Blob([blob], { type: mimeType }) : blob;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      return new Blob([await decryptAttachment(bytes, file)], { type: mimeType });
    });
  }
}
