/*
 * Grungus — SAS device verification against the mock homeserver: a full
 * two-party handshake with real libolm SAS crypto, emoji equality, mutual
 * trust marking, and a tamper rejection.
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
import {
  VerificationManager,
  type SasTransaction,
} from "../src/renderer/services/sas.ts";

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
): Promise<{ client: MatrixClient; crypto: E2eeCrypto; manager: VerificationManager }> {
  hs.registerUser(name, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: name, password });
  const crypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await crypto.init();
  client.crypto = crypto;
  const manager = new VerificationManager(crypto);
  crypto.addPayloadListener((sender, type, content) => {
    manager.handlePayload(sender, type, content);
  });
  return { client, crypto, manager };
}

function emojiPhaseTxn(manager: VerificationManager): SasTransaction | null {
  return (
    manager.transactions.find((txn) => txn.phase === "show-emoji") ??
    (manager.transactions.length === 1 ? manager.transactions[0]! : null)
  );
}

test("SAS: full handshake, identical emoji, mutual trust marking", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeCryptoUser(hs, "val", "pw1");
  const b = await makeCryptoUser(hs, "wil", "pw2");
  a.client.startSync();
  b.client.startSync();
  t.after(() => {
    a.client.stopSync();
    b.client.stopSync();
  });

  /* responder auto-accepts incoming requests */
  b.manager.onIncoming = (txn) => {
    void txn.sendStart();
  };

  /* a needs to see b's device — the request carries the device id, but the
     MAC check queries the server directory, so warm it with a message */
  const warmRoom = await a.client.createRoom({ name: "warm", isPublic: true });
  await b.client.joinRoom(warmRoom);
  await waitFor(
    () => a.client.getRoom(warmRoom) !== null && b.client.getRoom(warmRoom) !== null,
    5_000,
    "rooms sync"
  );
  await a.client.sendMessage(warmRoom, "warm-up");
  await waitFor(
    () =>
      (b.client.getRoom(warmRoom)?.timeline ?? []).some((item) => item.kind === "message"),
    5_000,
    "warm-up delivered"
  );

  const txnA = a.manager.start(b.client.userId!, b.client.deviceId!);
  assert.equal(txnA.initiatedByMe, true);

  await waitFor(
    () =>
      a.manager.transactions.some((txn) => txn.phase === "show-emoji") &&
      b.manager.transactions.some((txn) => txn.phase === "show-emoji"),
    10_000,
    "both sides reach the emoji phase"
  );

  /* identical emoji on both sides */
  const emojisA = a.manager.transactions.find(
    (txn) => txn.phase === "show-emoji"
  )!.emoji;
  const emojisB = b.manager.transactions.find(
    (txn) => txn.phase === "show-emoji"
  )!.emoji;
  assert.equal(emojisA.length, 7, "seven emoji per the spec's bit packing");
  assert.deepEqual(emojisA, emojisB, "both devices show identical emoji");

  /* confirm on both sides */
  const txnB = b.manager.transactions.find((txn) => txn.phase === "show-emoji")!;
  await txnA.confirmEmojiMatch();
  await txnB.confirmEmojiMatch();

  await waitFor(
    () =>
      a.manager.transactions.every((txn) => txn.phase === "verified") &&
      b.manager.transactions.every((txn) => txn.phase === "verified"),
    10_000,
    "both transactions verify"
  );

  /* mutual trust marking */
  const verifiedByA = await a.crypto.getVerifiedKey(b.client.userId!, b.client.deviceId!);
  assert.equal(verifiedByA, b.crypto.ed25519Key);
  const verifiedByB = await b.crypto.getVerifiedKey(a.client.userId!, a.client.deviceId!);
  assert.equal(verifiedByB, a.crypto.ed25519Key);
});

test("SAS: a forged MAC fails the verification", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeCryptoUser(hs, "xan", "pw1");
  const b = await makeCryptoUser(hs, "yuki", "pw2");
  a.client.startSync();
  b.client.startSync();
  t.after(() => {
    a.client.stopSync();
    b.client.stopSync();
  });
  b.manager.onIncoming = (txn) => {
    void txn.sendStart();
  };

  const warmRoom = await a.client.createRoom({ name: "warm2", isPublic: true });
  await b.client.joinRoom(warmRoom);
  await waitFor(
    () => a.client.getRoom(warmRoom) !== null && b.client.getRoom(warmRoom) !== null,
    5_000,
    "rooms sync"
  );
  await a.client.sendMessage(warmRoom, "warm-up");
  await waitFor(
    () =>
      (b.client.getRoom(warmRoom)?.timeline ?? []).some((item) => item.kind === "message"),
    5_000,
    "warm-up delivered"
  );

  const txnA = a.manager.start(b.client.userId!, b.client.deviceId!);
  await waitFor(
    () =>
      a.manager.transactions.some((txn) => txn.phase === "show-emoji") &&
      b.manager.transactions.some((txn) => txn.phase === "show-emoji"),
    10_000,
    "emoji phase"
  );

  /* A confirms; B forges a MAC instead of confirming */
  await txnA.confirmEmojiMatch();
  const txnB = b.manager.transactions.find((txn) => txn.phase === "show-emoji")!;
  await b.crypto.sendToDeviceEncrypted(a.client.userId!, a.client.deviceId!, "m.key.verification.mac", {
    transaction_id: txnB.transactionId,
    from_device: b.client.deviceId,
    mac: { [`ed25519:${b.client.deviceId}`]: "FORGED" },
    keys: "FORGED",
  });

  await waitFor(
    () => a.manager.transactions.some((txn) => txn.phase === "failed"),
    10_000,
    "forgery detected"
  );
  const failed = a.manager.transactions.find((txn) => txn.phase === "failed")!;
  assert.ok(failed.error!.includes("MAC"), `failure explains the MAC: ${failed.error}`);

  /* and nothing was marked verified */
  const verified = await a.crypto.getVerifiedKey(b.client.userId!, b.client.deviceId!);
  assert.equal(verified, null, "forged device is NOT trusted");
});
