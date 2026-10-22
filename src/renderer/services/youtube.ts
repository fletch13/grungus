export interface YouTubeVideo { id: string; embedUrl: string; watchUrl: string; }
const hosts = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
function startSeconds(value: string | null): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Math.min(Number(value), 86400);
  const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  return match ? Math.min(Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0), 86400) : 0;
}
/** Only known YouTube hosts and exact video IDs can become embedded frames. */
export function youtubeVideos(text: string): YouTubeVideo[] {
  const videos = new Map<string, YouTubeVideo>();
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'()[\]]+/gi)) {
    let url: URL; try { url = new URL(match[0].replace(/[.,!?;]+$/, "")); } catch { continue; }
    if (url.username || url.password || url.port) continue;
    const host = url.hostname.toLowerCase();
    let id: string | undefined;
    if (host === "youtu.be" || host === "www.youtu.be") id = url.pathname.split("/")[1];
    else if (hosts.has(host)) {
      if (url.pathname === "/watch") id = url.searchParams.get("v") ?? undefined;
      else id = /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1];
    }
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id) || videos.has(id)) continue;
    const embed = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
    embed.searchParams.set("playsinline", "1");
    embed.searchParams.set("autoplay", "0");
    const start = startSeconds(url.searchParams.get("t") ?? url.searchParams.get("start") ?? new URLSearchParams(url.hash.slice(1)).get("t"));
    if (start) embed.searchParams.set("start", String(start));
    videos.set(id, { id, embedUrl: embed.href, watchUrl: `https://www.youtube.com/watch?v=${id}` });
    if (videos.size === 3) break;
  }
  return [...videos.values()];
}
