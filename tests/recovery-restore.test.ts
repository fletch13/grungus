/*
 * Grungus — recovery restore, Element-compatible.
 *
 * The scenario the user hit: an account set up in the Element client
 * (recovery passphrase + key backup whose private key lives in secret
 * storage) could not be restored in Grungus, which only understood its
 * own passphrase-derived backups.
 *
 * Covered here:
 *   - the olm recovery-key codec (base58, 0x8B01 prefix, XOR parity)
 *   - restoreWithRecovery with an Element-style SSSS + backup setup:
 *     passphrase → SSSS → m.megolm_backup.v1 secret → backup key
 *   - restore with the base58 recovery KEY string too
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeRecoveryKey,
  tryDecodeRecoveryKey,
  SecretStorage,
} from "../src/renderer/services/ssss.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { E2eeCrypto, MemoryCryptoStore } from "../src/renderer/services/e2ee.ts";
import { MockHomeserver } from "./mock-homeserver.ts";

test("the recovery-key codec round-trips (olm base58 format)", () => {
  const key = new Uint8Array(32).map((_, i) => (i * 11 + 7) & 0xff);
  const encoded = encodeRecoveryKey(key);
  /* grouped by 4, base58 only */
  assert.ok(encoded.includes(" "));
  const decoded = tryDecodeRecoveryKey(encoded);
  assert.ok(decoded, "a freshly encoded key decodes");
  assert.deepEqual([...decoded!], [...key]);
  /* spaces are optional */
  assert.deepEqual([...tryDecodeRecoveryKey(encoded.replace(/ /g, ""))!], [...key]);
  /* wrong parity is rejected */
  const tampered = encoded.replace(/\s/g, "").split("");
  const lastChar = tampered[tampered.length - 1]!;
  tampered[tampered.length - 1] = lastChar === "1" ? "2" : "1";
  assert.equal(tryDecodeRecoveryKey(tampered.join("")), null);
  /* junk is rejected, passphrases are not keys */
  assert.equal(tryDecodeRecoveryKey("correct horse battery staple"), null);
  assert.equal(tryDecodeRecoveryKey(""), null);
});

function waitFor(predicate: () => boolean, label: string, timeoutMs = 8_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      if (predicate()) resolve();
      else if (Date.now() - start > timeoutMs) reject(new Error(`Timed out: ${label}`));
      else setTimeout(poll, 25);
    };
    poll();
  });
}

async function setup(): Promise<{
  hs: MockHomeserver;
  client: MatrixClient;
  cleanup: () => void;
}> {
  const hs = new MockHomeserver();
  await hs.listen();
  hs.registerUser("ruser", "pw");
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: "ruser", password: "pw" });
  client.startSync();
  const cleanup = (): void => {
    client.stopSync();
    hs.close();
  };
  return { hs, client, cleanup };
}

