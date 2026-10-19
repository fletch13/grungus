import test from "node:test";
import assert from "node:assert/strict";
import { searchKlipy, klipyMediaUrl, formatGifMessage, gifMessageUrl } from "../src/renderer/services/klipy.ts";

test("KLIPY search uses native API pages, preserves URLs, and omits Matrix credentials", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const requests: URL[] = [];
  globalThis.fetch = async (input, options) => {
    requests.push(new URL(String(input)));
    assert.equal(options?.credentials, "omit"); assert.equal(options?.cache, "no-store"); assert.equal(options?.headers, undefined);
    return Response.json({ result: true, data: { data: [{ id: 123, title: "A & B", file: {
      sm: { gif: { url: "https://static1.klipy.com/media/preview.gif?tracking=original" } },
      hd: { gif: { url: "https://static2.klipy.com/media/full.gif?tracking=original" } },
    } }], current_page: 2, has_next: true } });
  };
  const page = await searchKlipy("test-key", "cats & dogs 🐶", 2);
  assert.equal(requests[0]!.pathname, "/api/v1/test-key/gifs/search");
  assert.equal(requests[0]!.searchParams.get("q"), "cats & dogs 🐶");
  assert.equal(requests[0]!.searchParams.get("content_filter"), "high");
  assert.equal(requests[0]!.searchParams.get("page"), "2");
  assert.equal(page.nextPage, 3);
  assert.equal(page.gifs[0]!.url, "https://static2.klipy.com/media/full.gif?tracking=original");
  await searchKlipy("test-key", "");
  assert.equal(requests[1]!.pathname, "/api/v1/test-key/gifs/trending");
  assert.equal(requests[1]!.searchParams.get("page"), "1");
  await assert.rejects(searchKlipy("", "cats"), /API key/);
  globalThis.fetch = async () => new Response(null, { status: 429 });
  await assert.rejects(searchKlipy("test-key", "cats"), /rate limit/);
  globalThis.fetch = async () => new Response(null, { status: 403 });
  await assert.rejects(searchKlipy("test-key", "cats"), /API key/);
});

test("KLIPY rejects untrusted URLs and malformed responses; empty results stop pagination", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  for (const url of ["http://static.klipy.com/a", "https://static.klipy.com.evil.test/a", "https://evil.test/a", "https://user:pass@static.klipy.com/a", "https://api.klipy.com/a"]) assert.equal(klipyMediaUrl(url), null);
  for (const host of ["static.klipy.com", "static1.klipy.com", "static2.klipy.com"]) assert.ok(klipyMediaUrl(`https://${host}/a.gif`));
  globalThis.fetch = async () => Response.json({ result: false });
  await assert.rejects(searchKlipy("test", "cats"), /invalid response/);
  globalThis.fetch = async () => Response.json({ result: true, data: { data: [], has_next: true } });
  assert.equal((await searchKlipy("test", "cats")).nextPage, null);
});

test("/gif messages preserve provider URLs and only embed explicit supported commands", () => {
  const url = "https://static.klipy.com/ii/example/image.gif?original=1&token=a%2Fb";
  assert.equal(formatGifMessage(url), `/gif ${url}`);
  assert.equal(gifMessageUrl(formatGifMessage(url)), url);
  assert.equal(gifMessageUrl(`/gif\t${url}`), url);
  for (const body of [url, `/gift ${url}`, `/gif ${url} extra`, "/gif", "/gif javascript:alert(1)", "/gif https://evil.test/x.gif"]) assert.equal(gifMessageUrl(body), null);
  assert.throws(() => formatGifMessage("https://evil.test/x.gif"), /Invalid/);
});
