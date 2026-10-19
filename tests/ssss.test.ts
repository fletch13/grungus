/*
 * Grungus — SSSS secret storage + the Element QR mode flow against
 * the mock homeserver:
 *   - storage key creation from a recovery passphrase, secret
 *     encrypt/decrypt round-trip, wrong-passphrase rejection
 *   - bootstrap with a recovery passphrase parks the private seeds as
 *     ENCRYPTED SSSS secrets (spec m.cross_signing.* account data)
 *   - a fresh device recovers the seeds with the passphrase alone
 *   - secret SHARING: a verified new device requests the seeds from
 *     the bootstrapping device (m.secret.request / m.secret.send over
 *     olm) and becomes a signer — the Element "verify + get keys" flow
 *   - Element QR mode 0x02: the new device shows its code, the OLD
 *     device scans, and the SSK signature propagates trust to a third
 *     device that never saw the new one
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
  CrossSigning,
  CS_MASTER,
  CS_SELF_SIGNING,
  CS_USER_SIGNING,
} from "../src/renderer/services/cross-signing.ts";
import {
  SecretStorage,
  encryptSecret,
  decryptSecret,
} from "../src/renderer/services/ssss.ts";
import {
  buildQrPayload,
  QR_MODE_VERIFY_SELF_UNTRUSTED,
} from "../src/renderer/services/qr-verify.ts";
import { VerificationManager } from "../src/renderer/services/sas.ts";

function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  label = "condition"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      void (async () => {
        let ok = false;
        try {
          ok = await predicate();
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
      })();
    };
    poll();
  });
}

async function makeDevice(
  hs: MockHomeserver,
  username: string,
  password: string
): Promise<{
  client: MatrixClient;
  crypto: E2eeCrypto;
  cs: CrossSigning;
  manager: VerificationManager;
}> {
  hs.registerUser(username, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username, password });
  const crypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await crypto.init();
  client.crypto = crypto;
  client.startSync();
  const cs = new CrossSigning(crypto, client);
  const manager = new VerificationManager(crypto);
  manager.crossSigning = cs;
  crypto.addPayloadListener((sender, type, content) => {
    /* SSSS secret sharing */
    if (type === "m.secret.request") {
      const req = content as { name?: string; device_id?: string; request_id?: string };
      if (req.name && req.device_id && req.request_id) {
        void cs.handleSecretRequest(sender, req.device_id, req.request_id, req.name);
      }
      return;
    }
    if (type === "m.secret.send") {
      const send = content as { request_id?: string; secret?: string };
      if (send.request_id && send.secret) {
        void cs.handleSecretSend(send.request_id, send.secret);
      }
      return;
    }
    manager.handlePayload(sender, type, content);
  });
  return { client, crypto, cs, manager };
}

/* ------------------------------- SSSS core ------------------------------ */

test("SSSS: key from passphrase, secret round-trip, wrong passphrase rejected", async () => {
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  /* encrypt/decrypt round-trip through the exact js-sdk envelope */
  const payload = await encryptSecret("the-seed-bytes-as-b64", key, "m.cross_signing.master");
  assert.ok(payload.iv && payload.ciphertext && payload.mac);
  const back = await decryptSecret(payload, key, "m.cross_signing.master");
  assert.equal(back, "the-seed-bytes-as-b64");
  /* tampering breaks the MAC */
  const bad = { ...payload, ciphertext: payload.ciphertext.slice(0, -2) + "A=" };
  await assert.rejects(() => decryptSecret(bad, key, "m.cross_signing.master"), /bad MAC/);
  /* a different key fails too */
  const other = new Uint8Array(32);
  crypto.getRandomValues(other);
  await assert.rejects(() => decryptSecret(payload, other, "m.cross_signing.master"), /bad MAC/);
});

test("SSSS: full storage round-trip through the mock homeserver", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  hs.registerUser("sss1", "pw");
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: "sss1", password: "pw" });
  client.startSync();
  t.after(() => client.stopSync());

  const ssss = new SecretStorage(client);
  const keyId = await ssss.createKey("my recovery passphrase");
  assert.ok(keyId.length >= 32, "key id generated");
  await ssss.storeSecret(CS_MASTER, "SEEDMASTER");

  /* the account data holds an encrypted envelope, not the plaintext */
  const acct = hs.accountData.get("sss1")?.get(CS_MASTER) as
    | { encrypted?: Record<string, { iv: string; ciphertext: string; mac: string }> }
    | undefined;
  assert.ok(acct?.encrypted?.[keyId], "secret stored under the key id");
  assert.notEqual(acct!.encrypted![keyId]!.ciphertext, "SEEDMASTER", "ciphertext is not plaintext");
  /* the key description + default key pointer are published */
  const keyDesc = hs.accountData.get("sss1")?.get(`m.secret_storage.key.${keyId}`);
  assert.equal((keyDesc as { algorithm?: string }).algorithm, "m.secret_storage.v1.aes-hmac-sha2");
  const defaultKey = hs.accountData.get("sss1")?.get("m.secret_storage.default_key");
  assert.equal((defaultKey as { key?: string }).key, keyId);

  /* a FRESH instance recovers with the passphrase (wrong one rejected) */
  const ssss2 = new SecretStorage(client);
  assert.equal(await ssss2.deriveFromPassphrase("wrong passphrase"), null);
  assert.equal(await ssss2.deriveFromPassphrase("my recovery passphrase"), keyId);
  assert.equal(await ssss2.getSecret(CS_MASTER), "SEEDMASTER");
});

