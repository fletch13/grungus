/*
 * Grungus — cross-signing against the mock homeserver: bootstrap
 * publishes the key hierarchy (master/self-signing/user-signing with
 * the right signature chain + account data + own-device signature),
 * and the headline property — verify one device, every device that
 * trusts your master key trusts it too (trust propagation).
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
  canonicalJson,
  pubFromKeyInfo,
  type CrossSigningKey,
} from "../src/renderer/services/cross-signing.ts";

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

/** A logged-in device with its crypto layer + cross-signing service. */
async function makeDevice(
  hs: MockHomeserver,
  username: string,
  password: string
): Promise<{
  client: MatrixClient;
  crypto: E2eeCrypto;
  cs: CrossSigning;
  deviceId: string;
}> {
  hs.registerUser(username, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username, password });
  const crypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await crypto.init();
  client.crypto = crypto;
  client.startSync();
  return {
    client,
    crypto,
    cs: new CrossSigning(crypto, client),
    deviceId: client.deviceId!,
  };
}

test("canonical JSON sorts keys recursively and drops whitespace", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: "x", c: null }] }),
    '{"a":[2,{"c":null,"d":"x"}],"b":1}');
  assert.equal(canonicalJson("hi"), '"hi"');
  assert.equal(canonicalJson(3), "3");
  assert.equal(canonicalJson(null), "null");
});

test("bootstrap publishes the key hierarchy and signs our own device", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeDevice(hs, "csuser1", "pw1");
  t.after(() => a.client.stopSync());

  const res = await a.cs.bootstrap();
  assert.ok(res.masterPub.length > 20, "master public key returned");

  /* the three key objects are in the account data (server-side) */
  const acctMaster = hs.accountData.get("csuser1")?.get("com.grungus.cross_signing.master");
  const acctSsk = hs.accountData.get("csuser1")?.get("com.grungus.cross_signing.self_signing");
  const acctUsk = hs.accountData.get("csuser1")?.get("com.grungus.cross_signing.user_signing");
  assert.ok(acctMaster, "master key in account data");
  assert.ok(acctSsk, "self-signing key in account data");
  assert.ok(acctUsk, "user-signing key in account data");

  const master = acctMaster as CrossSigningKey;
  const ssk = acctSsk as CrossSigningKey;
  const usk = acctUsk as CrossSigningKey;
  assert.equal(pubFromKeyInfo(master), res.masterPub);
  assert.deepEqual(master.usage, ["master"]);
  assert.deepEqual(ssk.usage, ["self_signing"]);
  assert.deepEqual(usk.usage, ["user_signing"]);

  /* SSK and USK are signed by the master */
  const userId = a.client.userId!;
  assert.ok(
    ssk.signatures?.[userId]?.[`ed25519:${res.masterPub}`],
    "SSK signed by the master key"
  );
  assert.ok(
    usk.signatures?.[userId]?.[`ed25519:${res.masterPub}`],
    "USK signed by the master key"
  );
  /* the master is signed by the bootstrapping DEVICE (chain entry) */
  assert.ok(
    master.signatures?.[userId]?.[`ed25519:${a.deviceId}`],
    "master signed by the bootstrapping device"
  );

  /* our own device entry carries the SSK signature */
  const raw = await a.crypto.getRawDeviceKeys(userId);
  const own = raw[a.deviceId];
  assert.ok(own, "own device entry exists");
  const sskPub = pubFromKeyInfo(ssk);
  assert.ok(
    own.signatures?.[userId]?.[`ed25519:${sskPub}`],
    "own device signed by the SSK"
  );

  /* the signature chain VERIFIES cryptographically */
  const util = new a.crypto.olmModule!.Utility();
  try {
    util.ed25519_verify(
      res.masterPub,
      canonicalJson({ user_id: ssk.user_id, usage: ssk.usage, keys: ssk.keys }),
      ssk.signatures![userId]![`ed25519:${res.masterPub}`]!
    );
  } finally {
    util.free();
  }

  /* this device holds the private seeds */
  assert.equal(await a.cs.canSign(), true);
  await a.client.stopSync();
});

