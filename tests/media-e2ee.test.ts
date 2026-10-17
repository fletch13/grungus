/*
 * Grungus — E2EE media (insertable streams) frame-crypto tests:
 * encrypt/decrypt round-trips, ciphertext-is-not-plaintext, tamper
 * rejection, unknown-key fail-closed drops, nonce uniqueness across
 * frames and transforms, and rotation semantics (a stale key decrypts
 * nothing after the key id advances).
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  b64ToBytes,
  bytesToB64,
  CLEAR_PREFIX_BYTES,
  FRAME_HEADER_BYTES,
  importAesGcm,
  makeDecryptTransform,
  makeEncryptTransform,
  MEDIA_KEY_BYTES,
  randomBytes,
} from "../src/renderer/services/media-e2ee.ts";

interface EncodedFrame {
  data: ArrayBuffer;
  timestamp: number;
  type?: string;
  [extra: string]: unknown;
}

async function makeKey(usages: KeyUsage[]): Promise<{ raw: Uint8Array; key: CryptoKey }> {
  const raw = randomBytes(MEDIA_KEY_BYTES);
  return { raw, key: await importAesGcm(raw, usages) };
}

/** Push frames through a TransformStream and collect the outputs. */
async function runThrough(
  stream: TransformStream<EncodedFrame, EncodedFrame>,
  frames: EncodedFrame[]
): Promise<EncodedFrame[]> {
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const outputs: EncodedFrame[] = [];
  /* interleave writes and reads (the transform is async) */
  const writeAll = (async () => {
    for (const frame of frames) {
      await writer.write(frame);
    }
    await writer.close();
  })();
  for (;;) {
    const read = await reader.read();
    if (read.done) break;
    outputs.push(read.value);
  }
  await writeAll;
  return outputs;
}

function fakeFrame(size: number, timestamp: number): EncodedFrame {
  const data = new Uint8Array(size);
  crypto.getRandomValues(data);
  return { data: data.buffer, timestamp, type: "delta" };
}

test("E2EE media: encrypt→decrypt round-trip is byte-identical, ciphertext is not plaintext", async () => {
  const { key } = await makeKey(["encrypt"]);
  const { key: decryptKey } = await makeKey(["decrypt"]);
  /* same raw key for both sides (transport is elsewhere) */
  const raw = randomBytes(MEDIA_KEY_BYTES);
  const encKey = await importAesGcm(raw, ["encrypt"]);
  const decKey = await importAesGcm(raw, ["decrypt"]);

  const frames = [fakeFrame(1200, 1), fakeFrame(800, 2), fakeFrame(40, 3)];
  const encrypted = await runThrough(
    makeEncryptTransform(() => ({ keyId: 7, key: encKey })),
    frames
  );

  assert.equal(encrypted.length, 3, "all frames come out");
  for (let i = 0; i < frames.length; i++) {
    const original = new Uint8Array(frames[i]!.data);
    const cipher = new Uint8Array(encrypted[i]!.data);
    assert.equal(cipher[0], 7, "keyId rides in the header");
    assert.ok(cipher.length > original.length, "header + GCM tag added");
    /* the ciphertext region must not contain the plaintext tail */
    const plainTail = original.subarray(CLEAR_PREFIX_BYTES, CLEAR_PREFIX_BYTES + 8);
    const cipherBody = cipher.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + 16);
    assert.notDeepEqual([...cipherBody], [...plainTail], "not plaintext");
    assert.equal(encrypted[i]!.timestamp, frames[i]!.timestamp, "metadata preserved");
    assert.equal(encrypted[i]!.type, frames[i]!.type, "frame type preserved");
  }

  /* decrypt back */
  const keys = new Map<number, CryptoKey>([[7, decKey]]);
  const decrypted = await runThrough(makeDecryptTransform(() => keys), encrypted);
  assert.equal(decrypted.length, 3, "all frames decrypt");
  for (let i = 0; i < frames.length; i++) {
    assert.deepEqual(
      new Uint8Array(decrypted[i]!.data),
      new Uint8Array(frames[i]!.data),
      "byte-identical round-trip"
    );
  }
  void key;
});

test("E2EE media: tampered frames are dropped (fail closed)", async () => {
  const raw = randomBytes(MEDIA_KEY_BYTES);
  const encKey = await importAesGcm(raw, ["encrypt"]);
  const decKey = await importAesGcm(raw, ["decrypt"]);

  const frame = fakeFrame(500, 1);
  const [encrypted] = await runThrough(
    makeEncryptTransform(() => ({ keyId: 1, key: encKey })),
    [frame]
  );
  assert.ok(encrypted);

  /* flip one bit in the ciphertext body */
  const tampered = new Uint8Array(encrypted!.data);
  tampered[tampered.length - 1]! ^= 0xff;
  const tamperedFrame: EncodedFrame = { ...encrypted!, data: tampered.buffer };

  let drops = 0;
  const keys = new Map<number, CryptoKey>([[1, decKey]]);
  const out = await runThrough(
    makeDecryptTransform(() => keys, () => drops++),
    [tamperedFrame]
  );
  assert.equal(out.length, 0, "the tampered frame never reaches the decoder");
  assert.equal(drops, 1);
});

