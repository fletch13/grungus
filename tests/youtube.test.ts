import test from "node:test";
import assert from "node:assert/strict";
import { youtubeVideos } from "../src/renderer/services/youtube.ts";
import { youtubeEmbedHeaders, installYoutubeEmbedHeaders } from "../src/main/youtube-embed.ts";

test("YouTube videos recognize watch, short, shorts, live and embed links with timestamps", () => {
  for (const link of ["https://www.youtube.com/watch?v=M7lc1UVf-VE", "https://youtu.be/M7lc1UVf-VE", "https://m.youtube.com/shorts/M7lc1UVf-VE", "https://youtube.com/live/M7lc1UVf-VE", "https://www.youtube-nocookie.com/embed/M7lc1UVf-VE"]) {
    assert.equal(youtubeVideos(link)[0]?.id, "M7lc1UVf-VE");
  }
  assert.equal(new URL(youtubeVideos("https://www.youtube.com/watch?v=ih2xubMaZWI")[0]!.embedUrl).searchParams.get("autoplay"), "0");
  assert.match(youtubeVideos("[video](https://youtu.be/M7lc1UVf-VE?t=1m30s)")[0]!.embedUrl, /start=90/);
  assert.match(youtubeVideos("https://youtube.com/watch?v=M7lc1UVf-VE#t=2m")[0]!.embedUrl, /start=120/);
  assert.equal(youtubeVideos("https://youtu.be/M7lc1UVf-VE https://youtube.com/watch?v=M7lc1UVf-VE").length, 1);
  for (const link of ["https://youtube.com.evil.test/watch?v=M7lc1UVf-VE", "https://evil.test/youtu.be/M7lc1UVf-VE", "https://youtube.com@evil.test/watch?v=M7lc1UVf-VE", "https://youtube.com/watch?v=bad", "javascript:alert(1)"]) assert.equal(youtubeVideos(link).length, 0);
});

test("YouTube identification changes only embedded-player requests from the app window", () => {
  const url = "https://www.youtube-nocookie.com/embed/M7lc1UVf-VE";
  assert.equal(youtubeEmbedHeaders(url, { referer: "grungus://app", Other: "preserved" }).Referer, "https://com.fletch13.grungus/");
  assert.deepEqual(youtubeEmbedHeaders("https://homeserver.test/media", { Referer: "original" }), { Referer: "original" });
  let handler: any;
  installYoutubeEmbedHeaders({ id: 7, session: { webRequest: { onBeforeSendHeaders: (_filter: unknown, callback: unknown) => { handler = callback; } } } } as any);
  for (const [id, resourceType, expected] of [[7, "subFrame", "https://com.fletch13.grungus/"], [8, "subFrame", "original"], [7, "xmlHttpRequest", "original"]]) {
    handler({ webContentsId: id, resourceType, url, requestHeaders: { Referer: "original" } }, (result: any) => assert.equal(result.requestHeaders.Referer, expected));
  }
});
