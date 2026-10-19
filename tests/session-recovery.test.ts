import test from "node:test";
import assert from "node:assert/strict";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { resetSessionBackup } from "../src/renderer/services/session-recovery.ts";
import { E2eeCrypto } from "../src/renderer/services/e2ee.ts";

test("backup reset requires successful same-account password confirmation and cleans up temporary session", async () => {
  const original = MatrixClient.prototype.loginWithPassword;
  const logout = MatrixClient.prototype.logout;
  let deleted = 0, loggedOut = 0;
  const client = new MatrixClient({ baseUrl: "https://example.org", userId: "@alice:example.org", accessToken: "original" });
  client.crypto = { deleteCurrentKeyBackup: async () => { deleted++; } } as unknown as E2eeCrypto;
  try {
    MatrixClient.prototype.logout = async function () { loggedOut++; };
    MatrixClient.prototype.loginWithPassword = async function () { throw new Error("Wrong password"); };
    await assert.rejects(resetSessionBackup(client, "wrong"), /Wrong password/);
    assert.equal(deleted, 0);
    MatrixClient.prototype.loginWithPassword = async function () {
      this.accessToken = "temporary"; this.userId = "@bob:example.org";
      return { access_token: "temporary", user_id: this.userId, device_id: "TEMP" };
    };
    await assert.rejects(resetSessionBackup(client, "password"), /different account/);
    assert.equal(deleted, 0);
    assert.equal(loggedOut, 1);
    MatrixClient.prototype.loginWithPassword = async function () {
      this.accessToken = "temporary"; this.userId = client.userId;
      return { access_token: "temporary", user_id: this.userId!, device_id: "TEMP" };
    };
    await resetSessionBackup(client, "password");
    assert.equal(deleted, 1);
    assert.equal(loggedOut, 2);
    assert.equal(client.accessToken, "original");
    client.crypto.deleteCurrentKeyBackup = async () => { throw new Error("Delete failed"); };
    await assert.rejects(resetSessionBackup(client, "password"), /Delete failed/);
    assert.equal(loggedOut, 3);
  } finally {
    MatrixClient.prototype.loginWithPassword = original;
    MatrixClient.prototype.logout = logout;
  }
});

test("backup reset deletes the exact version and obsolete secret; lookup errors cannot trigger deletion", async () => {
  const calls: { method: string; path: string }[] = [];
  const crypto = new E2eeCrypto({ host: {
    userId: "@alice:example.org",
    api: async (method: string, path: string) => { calls.push({ method, path }); return { version: "v/2" }; },
  } as unknown as MatrixClient });
  await crypto.deleteCurrentKeyBackup();
  assert.deepEqual(calls.map(c => c.method), ["GET", "DELETE", "PUT"]);
  assert.ok(calls[1]!.path.endsWith("v%2F2"));
  assert.ok(calls[2]!.path.endsWith("account_data/m.megolm_backup.v1"));
  calls.length = 0;
  crypto.host.api = async (method, path) => { calls.push({ method, path }); throw new Error("Offline"); };
  await assert.rejects(crypto.deleteCurrentKeyBackup(), /Offline/);
  assert.deepEqual(calls.map(c => c.method), ["GET"]);
});


test("password reset removes the server backup while retaining the active session and permits replacement", async t => {
  const { MockHomeserver } = await import("./mock-homeserver.ts");
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());
  hs.registerUser("reset", "password");
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: "reset", password: "password" });
  const crypto = new E2eeCrypto({ host: client });
  await crypto.init();
  client.crypto = crypto;
  await crypto.createKeyBackup("original backup passphrase");
  await assert.rejects(resetSessionBackup(client, "incorrect"));
  assert.ok(await crypto.getKeyBackupVersion());
  await resetSessionBackup(client, "password");
  assert.equal(await crypto.getKeyBackupVersion(), null);
  await client.whoami();
  await crypto.createKeyBackup("replacement backup passphrase");
  assert.ok(await crypto.getKeyBackupVersion());
});
