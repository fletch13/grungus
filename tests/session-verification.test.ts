/*
 * Grungus — session verification (verify THIS login against the same
 * user's other devices) against the mock homeserver, plus the
 * prompt-based incoming-request flow (no silent auto-accept).
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import {
  E2eeCrypto,
  MemoryCryptoStore,
} from "../src/renderer/services/e2ee.ts";
import { VerificationManager, type SasTransaction } from "../src/renderer/services/sas.ts";

function waitFor(predicate: () => boolean, timeoutMs = 8_000, label = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("Timed out: " + label));
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function makeCryptoClient(
  hs: MockHomeserver,
  username: string,
  password: string
): Promise<{ client: MatrixClient; crypto: E2eeCrypto; manager: VerificationManager }> {
  hs.registerUser(username, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username, password });
  const crypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await crypto.init();
  client.crypto = crypto;
  const manager = new VerificationManager(crypto);
  crypto.addPayloadListener((sender, type, content) => {
    manager.handlePayload(sender, type, content);
  });
  return { client, crypto, manager };
}

test("session verification: new device asks, existing device PROMPTS, handshake verifies both", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  /* the "existing" device of user ses (online first) */
  const old = await makeCryptoClient(hs, "ses", "pw1");
  old.client.startSync();
  t.after(() => old.client.stopSync());

  /* a NEW login of the same user — the fresh session */
  const fresh = await makeCryptoClient(hs, "ses", "pw1");
  fresh.client.startSync();
  t.after(() => fresh.client.stopSync());

  /* the existing device does NOT auto-accept anything by default */
  let prompted: SasTransaction | null = null;
  old.manager.onIncoming = (txn) => {
    prompted = txn;
  };

  /* the fresh device starts session verification against its own devices */
  const txns = await fresh.manager.startSessionVerification();
  assert.ok(txns.length >= 1, "one transaction per own device (old one)");
  const txnFresh = txns.find((x) => x.peerDeviceId === old.client.deviceId);
  assert.ok(txnFresh, "the existing device was targeted");

  /* the existing device got an incoming REQUEST — phase "requested", not
     started: the human must accept */
  await waitFor(() => prompted !== null, 8_000, "existing device is prompted");
  const incoming = prompted!;
  assert.equal(incoming.phase, "requested");
  assert.equal(incoming.initiatedByMe, false);
  assert.equal(incoming.peerDeviceId, fresh.client.deviceId);

  /* the user accepts on the existing device → handshake runs */
  await incoming.sendStart();
  await waitFor(
    () =>
      fresh.manager.transactions.some((txn) => txn.phase === "show-emoji") &&
      old.manager.transactions.some((txn) => txn.phase === "show-emoji"),
    10_000,
    "both devices reach the emoji phase"
  );

  /* identical emoji */
  const emojiFresh = fresh.manager.transactions.find((x) => x.phase === "show-emoji")!.emoji;
  const emojiOld = old.manager.transactions.find((x) => x.phase === "show-emoji")!.emoji;
  assert.deepEqual(emojiFresh, emojiOld);

  /* both confirm */
  const txnOld = old.manager.transactions.find((x) => x.phase === "show-emoji")!;
  await txnFresh!.confirmEmojiMatch();
  await txnOld.confirmEmojiMatch();
  await waitFor(
    () =>
      old.manager.transactions.every((x) => x.phase === "verified") &&
      fresh.manager.transactions.every((x) => x.phase === "verified"),
    10_000,
    "session verified both ways"
  );

  /* the SESSION is now verified on both devices: mutual trust */
  const freshTrustsOld = await fresh.crypto.getVerifiedKey(
    old.client.userId!,
    old.client.deviceId!
  );
  assert.equal(freshTrustsOld, old.crypto.ed25519Key);
  const oldTrustsFresh = await old.crypto.getVerifiedKey(
    fresh.client.userId!,
    fresh.client.deviceId!
  );
  assert.equal(oldTrustsFresh, fresh.crypto.ed25519Key);
});

test("session verification: declining sends a cancel and verifies nothing", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const old = await makeCryptoClient(hs, "dec", "pw1");
  old.client.startSync();
  t.after(() => old.client.stopSync());
  const fresh = await makeCryptoClient(hs, "dec", "pw1");
  fresh.client.startSync();
  t.after(() => fresh.client.stopSync());

  let prompted: SasTransaction | null = null;
  old.manager.onIncoming = (txn) => {
    prompted = txn;
  };

  const txns = await fresh.manager.startSessionVerification();
  assert.ok(txns.length >= 1);
  await waitFor(() => prompted !== null, 8_000, "prompt arrives");

  /* the user DECLINES on the existing device */
  const incoming = prompted!;
  await old.manager.cancel(incoming.transactionId);

  /* the initiator sees the transaction cancelled; nothing gets verified */
  await waitFor(
    () => fresh.manager.transactions.every((x) => x.phase === "cancelled"),
    8_000,
    "initiator sees the cancellation"
  );
  const oldTrustsFresh = await old.crypto.getVerifiedKey(
    fresh.client.userId!,
    fresh.client.deviceId!
  );
  assert.equal(oldTrustsFresh, null, "declined device is NOT trusted");
});
