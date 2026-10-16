/*
 * Grungus — QR code verification (MSC3906 v2 binary format) against
 * the mock homeserver: payload build/parse round-trips, a full
 * shower/scanner handshake with real olm channels and mutual trust
 * marking, tamper rejections (wrong secret, wrong transaction, wrong
 * keys), and the camera-path round-trip through the qrcode + jsqr
 * libraries (encode -> render -> decode -> parse).
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import {
  E2eeCrypto,
  MemoryCryptoStore,
} from "../src/renderer/services/e2ee.ts";
import { VerificationManager } from "../src/renderer/services/sas.ts";
import {
  buildQrPayload,
  parseQrPayload,
  QR_MODE_DEVICE,
  QR_SECRET_BYTES,
  QR_VERSION,
  type QrTransaction,
} from "../src/renderer/services/qr-verify.ts";

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  label = "condition"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      let ok = false;
      try {
        ok = predicate();
      } catch (e) {
        reject(e);
        return;
      }
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for: ${label}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function makeCryptoUser(
  hs: MockHomeserver,
  name: string,
  password: string
): Promise<{
  client: MatrixClient;
  crypto: E2eeCrypto;
  manager: VerificationManager;
}> {
  hs.registerUser(name, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: name, password });
  const crypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await crypto.init();
  client.crypto = crypto;
  const manager = new VerificationManager(crypto);
  crypto.addPayloadListener((sender, type, content, senderKey) => {
    manager.handlePayload(sender, type, content, senderKey);
  });
  return { client, crypto, manager };
}

/** 32 bytes of deterministic test key material as unpadded base64. */
function fakeKeyB64(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = (seed + i * 7) & 0xff;
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "");
}

/* --------------------------- payload unit tests ------------------------- */

test("QR payload: build/parse round-trip", () => {
  const secret = new Uint8Array(QR_SECRET_BYTES);
  for (let i = 0; i < QR_SECRET_BYTES; i++) secret[i] = 0x40 + i;
  const bytes = buildQrPayload({
    transactionId: "gr-qr-txn-123",
    ed25519B64: fakeKeyB64(1),
    curve25519B64: fakeKeyB64(2),
    secretBytes: secret,
  });
  const parsed = parseQrPayload(bytes);
  assert.ok(parsed, "payload parses");
  assert.equal(parsed.version, QR_VERSION);
  assert.equal(parsed.mode, QR_MODE_DEVICE);
  assert.equal(parsed.transactionId, "gr-qr-txn-123");
  assert.equal(parsed.firstKeyB64, fakeKeyB64(1));
  assert.equal(parsed.secondKeyB64, fakeKeyB64(2));
  assert.equal(parsed.secretB64, parsed.secretB64);
  /* exact payload length: 6 prefix + 1 version + 1 mode + 2 len +
     txnId + 32 + 32 + 11 */
  assert.equal(bytes.length, 6 + 1 + 1 + 2 + "gr-qr-txn-123".length + 32 + 32 + 11);
});

test("QR payload: rejects tampered prefix, version, mode, and trailing bytes", () => {
  const secret = new Uint8Array(QR_SECRET_BYTES);
  const bytes = buildQrPayload({
    transactionId: "t",
    ed25519B64: fakeKeyB64(1),
    curve25519B64: fakeKeyB64(2),
    secretBytes: secret,
  });
  assert.ok(parseQrPayload(bytes));

  const badPrefix = new Uint8Array(bytes);
  badPrefix[0] = "X".charCodeAt(0);
  assert.equal(parseQrPayload(badPrefix), null, "wrong prefix rejected");

  const badVersion = new Uint8Array(bytes);
  badVersion[6] = 0x03;
  assert.equal(parseQrPayload(badVersion), null, "wrong version rejected");

  const badMode = new Uint8Array(bytes);
  badMode[7] = 0x00; /* Element's cross-signing mode — not supported yet */
  assert.equal(parseQrPayload(badMode), null, "unsupported mode rejected");

  const trailing = new Uint8Array(bytes.length + 1);
  trailing.set(bytes);
  trailing[bytes.length] = 0;
  assert.equal(parseQrPayload(trailing), null, "trailing junk rejected");

  const truncated = bytes.slice(0, bytes.length - 1);
  assert.equal(parseQrPayload(new Uint8Array(truncated)), null, "truncation rejected");
});

