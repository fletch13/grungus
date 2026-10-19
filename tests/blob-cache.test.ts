import test from "node:test";
import assert from "node:assert/strict";
import { BlobCache } from "../src/renderer/services/blob-cache.ts";

test("blob cache deduplicates, retries failures, and revokes LRU entries", async () => {
  const cache = new BlobCache(2, 10);
  let loads = 0;
  const load = async () => { loads++; return new Blob(["1234"]); };
  const first = await cache.get("first", load);
  assert.ok(first);
  assert.equal(await cache.get("first", load), first);
  assert.equal(loads, 1);
  await cache.get("second", load);
  await cache.get("first", load); // first is now the most recently used entry
  const second = await cache.get("second", load);
  await cache.get("first", load);
  await cache.get("third", load);
  assert.equal(cache.size, 2);
  assert.equal(cache.byteLength, 8);
  await assert.rejects(() => fetch(second!));
  assert.equal((await fetch(first)).status, 200);
  assert.equal(await cache.get("retry", async () => null), null);
  assert.ok(await cache.get("retry", load));
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(cache.byteLength, 0);
  await assert.rejects(() => fetch(first));
});

test("cache clear aborts pending downloads and prevents late URL creation", async () => {
  const cache = new BlobCache(2, 4);
  let resolve!: (blob: Blob) => void;
  let signal!: AbortSignal;
  const pending = cache.get("pending", async s => { signal = s; return new Promise<Blob>(r => { resolve = r; }); });
  await Promise.resolve();
  cache.clear();
  assert.equal(signal.aborted, true);
  resolve(new Blob(["late"]));
  assert.equal(await pending, null);
  assert.equal(cache.size, 0);
  assert.equal(await cache.get("oversized", async () => new Blob(["12345"])), null);
  assert.equal(cache.byteLength, 0);
});
