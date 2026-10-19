/** KLIPY requests go directly from the renderer; no Matrix credentials are sent. */
export interface KlipyGif { id: string; title: string; preview: string; url: string; }
export interface KlipyPage { gifs: KlipyGif[]; nextPage: number | null; }
const LIMIT = 24;
export function klipyMediaUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      /^static[12]?\.klipy\.com$/.test(url.hostname) ? value : null;
  } catch { return null; }
}
export async function searchKlipy(key: string, query: string, page = 1, signal?: AbortSignal): Promise<KlipyPage> {
  if (!key.trim()) throw new Error("Add your KLIPY API key in Settings → Preferences first.");
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("Invalid GIF page.");
  const url = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(key.trim())}/gifs/${query.trim() ? "search" : "trending"}`);
  url.search = new URLSearchParams({ per_page: String(LIMIT), page: String(page), content_filter: "high", format_filter: "gif", ...(query.trim() ? { q: query } : {}) }).toString();
  const response = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  if (!response.ok) throw new Error(response.status === 429 ? "KLIPY rate limit reached. Try again later." : response.status === 401 || response.status === 403 ? "KLIPY rejected the API key. Check Settings → Preferences." : "KLIPY is unavailable. Try again.");
  const body = await response.json() as {
    result?: boolean;
    data?: { data?: Array<{ id?: string | number; slug?: string; title?: string; file?: Record<string, { gif?: { url?: string } }> }>; has_next?: boolean };
  };
  if (body.result !== true || !Array.isArray(body.data?.data)) throw new Error("KLIPY returned an invalid response.");
  const gifs: KlipyGif[] = [];
  for (const entry of body.data.data) {
    const preview = klipyMediaUrl(entry.file?.sm?.gif?.url ?? entry.file?.xs?.gif?.url ?? entry.file?.hd?.gif?.url);
    const url = klipyMediaUrl(entry.file?.hd?.gif?.url ?? entry.file?.md?.gif?.url ?? entry.file?.sm?.gif?.url);
    if (entry.id !== undefined && preview && url) gifs.push({ id: String(entry.id), title: entry.title || "GIF", preview, url });
  }
  return { gifs, nextPage: body.data.has_next === true && body.data.data.length ? page + 1 : null };
}

/** Only explicit /gif messages embed third-party media. Ordinary links stay text. */
export function gifMessageUrl(body: string): string | null {
  const match = /^\/gif[ \t]+(\S+)$/.exec(body.trim());
  return match ? klipyMediaUrl(match[1]) : null;
}

export function formatGifMessage(url: string): string {
  if (!klipyMediaUrl(url)) throw new Error("Invalid KLIPY GIF URL.");
  return `/gif ${url}`;
}