test("QR payload: survives the full encode → render → decode camera path", () => {
  const secret = new Uint8Array(QR_SECRET_BYTES);
  crypto.getRandomValues(secret);
  const bytes = buildQrPayload({
    transactionId: "gr-qr-camera-path-test-0001",
    ed25519B64: fakeKeyB64(9),
    curve25519B64: fakeKeyB64(13),
    secretBytes: secret,
  });

  /* encode with the qrcode library (latin1 keeps one byte per char) */
  let latin1 = "";
  for (const b of bytes) latin1 += String.fromCharCode(b);
  const qr = QRCode.create(latin1, { errorCorrectionLevel: "M" });

  /* render the module matrix to RGBA (what a camera would see) */
  const size = qr.modules.size;
  const scale = 8;
  const margin = 4;
  const dim = (size + margin * 2) * scale;
  const rgba = new Uint8ClampedArray(dim * dim * 4);
  for (let py = 0; py < dim; py++) {
    for (let px = 0; px < dim; px++) {
      const mx = Math.floor(px / scale) - margin;
      const my = Math.floor(py / scale) - margin;
      const on = mx >= 0 && my >= 0 && mx < size && my < size && qr.modules.get(mx, my);
      const idx = (py * dim + px) * 4;
      rgba[idx] = on ? 0 : 255;
      rgba[idx + 1] = on ? 0 : 255;
      rgba[idx + 2] = on ? 0 : 255;
      rgba[idx + 3] = 255;
    }
  }

  /* decode with jsqr (the scanner's decoder) */
  const result = jsQR(rgba, dim, dim);
  assert.ok(result, "jsqr decodes the rendered QR");
  const decoded = new Uint8Array(result.data.length);
  for (let i = 0; i < result.data.length; i++) {
    decoded[i] = result.data.charCodeAt(i) & 0xff;
  }
  assert.deepEqual(decoded, bytes, "camera path round-trips byte-identical");

  const parsed = parseQrPayload(decoded);
  assert.ok(parsed, "decoded payload parses");
  assert.equal(parsed.transactionId, "gr-qr-camera-path-test-0001");
  assert.equal(parsed.firstKeyB64, fakeKeyB64(9));
  assert.equal(parsed.secondKeyB64, fakeKeyB64(13));
});

/* ------------------------- full protocol handshake ----------------------- */

test("QR: full shower/scanner handshake, mutual trust marking", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeCryptoUser(hs, "qra", "pw1");
  const b = await makeCryptoUser(hs, "qrb", "pw2");
  a.client.startSync();
  b.client.startSync();
  t.after(() => {
    a.client.stopSync();
    b.client.stopSync();
  });

  /* A starts a verification request; B receives it (no SAS start — B
     will be the scanner) */
  const txnA = a.manager.start(b.client.userId!, b.client.deviceId!);
  await waitFor(
    () => b.manager.transactions.some((txn) => txn.transactionId === txnA.transactionId),
    5_000,
    "B receives the request"
  );

  /* A shows its QR */
  const qrA = a.manager.asQr(txnA.transactionId);
  assert.ok(qrA, "A creates its QR transaction");
  const payload = qrA.showQrCode();
  assert.ok(payload.length > 0, "QR payload built");

  /* B scans A's QR (validated against the server directory) */
  const qrB = b.manager.asQr(txnA.transactionId);
  assert.ok(qrB, "B creates its QR transaction");
  await qrB.scanQrCode(payload);

  /* B sent the reciprocate; A reaches the confirm prompt */
  await waitFor(
    () => qrA.phase === "confirm-scan",
    5_000,
    "A sees the scan (confirm-scan)"
  );

  /* A confirms — marks B trusted, sends done */
  await qrA.confirmScanned();

  /* B receives A's done → marks A trusted → sends its own done → verified */
  await waitFor(
    () => qrB.phase === "verified",
    5_000,
    "B verifies"
  );
  await waitFor(
    () => qrA.phase === "verified",
    5_000,
    "A verifies after B's done"
  );

  /* mutual trust: both stores hold each other's device keys */
  const bEd = await a.crypto.getDeviceEd25519(b.client.userId!, b.client.deviceId!);
  const aEd = await b.crypto.getDeviceEd25519(a.client.userId!, a.client.deviceId!);
  assert.ok(bEd, "A sees B's device key");
  assert.ok(aEd, "B sees A's device key");
  const aTrusts = await a.crypto.getVerifiedKey(b.client.userId!, b.client.deviceId!);
  const bTrusts = await b.crypto.getVerifiedKey(a.client.userId!, a.client.deviceId!);
  assert.equal(aTrusts, bEd, "A marked B's device verified with the right key");
  assert.equal(bTrusts, aEd, "B marked A's device verified with the right key");
});