test("E2EE media: unknown key id drops frames (no key yet / departed member)", async () => {
  const raw = randomBytes(MEDIA_KEY_BYTES);
  const encKey = await importAesGcm(raw, ["encrypt"]);

  const [encrypted] = await runThrough(
    makeEncryptTransform(() => ({ keyId: 3, key: encKey })),
    [fakeFrame(300, 1)]
  );
  assert.ok(encrypted);

  /* the receiver has keys for id 1 and 2 — NOT 3 */
  const otherRaw = randomBytes(MEDIA_KEY_BYTES);
  const keys = new Map<number, CryptoKey>([
    [1, await importAesGcm(otherRaw, ["decrypt"])],
    [2, await importAesGcm(randomBytes(MEDIA_KEY_BYTES), ["decrypt"])],
  ]);
  let drops = 0;
  const out = await runThrough(
    makeDecryptTransform(() => keys, () => drops++),
    [encrypted!]
  );
  assert.equal(out.length, 0, "frames without a known key never emit plaintext");
  assert.equal(drops, 1);
});

test("E2EE media: nonces never repeat — counters are unique per transform, salts separate transforms", async () => {
  const raw = randomBytes(MEDIA_KEY_BYTES);
  const encKey = await importAesGcm(raw, ["encrypt"]);
  const getKey = () => ({ keyId: 1, key: encKey });

  const frames = Array.from({ length: 20 }, (_, i) => fakeFrame(100, i));
  const [encA] = [await runThrough(makeEncryptTransform(getKey), frames)];
  const encB = await runThrough(makeEncryptTransform(getKey), frames);

  /* counters 0..19 (monotonic, pre-increment value rides in the header) */
  const counters = encA.map((f) => new DataView(f.data).getUint32(4, false));
  for (let i = 0; i < counters.length; i++) {
    assert.equal(counters[i], i, "counter increments per frame");
  }
  /* the two transform instances use different 3-byte salts */
  const saltA = new Uint8Array(encA[0]!.data).subarray(1, 4);
  const saltB = new Uint8Array(encB[0]!.data).subarray(1, 4);
  assert.notDeepEqual([...saltA], [...saltB], "per-instance stream salt separates nonce spaces");
});

test("E2EE media: rotation — the old key decrypts nothing after the key id advances", async () => {
  const raw1 = randomBytes(MEDIA_KEY_BYTES);
  const raw2 = randomBytes(MEDIA_KEY_BYTES);
  const encKey1 = await importAesGcm(raw1, ["encrypt"]);
  const encKey2 = await importAesGcm(raw2, ["encrypt"]);
  const decKey1 = await importAesGcm(raw1, ["decrypt"]);
  const decKey2 = await importAesGcm(raw2, ["decrypt"]);

  /* before rotation: id 1 with key1 */
  let keyId = 1;
  let encKey = encKey1;
  const preRotation = await runThrough(
    makeEncryptTransform(() => ({ keyId, key: encKey })),
    [fakeFrame(600, 1)]
  );

  /* rotate: id 2 with key2 */
  keyId = 2;
  encKey = encKey2;
  const postRotation = await runThrough(
    makeEncryptTransform(() => ({ keyId, key: encKey })),
    [fakeFrame(600, 2)]
  );

  /* a peer that only has the NEW key: post-rotation frames decrypt,
     pre-rotation frames drop (they were history anyway) */
  const newOnly = new Map<number, CryptoKey>([[2, decKey2]]);
  const decNew = await runThrough(
    makeDecryptTransform(() => newOnly),
    postRotation
  );
  assert.equal(decNew.length, 1, "the rotated key decrypts new frames");

  const decOld = await runThrough(
    makeDecryptTransform(() => newOnly),
    preRotation
  );
  assert.equal(decOld.length, 0, "the departed member's stale key state gets nothing");

  /* a live peer holds BOTH keys during the transition window */
  const both = new Map<number, CryptoKey>([
    [1, decKey1],
    [2, decKey2],
  ]);
  const decBoth = await runThrough(makeDecryptTransform(() => both), [
    ...preRotation,
    ...postRotation,
  ]);
  assert.equal(decBoth.length, 2, "both decrypt during the transition");
});

test("E2EE media: base64 helpers round-trip key bytes", () => {
  const raw = randomBytes(MEDIA_KEY_BYTES);
  const b64 = bytesToB64(raw);
  assert.equal(b64.length, 24, "16 bytes → 24 base64 chars (with padding)");
  assert.deepEqual(b64ToBytes(b64), raw);
});