test("an Element-style backup (key in SSSS) restores with the passphrase", async (t) => {
  const { hs, client, cleanup } = await setup();
  t.after(cleanup);

  /* the ELEMENT side of the setup, built with the same spec functions
     an Element client uses (our ssss.ts formats are js-sdk-exact):
     SSSS keyed by a passphrase, the backup's private key stored as the
     m.megolm_backup.v1 secret, and a backup whose auth_data carries
     ONLY the public key (no passphrase KDF — Element's modern shape) */
  const elementCrypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await elementCrypto.init();
  client.crypto = elementCrypto; /* route to-device room keys through sync */

  const PASSPHRASE = "element-recovery-passphrase-42";
  const storage = new SecretStorage(client);
  await storage.createKey(PASSPHRASE, "Element test key");

  /* the backup key: a fresh curve25519 keypair (like Element's backup
     bootstrap) whose private half is parked in SSSS as base64 */
  const olm = (await import("@matrix-org/olm")).default;
  await olm.init();
  const backupPk = new olm.PkDecryption();
  const backupPrivateKey = crypto.getRandomValues(new Uint8Array(32));
  const backupPublicKey = backupPk.init_with_private_key(backupPrivateKey);
  let bin = "";
  for (const b of backupPrivateKey) bin += String.fromCharCode(b);
  const backupPrivateKeyB64 = btoa(bin);
  await storage.storeSecret("m.megolm_backup.v1", backupPrivateKeyB64);

  /* create the backup server-side, Element's shape: auth_data has the
     public key but NO passphrase KDF params */
  const createRes = await client.api<{ version: string }>(
    "POST",
    "/_matrix/client/v3/room_keys/version",
    {
      body: {
        algorithm: "m.megolm_backup.v1.curve25519-aes-sha2",
        auth_data: { public_key: backupPublicKey },
      },
    }
  );

  /* the user sends an encrypted message with the element device; its
     inbound session lands in the backup (encrypt with elementCrypto) */
  const roomId = await client.createRoom({ name: "recovery", isPublic: true, encrypted: true });
  await waitFor(() => client.getRoom(roomId)?.isEncrypted === true, "room encrypted");
  await client.sendMessage(roomId, "secret history");
  /* push the session into the backup manually (the element device's
     automatic backup path): export + PkEncrypt against the backup key */
  const pkEncryption = new olm.PkEncryption();
  pkEncryption.set_recipient_key(backupPublicKey);
  await waitFor(
    () => elementCrypto.debugInboundSessions().length > 0,
    "the sender's own inbound session lands via sync"
  );
  const inbound = [...elementCrypto.debugInboundSessions()][0];
  assert.ok(inbound, "the element device holds an inbound session");
  const exported = elementCrypto.debugExportSession(inbound.senderKey, inbound.sessionId);
  const payload = JSON.stringify({
    room_id: roomId,
    session_id: inbound.sessionId,
    session_key: exported,
    sender_key: inbound.senderKey,
  });
  const encrypted = pkEncryption.encrypt(payload);
  await client.api(
    "PUT",
    `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(roomId)}/${encodeURIComponent(inbound.sessionId)}`,
    {
      query: { version: createRes.version },
      body: {
        first_message_index: 0,
        forwarded_count: 0,
        session_data: {
          ciphertext: encrypted.ciphertext,
          mac: encrypted.mac,
          ephemeral: encrypted.ephemeral,
        },
      },
    }
  );

  /* THE USER'S FAILURE CASE: restore in a fresh Grungus device with the
     passphrase. The old code threw "not created with a passphrase". */
  const grungusCrypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await grungusCrypto.init();
  const imported = await grungusCrypto.restoreWithRecovery(PASSPHRASE);
  assert.equal(imported, 1, "the SSSS-held backup key restored the session");

  /* and the same works with the recovery KEY string */
  const freshCrypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await freshCrypto.init();
  /* re-derive the SSSS key bytes from the passphrase to build the key
     string the way Element shows it */
  const keyBytes = await storage.debugKeyBytes(PASSPHRASE);
  const recoveryKey = encodeRecoveryKey(keyBytes!);
  const importedViaKey = await freshCrypto.restoreWithRecovery(recoveryKey);
  assert.equal(importedViaKey, 1, "the base58 recovery key restores too");
});

test("a Grungus-style backup (passphrase-derived) still restores", async (t) => {
  const { hs, client, cleanup } = await setup();
  t.after(cleanup);

  const crypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await crypto.init();
  client.crypto = crypto;
  await crypto.createKeyBackup("grungus-pass-phrase");
  const roomId = await client.createRoom({ name: "own-backup", isPublic: true, encrypted: true });
  await waitFor(() => client.getRoom(roomId)?.isEncrypted === true, "room encrypted");
  await crypto.encryptRoomMessage(roomId, { body: "own backup", msgtype: "m.text" });
  await waitFor(
    () => crypto.debugInboundSessions().length > 0,
    "session lands in the client"
  );
  /* the auto-backup PUT is async — wait for it server-side, not just
     client-side (this raced on CI) */
  await waitFor(
    () =>
      Object.values(hs.backedUpKeys.get("ruser") ?? {}).some(
        (rooms) => Object.keys(rooms).length > 0
      ),
    "the session lands IN the backup"
  );

  const other = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await other.init();
  /* no SSSS on this account — the unified restore falls through to the
     direct passphrase route */
  const imported = await other.restoreWithRecovery("grungus-pass-phrase");
  assert.equal(imported, 1);
});