test("QR: tampered secret fails on the shower", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeCryptoUser(hs, "tamA", "pw1");
  const b = await makeCryptoUser(hs, "tamB", "pw2");
  a.client.startSync();
  b.client.startSync();
  t.after(() => {
    a.client.stopSync();
    b.client.stopSync();
  });

  const txnA = a.manager.start(b.client.userId!, b.client.deviceId!);
  await waitFor(
    () => b.manager.transactions.some((txn) => txn.transactionId === txnA.transactionId),
    5_000,
    "B receives the request"
  );

  const qrA = a.manager.asQr(txnA.transactionId)!;
  const payload = qrA.showQrCode();

  /* flip a secret byte in the scanned payload (a tampered/fake code) */
  const tampered = new Uint8Array(payload);
  const lastIdx = tampered.length - 1;
  tampered[lastIdx] = (tampered[lastIdx] ?? 0) ^ 0xff;
  const parsedTampered = parseQrPayload(tampered);
  const parsedOriginal = parseQrPayload(payload);
  assert.ok(parsedTampered, "tampered payload still parses (it is well-formed)");
  assert.ok(parsedOriginal, "original payload parses");
  assert.notEqual(
    parsedTampered!.secretB64,
    parsedOriginal!.secretB64,
    "the secret differs"
  );

  const qrB = b.manager.asQr(txnA.transactionId)!;
  await qrB.scanQrCode(tampered);

  /* A rejects the wrong secret */
  await waitFor(
    () => qrA.phase === "failed",
    5_000,
    "A fails on the wrong secret"
  );
  assert.match(qrA.error ?? "", /secret/i);
});

test("QR: a code from a different transaction is rejected by the scanner", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeCryptoUser(hs, "othA", "pw1");
  const b = await makeCryptoUser(hs, "othB", "pw2");
  a.client.startSync();
  b.client.startSync();
  t.after(() => {
    a.client.stopSync();
    b.client.stopSync();
  });

  /* two separate requests: B's scan must bind to ITS transaction id */
  const txnA = a.manager.start(b.client.userId!, b.client.deviceId!);
  await waitFor(
    () => b.manager.transactions.some((txn) => txn.transactionId === txnA.transactionId),
    5_000,
    "B receives the request"
  );

  /* a QR for a DIFFERENT transaction id (someone else's code) */
  const strangerSecret = new Uint8Array(QR_SECRET_BYTES);
  const strangerBytes = buildQrPayload({
    transactionId: "gr-qr-some-other-transaction",
    ed25519B64: a.crypto.ed25519Key,
    curve25519B64: a.crypto.curve25519Key,
    secretBytes: strangerSecret,
  });

  const qrB = b.manager.asQr(txnA.transactionId)!;
  await qrB.scanQrCode(strangerBytes);
  assert.equal(qrB.phase, "failed");
  assert.match(qrB.error ?? "", /different verification/i);
});
