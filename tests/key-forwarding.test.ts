/*
 * Grungus — room key forwarding (m.room_key_request / m.forwarded_room_key)
 * against the mock homeserver.
 *
 * Covers: a second device of the same user receiving history via a
 * forwarded megolm session; an unverified stranger being declined; a
 * SAS-verified member receiving history after joining.
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient, type MessageItem } from "../src/renderer/services/matrix-client.ts";
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
  timeoutMs = 8_000,
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

async function makeCryptoClient(
  hs: MockHomeserver,
  username: string,
  password: string
): Promise<{ client: MatrixClient; crypto: E2eeCrypto }> {
  hs.registerUser(username, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username, password });
  const crypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await crypto.init();
  client.crypto = crypto;
  /* mirror the app shell wiring: a forwarded key retries tracked UTD events */
  crypto.onInboundSessionAdded = (roomId) => client.retryUndecrypted(roomId);
  return { client, crypto };
}

function bodies(client: MatrixClient, roomId: string): string[] {
  return (client.getRoom(roomId)?.timeline ?? [])
    .filter((item): item is MessageItem => item.kind === "message")
    .map((item) => item.body);
}

function utdCount(client: MatrixClient, roomId: string): number {
  return (client.getRoom(roomId)?.timeline ?? []).filter(
    (item) => item.kind === "system" && item.text.includes("Unable to decrypt")
  ).length;
}

test("forwarding: a second device of the same user receives history", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const { client: c1, crypto: k1 } = await makeCryptoClient(hs, "forw", "pw1");
  c1.startSync();
  t.after(() => c1.stopSync());

  const roomId = await c1.createRoom({
    name: "forward-room",
    isPublic: true,
    encrypted: true,
  });
  await waitFor(() => c1.getRoom(roomId) !== null, 5_000, "room syncs");
  await c1.sendMessage(roomId, "history-1");
  await c1.sendMessage(roomId, "history-2");
  await waitFor(
    () => bodies(c1, roomId).includes("history-2"),
    5_000,
    "sender sees own messages"
  );

  /* a second device of the SAME user logs in with a fresh olm identity */
  const { client: c2 } = await makeCryptoClient(hs, "forw", "pw1");
  c2.startSync();
  t.after(() => c2.stopSync());

  /* initial sync renders UTD lines and fires m.room_key_request; the
     first device should forward and the lines should turn into messages */
  await waitFor(
    () => {
      const got = bodies(c2, roomId);
      return got.includes("history-1") && got.includes("history-2");
    },
    10_000,
    "second device decrypts history via forwarded key"
  );
  assert.equal(utdCount(c2, roomId), 0, "no UTD lines remain");
  void k1;
});

test("forwarding: an unverified stranger is declined", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const { client: c1 } = await makeCryptoClient(hs, "guard", "pw1");
  c1.startSync();
  t.after(() => c1.stopSync());
  const roomId = await c1.createRoom({
    name: "guard-room",
    isPublic: true,
    encrypted: true,
  });
  await waitFor(() => c1.getRoom(roomId) !== null, 5_000, "room syncs");
  await c1.sendMessage(roomId, "secret-before-join");
  await waitFor(
    () => bodies(c1, roomId).includes("secret-before-join"),
    5_000,
    "sender sees own message"
  );

  const { client: stranger } = await makeCryptoClient(hs, "sneak", "pw2");
  stranger.startSync();
  t.after(() => stranger.stopSync());
  await stranger.joinRoom(roomId);
  /* the join rotates the sender's outbound session, but the stranger still
     syncs the pre-join ciphertext and requests its key */
  await waitFor(
    () => utdCount(stranger, roomId) >= 1,
    8_000,
    "stranger sees the pre-join event as UTD"
  );

  /* the guard declines the request — the UTD line must persist */
  await new Promise((r) => setTimeout(r, 1_500));
  assert.ok(
    !bodies(stranger, roomId).includes("secret-before-join"),
    "stranger never receives the pre-join plaintext"
  );
  assert.ok(utdCount(stranger, roomId) >= 1, "history stays undecryptable");
});

test("forwarding: a SAS-verified member receives history after joining", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const { client: c1, crypto: k1 } = await makeCryptoClient(hs, "vet", "pw1");
  const { client: c2, crypto: k2 } = await makeCryptoClient(hs, "trust", "pw2");
  const manager1 = new VerificationManager(k1);
  k1.addPayloadListener((sender, type, content) => {
    void manager1.handlePayload(sender, type, content);
  });
  const manager2 = new VerificationManager(k2);
  k2.addPayloadListener((sender, type, content) => {
    void manager2.handlePayload(sender, type, content);
  });
  manager1.onIncoming = (txn) => {
    void txn.sendStart();
  };
  manager2.onIncoming = (txn) => {
    void txn.sendStart();
  };
  c1.startSync();
  c2.startSync();
  t.after(() => {
    c1.stopSync();
    c2.stopSync();
  });

  const roomId = await c1.createRoom({
    name: "trust-room",
    isPublic: true,
    encrypted: true,
  });
  await waitFor(() => c1.getRoom(roomId) !== null, 5_000, "room syncs");
  await c1.sendMessage(roomId, "pre-join-secret");
  await waitFor(
    () => bodies(c1, roomId).includes("pre-join-secret"),
    5_000,
    "sender sees own message"
  );

  /* verify the two users via SAS first */
  const txnA = manager1.start(c2.userId!, c2.deviceId ?? "");
  await waitFor(
    () =>
      manager1.transactions.some((txn) => txn.phase === "show-emoji") &&
      manager2.transactions.some((txn) => txn.phase === "show-emoji"),
    10_000,
    "emoji phase"
  );
  const txnB: SasTransaction = manager2.transactions.find(
    (txn) => txn.phase === "show-emoji"
  )!;
  await txnA.confirmEmojiMatch();
  await txnB.confirmEmojiMatch();
  await waitFor(
    () =>
      manager1.transactions.every((txn) => txn.phase === "verified") &&
      manager2.transactions.every((txn) => txn.phase === "verified"),
    10_000,
    "both verified"
  );

  /* now the verified user joins and should be able to get the history */
  await c2.joinRoom(roomId);
  await waitFor(
    () => bodies(c2, roomId).includes("pre-join-secret"),
    10_000,
    "verified member receives history via forwarded key"
  );
});
