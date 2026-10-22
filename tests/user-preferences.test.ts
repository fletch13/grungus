import test from "node:test";
import assert from "node:assert/strict";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { MockHomeserver } from "./mock-homeserver.ts";

test("nicknames and blocking persist per account, preserve other entries and support reset", async t => {
  const hs = new MockHomeserver(); await hs.listen(); t.after(() => hs.close());
  hs.registerUser("preferences", "pw");
  const a = new MatrixClient({ baseUrl: hs.baseUrl! }); await a.loginWithPassword({ username: "preferences", password: "pw" });
  await Promise.all([a.setUserNickname("@friend:mock.hs", " Buddy "), a.setUserNickname("@other:mock.hs", "Colleague")]);
  assert.equal(a.getUserNickname("@friend:mock.hs"), "Buddy");
  assert.equal(a.getUserNickname("@other:mock.hs"), "Colleague");
  await Promise.all([a.ignoreUser("@friend:mock.hs"), a.ignoreUser("@other:mock.hs")]);
  assert.deepEqual(a.getIgnoredUsers().sort(), ["@friend:mock.hs", "@other:mock.hs"]);
  const b = new MatrixClient({ baseUrl: hs.baseUrl! }); await b.loginWithPassword({ username: "preferences", password: "pw" });
  b.startSync(); t.after(() => b.stopSync());
  const deadline = Date.now() + 5000;
  while (!b.getUserNickname("@friend:mock.hs")) { if (Date.now() > deadline) throw new Error("Account data did not sync"); await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(b.getUserNickname("@friend:mock.hs"), "Buddy"); assert.ok(b.getIgnoredUsers().includes("@friend:mock.hs"));
  await a.unignoreUser("@friend:mock.hs"); await a.setUserNickname("@friend:mock.hs", "");
  assert.equal(a.getUserNickname("@friend:mock.hs"), null); assert.equal(a.getUserNickname("@other:mock.hs"), "Colleague");
  assert.deepEqual(a.getIgnoredUsers(), ["@other:mock.hs"]);
  await assert.rejects(a.ignoreUser(a.userId!), /another Matrix user/);
  await assert.rejects(a.setUserNickname("invalid", "Name"), /Invalid Matrix/);
});

test("failed preference reads cannot overwrite server data", async () => {
  const client = new MatrixClient({ baseUrl: "https://test", userId: "@me:test" });
  let writes = 0;
  client.api = (async (method: string) => { if (method === "PUT") writes++; throw new Error("Network unavailable"); }) as typeof client.api;
  await assert.rejects(client.ignoreUser("@friend:test"), /Network unavailable/);
  assert.equal(writes, 0); assert.deepEqual(client.getIgnoredUsers(), []);
});