/* --------------------------- integration flows --------------------------- */

test("bootstrap with recovery passphrase stores encrypted seeds; fresh device recovers", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeDevice(hs, "sss2", "pw");
  t.after(() => a.client.stopSync());

  const res = await a.cs.bootstrap(undefined, "recovery-pass-123");
  assert.ok(res.ssssKeyId, "SSSS key created at bootstrap");
  assert.equal(await a.cs.canSign(), true);

  /* the seeds are in SSSS (encrypted), not plaintext account data */
  const masterSecret = hs.accountData.get("sss2")?.get(CS_MASTER) as
    | { encrypted?: Record<string, unknown> }
    | undefined;
  assert.ok(masterSecret?.encrypted, "m.cross_signing.master is an encrypted envelope");

  /* a fresh device of the same user recovers with the passphrase */
  const c = await makeDevice(hs, "sss2", "pw");
  t.after(() => c.client.stopSync());
  await waitFor(
    () => c.client.getAccountData("com.grungus.cross_signing.master") !== null,
    5_000,
    "C syncs the public keys"
  );
  assert.equal(await c.cs.canSign(), false, "C cannot sign before recovery");
  const ok = await c.cs.recoverWithPassphrase("recovery-pass-123");
  assert.equal(ok, true, "recovery succeeds with the right passphrase");
  assert.equal(await c.cs.canSign(), true, "C can sign after recovery");
  const bad = await c.cs.recoverWithPassphrase("wrong");
  assert.equal(bad, false, "wrong passphrase rejected");
});

test("secret sharing: verified new device requests seeds over olm and signs", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeDevice(hs, "sss3", "pw");
  const c = await makeDevice(hs, "sss3", "pw");
  t.after(() => {
    a.client.stopSync();
    c.client.stopSync();
  });
  const userId = a.client.userId!;

  await a.cs.bootstrap(undefined, "recovery-x");

  /* a completed verification between A and C (local trust marks) */
  const aEd = await c.crypto.getDeviceEd25519(userId, a.crypto.deviceId);
  const cEd = await a.crypto.getDeviceEd25519(userId, c.crypto.deviceId);
  assert.ok(aEd && cEd);
  await c.crypto.markDeviceVerified(userId, a.crypto.deviceId, aEd);
  await a.crypto.markDeviceVerified(userId, c.crypto.deviceId, cEd);

  /* C asks A for the cross-signing seeds */
  assert.equal(await c.cs.canSign(), false, "C cannot sign yet");
  await c.cs.requestCrossSigningKeys(userId, a.crypto.deviceId);

  await waitFor(
    async () => await c.cs.canSign(),
    5_000,
    "C receives the seeds over m.secret.send"
  );

  /* C can now sign a device — prove it end-to-end */
  const signed = await c.cs.signDevice(a.crypto.deviceId);
  assert.equal(signed, true, "C signs A's device with the recovered SSK");
});

