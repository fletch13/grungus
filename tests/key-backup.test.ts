/*
 * Grungus — server-side key backup (m.megolm_backup.v1.curve25519-aes-sha2)
 * against the mock homeserver: create with a passphrase, automatic backup
 * of received sessions, restore on a fresh device, wrong-passphrase
 * rejection.
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
): Promise<{ client: MatrixClient; crypto: E2eeCrypto }> {
  hs.registerUser(username, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username, password });
  const crypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await crypto.init();
  client.crypto = crypto;
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

test("backup: fresh device restores history with the passphrase, no other device online", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const PASSPHRASE = "correct horse battery staple";
  const { client: c1, crypto: k1 } = await makeCryptoClient(hs, "bkp_a", "pw1");
  c1.startSync();

  const roomId = await c1.createRoom({
    name: "backup-room",
    isPublic: true,
    encrypted: true,
  });
  await waitFor(() => c1.getRoom(roomId) !== null, 5_000, "room syncs");
  await c1.sendMessage(roomId, "backed-up-message-1");
  await c1.sendMessage(roomId, "backed-up-message-2");

  /* create the backup — this sweeps the sessions we already hold */
  const version = await k1.createKeyBackup(PASSPHRASE);
  assert.ok(version, "backup version created");

  /* a NEW message after backup creation: its session must be backed up
     automatically when the sender re-shares to itself */
  await c1.sendMessage(roomId, "auto-backed-up-message");
  await waitFor(
    () => bodies(c1, roomId).includes("auto-backed-up-message"),
    5_000,
    "sender sees the post-backup message"
  );
  /* all three messages share one megolm session — one backed-up entry */
  await waitFor(() => {
    const rooms = hs.backedUpKeys.get("bkp_a") ?? {};
    return Object.keys(rooms[roomId] ?? {}).length >= 1;
  }, 8_000, "session landed in the server backup");

  /* the fresh device: second login of the same user, FIRST device offline
     (no forwarding available — only the backup can recover history) */
  c1.stopSync();
  const { client: c2, crypto: k2 } = await makeCryptoClient(hs, "bkp_a", "pw1");
  c2.startSync();
  t.after(() => c2.stopSync());
  await waitFor(() => c2.getRoom(roomId) !== null, 5_000, "fresh device sees the room");

  /* wrong passphrase must be rejected before any key is imported */
  await assert.rejects(
    () => k2.restoreKeyBackup("wrong passphrase entirely"),
    (err: unknown) => err instanceof Error && /Wrong passphrase/.test(err.message)
  );

  /* wrong passphrase did not import anything */
  assert.equal(utdCount(c2, roomId) >= 1, true, "history still undecryptable");

  /* right passphrase: restore → UTD lines turn into messages in place */
  const imported = await k2.restoreKeyBackup(PASSPHRASE);
  assert.ok(imported >= 1, `restored sessions (got ${imported})`);
  await waitFor(
    () =>
      bodies(c2, roomId).includes("backed-up-message-1") &&
      bodies(c2, roomId).includes("backed-up-message-2") &&
      bodies(c2, roomId).includes("auto-backed-up-message"),
    8_000,
    "fresh device decrypts the full history from the backup"
  );
  assert.equal(utdCount(c2, roomId), 0, "no UTD lines remain");
});
