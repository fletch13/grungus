/*
 * Grungus — settings against the mock homeserver:
 *   - the SettingsStore round-trips through localStorage, survives a
 *     reload, clamps the font scale, and notifies subscribers
 *   - profile settings PUT the display name / avatar and read them back
 *   - the device list reads; renaming a device sticks
 *   - logging out another device goes through the UIA password flow
 *     (401 challenge -> retry with the password) and the device is gone
 *   - changing the account password goes through the same UIA flow and
 *     the NEW password works for the next login
 *   - the ignored-users list round-trips through m.ignored_user_list
 *     account data and unignore rewrites it
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import {
  SettingsStore,
  DEFAULT_SETTINGS,
} from "../src/renderer/services/settings.ts";

/*
 * SettingsStore persists through the browser's localStorage; Node only
 * exposes it with --localstorage-file, so give the tests an in-memory
 * Storage before any store is constructed.
 */
if (typeof localStorage === "undefined" || localStorage === null) {
  const backing = new Map<string, string>();
  const storage: Storage = {
    get length(): number {
      return backing.size;
    },
    clear(): void {
      backing.clear();
    },
    getItem(key: string): string | null {
      return backing.get(key) ?? null;
    },
    key(index: number): string | null {
      return [...backing.keys()][index] ?? null;
    },
    removeItem(key: string): void {
      backing.delete(key);
    },
    setItem(key: string, value: string): void {
      backing.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
    writable: true,
  });
}

function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  label = "condition"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      Promise.resolve(predicate())
        .then((ok) => {
          if (ok) resolve();
          else if (Date.now() - start > timeoutMs) {
            reject(new Error(`Timed out waiting for: ${label}`));
          } else setTimeout(poll, 25);
        })
        .catch(reject);
    };
    poll();
  });
}

async function makeClient(
  hs: MockHomeserver,
  username: string,
  password: string
): Promise<MatrixClient> {
  hs.registerUser(username, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username, password });
  client.startSync();
  return client;
}

test("SettingsStore: defaults, persistence, clamping, subscriptions", () => {
  localStorage.clear();
  const store = new SettingsStore();

  assert.equal(store.get("theme"), DEFAULT_SETTINGS.theme);
  assert.equal(store.get("sendReadReceipts"), true);

  let notified = 0;
  const unsubscribe = store.subscribe(() => {
    notified += 1;
  });

  store.set("theme", "light");
  assert.equal(notified, 1);
  assert.equal(store.get("theme"), "light");

  /* same value -> no redundant notification */
  store.set("theme", "light");
  assert.equal(notified, 1);

  /* font scale is clamped into the readable range */
  store.set("fontScale", 9);
  assert.equal(store.get("fontScale"), 1.4);
  store.set("fontScale", 0.1);
  assert.equal(store.get("fontScale"), 0.8);

  /* persistence: a second store sees the saved values */
  const reopened = new SettingsStore();
  assert.equal(reopened.get("theme"), "light");
  assert.equal(reopened.get("fontScale"), 0.8);

  /* junk in localStorage falls back to defaults without throwing */
  localStorage.setItem("grungus-settings", "{not json");
  assert.equal(new SettingsStore().get("theme"), "dark");

  /* theme + two clamped font-scale sets all notified */
  assert.equal(notified, 3);
  const beforeUnsubscribe = notified;
  unsubscribe();
  store.set("compact", true);
  assert.equal(notified, beforeUnsubscribe);
});

test("profile settings: display name and avatar PUT and read back", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeClient(hs, "spa", "pw1");
  t.after(() => a.stopSync());

  await a.setDisplayName("Settings Test User");
  await a.setAvatarUrl("mxc://mock.hs/abc123");

  const profile = await a.getProfile(a.userId!);
  assert.equal(profile.displayname, "Settings Test User");
  assert.equal(profile.avatar_url, "mxc://mock.hs/abc123");
});

test("sessions: list devices, rename this device, log out another device via UIA", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeClient(hs, "sda", "pw1");
  const other = await makeClient(hs, "sda", "pw1"); /* second device, same account */
  t.after(() => {
    a.stopSync();
    other.stopSync();
  });

  /* both devices appear in the list */
  await waitFor(() => a.getDevices().then((d) => d.length >= 2), 5_000, "two devices listed");
  const devices = await a.getDevices();
  assert.equal(devices.length, 2);

  /* renaming the current device sticks */
  await a.setDeviceName(a.deviceId!, "Grungus on the test box");
  const renamed = (await a.getDevices()).find((d) => d.deviceId === a.deviceId);
  assert.equal(renamed?.displayName, "Grungus on the test box");

  /* logging out the OTHER device goes through the UIA password flow */
  await a.deleteDevices([other.deviceId!], "pw1");
  const after = await a.getDevices();
  assert.equal(after.length, 1);
  assert.equal(after[0]!.deviceId, a.deviceId);
});

test("account: change the password through the UIA flow, new password logs in", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeClient(hs, "sca", "old-pw");
  t.after(() => a.stopSync());

  await a.changePassword("old-pw", "new-pw-42", false);

  /* the OLD password no longer works, the NEW one does */
  await assert.rejects(() => {
    const probe = new MatrixClient({ baseUrl: hs.baseUrl! });
    return probe.loginWithPassword({ username: "sca", password: "old-pw" });
  });
  const relogin = new MatrixClient({ baseUrl: hs.baseUrl! });
  await relogin.loginWithPassword({ username: "sca", password: "new-pw-42" });
  relogin.stopSync();
});

test("ignored users: unignore rewrites m.ignored_user_list", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeClient(hs, "sia", "pw1");
  t.after(() => a.stopSync());

  await a.setAccountData("m.ignored_user_list", {
    ignored_users: {
      "@spam:mock.hs": {},
      "@noise:mock.hs": {},
    },
  });
  /* account data arrives via sync — wait for the local mirror */
  await waitFor(() => a.getIgnoredUsers().length === 2, 5_000, "ignored list synced");
  assert.deepEqual([...a.getIgnoredUsers()].sort(), ["@noise:mock.hs", "@spam:mock.hs"]);

  await a.unignoreUser("@spam:mock.hs");
  const remaining = a.getIgnoredUsers();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0], "@noise:mock.hs");
});


test("custom backgrounds persist, reject unsafe values, and retain the prior setting on storage failure", t => {
  localStorage.clear();
  const store = new SettingsStore();
  const image = "data:image/jpeg;base64,YWJjZA==";
  store.set("backgroundImage", image);
  assert.equal(new SettingsStore().get("backgroundImage"), image);
  assert.throws(() => store.set("backgroundImage", "https://example.org/background.jpg"), /valid background/);
  assert.throws(() => store.set("backgroundImage", "data:image/svg+xml;base64,YWJj"), /valid background/);
  const original = localStorage.setItem;
  t.after(() => { localStorage.setItem = original; localStorage.clear(); });
  localStorage.setItem = () => { throw new Error("Storage full"); };
  let notified = false; store.subscribe(() => { notified = true; });
  assert.throws(() => store.set("backgroundImage", ""), /Storage full/);
  assert.equal(store.get("backgroundImage"), image);
  assert.equal(notified, false);
});