test("Element QR mode 0x02: old device scans new device's code, trust propagates", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  /* A = bootstrapping old device, B = established second device,
     C = brand-new device that shows a mode-0x02 QR */
  const a = await makeDevice(hs, "sss4", "pw");
  const b = await makeDevice(hs, "sss4", "pw");
  const c = await makeDevice(hs, "sss4", "pw");
  t.after(() => {
    a.client.stopSync();
    b.client.stopSync();
    c.client.stopSync();
  });
  const userId = a.client.userId!;

  /* A bootstraps; A and B are mutually verified from earlier */
  await a.cs.bootstrap(undefined, "recovery-y");
  const aEd = await b.crypto.getDeviceEd25519(userId, a.crypto.deviceId);
  const bEd = await a.crypto.getDeviceEd25519(userId, b.crypto.deviceId);
  assert.ok(aEd && bEd);
  await b.crypto.markDeviceVerified(userId, a.crypto.deviceId, aEd);
  await a.crypto.markDeviceVerified(userId, b.crypto.deviceId, bEd);

  /* C syncs the public cross-signing keys (mode 0x02 needs the MSK) */
  await waitFor(
    () => c.client.getAccountData("com.grungus.cross_signing.master") !== null,
    5_000,
    "C syncs the public keys"
  );

  /* start a verification request C -> A, then C shows its QR.
     C cannot sign (no seeds) -> mode 0x02: C's device key + the MSK */
  const txnC = c.manager.start(userId, a.crypto.deviceId);
  await waitFor(
    () => a.manager.transactions.some((txn) => txn.transactionId === txnC.transactionId),
    5_000,
    "A receives the request"
  );
  const qrC = c.manager.asQr(txnC.transactionId)!;
  const payload = await qrC.showQrCode();
  /* the payload must be mode 0x02 */
  assert.equal(payload[7], QR_MODE_VERIFY_SELF_UNTRUSTED, "C shows mode 0x02 (Element format)");

  /* A scans: validates C's device key + the MSK claim, sends reciprocate */
  const qrA = a.manager.asQr(txnC.transactionId)!;
  await qrA.scanQrCode(payload);

  /* C confirms the scan */
  await waitFor(() => qrC.phase === "confirm-scan", 5_000, "C sees the scan");
  await qrC.confirmScanned();

  await waitFor(() => qrA.phase === "verified", 5_000, "A verifies");
  await waitFor(() => qrC.phase === "verified", 5_000, "C verifies");

  /* A signed C's device with the SSK (the mode-0x02 propagation) */
  const raw = await a.crypto.getRawDeviceKeys(userId);
  const ssk = hs.accountData.get("sss4")?.get("com.grungus.cross_signing.self_signing") as
    | { keys?: Record<string, string> }
    | undefined;
  const sskPub = Object.values(ssk?.keys ?? {})[0];
  assert.ok(sskPub, "SSK public key known");
  const cSigs = raw[c.crypto.deviceId]?.signatures?.[userId] ?? {};
  assert.ok(
    cSigs[`ed25519:${sskPub}`],
    "A signed C's device key with the SSK"
  );

  /* B (which never verified C directly) receives the account data and
     trusts C through the chain: device -> MSK -> SSK -> C */
  await waitFor(
    () => b.client.getAccountData("com.grungus.cross_signing.master") !== null,
    5_000,
    "B has the public keys"
  );
  const bTrustsC = await b.cs.isOwnDeviceTrusted(c.crypto.deviceId);
  assert.equal(bTrustsC, true, "B trusts C via the cross-signing chain");
});

test("Element recovery key recovers standard cross-signing keys before sync and self-signs the new device", async t => {
  const { encodeRecoveryKey } = await import("../src/renderer/services/ssss.ts");
  const { recoverSession } = await import("../src/renderer/services/session-recovery.ts");
  const hs = new MockHomeserver();
  await hs.listen(); t.after(() => hs.close());
  const old = await makeDevice(hs, "element_recovery", "pw");
  t.after(() => old.client.stopSync());
  await old.cs.bootstrap(undefined, "existing recovery passphrase");
  const storage = new SecretStorage(old.client);
  const raw = await storage.debugKeyBytes("existing recovery passphrase");
  assert.ok(raw);
  const recoveryKey = encodeRecoveryKey(raw);
  // Element publishes public keys through /keys/query, without Grungus's custom account data.
  const data = hs.accountData.get("element_recovery")!;
  for (const name of [...data.keys()]) if (name.startsWith("com.grungus.cross_signing.")) data.delete(name);
  const fresh = new MatrixClient({ baseUrl: hs.baseUrl! });
  await fresh.loginWithPassword({ username: "element_recovery", password: "pw" });
  const crypto = new E2eeCrypto({ host: fresh, store: new MemoryCryptoStore() });
  await crypto.init(); fresh.crypto = crypto;
  assert.equal(fresh.getAccountData("m.secret_storage.default_key"), null, "Initial sync has not happened");
  // No history backup exists: identity verification must still succeed independently.
  const result = await recoverSession(fresh, recoveryKey);
  assert.equal(result.verified, true);
  assert.equal(result.restored, null);
  const ssk = hs.crossSigning.get("element_recovery")!.self_signing as { keys: Record<string, string> };
  const sskPub = Object.values(ssk.keys)[0]!;
  const published = await crypto.getRawDeviceKeys(fresh.userId!);
  assert.ok(published[fresh.deviceId!]?.signatures?.[fresh.userId!]?.[`ed25519:${sskPub}`], "Recovered identity must sign the current device");
  const cs = new CrossSigning(crypto, fresh);
  assert.equal(await cs.recoverWithRecovery(encodeRecoveryKey(new Uint8Array(32))), false, "Wrong recovery key cannot verify the device");
  const badStorage = new SecretStorage(old.client);
  assert.ok(await badStorage.deriveFromRecoveryKey(recoveryKey));
  await badStorage.storeSecret(CS_SELF_SIGNING, btoa(String.fromCharCode(...new Uint8Array(32))));
  await assert.rejects(new CrossSigning(crypto, fresh).recoverWithRecovery(recoveryKey), /do not match/, "Recovery must reject private seeds that do not match the server identity");
});