test("trust propagation: verify one device, all trusting devices follow", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  /* three devices of the same user: A bootstraps, B is A's established
     verified partner, C is a brand-new device */
  const a = await makeDevice(hs, "csuser2", "pw2");
  const b = await makeDevice(hs, "csuser2", "pw2");
  const c = await makeDevice(hs, "csuser2", "pw2");
  t.after(() => {
    a.client.stopSync();
    b.client.stopSync();
    c.client.stopSync();
  });

  const userId = a.client.userId!;

  /* A and B are mutually verified from an earlier SAS/QR session */
  const aEd = await b.crypto.getDeviceEd25519(userId, a.deviceId);
  const bEd = await a.crypto.getDeviceEd25519(userId, b.deviceId);
  assert.ok(aEd && bEd, "device keys published");
  await b.crypto.markDeviceVerified(userId, a.deviceId, aEd);
  await a.crypto.markDeviceVerified(userId, b.deviceId, bEd);

  /* A bootstraps cross-signing (publishes keys + signs its own device) */
  await a.cs.bootstrap();

  /* A verifies the new device C (a completed SAS/QR) and — as the
     signing device — signs C's device key with the SSK */
  const cEd = await a.crypto.getDeviceEd25519(userId, c.deviceId);
  assert.ok(cEd);
  await a.crypto.markDeviceVerified(userId, c.deviceId, cEd);
  const signed = await a.cs.signDevice(c.deviceId);
  assert.equal(signed, true, "A signs C with the self-signing key");

  /* B picks up the account data via sync */
  await waitFor(
    () => b.client.getAccountData("com.grungus.cross_signing.master") !== null,
    5_000,
    "B receives the cross-signing account data"
  );

  /* THE PROPERTY: B never verified C directly, but B trusts A, A
     signed the master key, the master signed the SSK, and the SSK
     signed C — so B trusts C through the chain */
  const bTrustsC = await b.cs.isOwnDeviceTrusted(c.deviceId);
  assert.equal(bTrustsC, true, "B trusts C via the cross-signing chain");

  /* sanity: B still trusts A directly (local verification) */
  assert.equal(await b.cs.isOwnDeviceTrusted(a.deviceId), true);
  /* C's own view: C trusts itself trivially, and C sees the chain too
     (C has no locally-verified devices, so the chain is B-unreachable
     from C's side — C would need its own verification; that is the
     SSSS/propagation story, out of scope here). Unsigned stranger
     devices stay untrusted: */
  const stranger = await makeDevice(hs, "csstranger", "pw3");
  t.after(() => stranger.client.stopSync());
  /* the stranger is a DIFFERENT user entirely — chain check is for own
     devices; a stranger can never pass it */
  const rawStranger = await b.crypto.getRawDeviceKeys(stranger.client.userId!);
  const strangerId = Object.keys(rawStranger)[0];
  assert.ok(strangerId, "stranger device published");
  assert.equal(
    await b.cs.isOwnDeviceTrusted(strangerId),
    false,
    "another user's device never passes the own-device chain"
  );
});

test("an unsigned own device is not trusted via the chain", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeDevice(hs, "csuser3", "pw1");
  const d = await makeDevice(hs, "csuser3", "pw1");
  t.after(() => {
    a.client.stopSync();
    d.client.stopSync();
  });

  const userId = a.client.userId!;
  const aEd = await d.crypto.getDeviceEd25519(userId, a.deviceId);
  assert.ok(aEd, "A's key published");
  await d.crypto.markDeviceVerified(userId, a.deviceId, aEd);

  await a.cs.bootstrap();

  /* D has NOT signed device X (nobody verified it) — the chain must
     reject it. Bootstrap signed A's own device, so use a THIRD device
     that nobody signed. */
  const x = await makeDevice(hs, "csuser3", "pw1");
  t.after(() => x.client.stopSync());

  await waitFor(
    () => d.client.getAccountData("com.grungus.cross_signing.master") !== null,
    5_000,
    "D receives the account data"
  );
  assert.equal(
    await d.cs.isOwnDeviceTrusted(x.deviceId),
    false,
    "an unsigned device stays untrusted"
  );
});
