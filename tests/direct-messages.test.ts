import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { E2eeCrypto } from "../src/renderer/services/e2ee.ts";

async function waitFor(check: () => boolean): Promise<void> {
  const start = Date.now();
  while (!check()) { if (Date.now() - start > 5000) throw new Error("Timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}

test("user directory searches display names and IDs, excludes self, and supports cancellation", async t => {
  const hs = new MockHomeserver(); await hs.listen(); t.after(() => hs.close());
  hs.registerUser("search_me", "pw"); hs.registerUser("search_friend", "pw");
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: "search_me", password: "pw" });
  assert.deepEqual((await client.searchUsers("search_")).results.map(user => user.user_id), ["@search_friend:mock.hs"]);
  assert.deepEqual(await client.searchUsers(""), { results: [], limited: false });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.searchUsers("friend", controller.signal));
});

test("new DM invites a peer, enables encryption, preserves m.direct, and reuses the conversation", async t => {
  const hs = new MockHomeserver(); await hs.listen(); t.after(() => hs.close());
  hs.registerUser("dm_owner", "pw"); hs.registerUser("dm_friend", "pw");
  const a = new MatrixClient({ baseUrl: hs.baseUrl! });
  const b = new MatrixClient({ baseUrl: hs.baseUrl! });
  await a.loginWithPassword({ username: "dm_owner", password: "pw" });
  await b.loginWithPassword({ username: "dm_friend", password: "pw" });
  a.crypto = new E2eeCrypto({ host: a }); await a.crypto.init();
  b.crypto = new E2eeCrypto({ host: b }); await b.crypto.init();
  await a.setAccountData("m.direct", { "@other:mock.hs": ["!existing:mock.hs"] });
  const [roomId, same] = await Promise.all([a.startDirectMessage(b.userId!), a.startDirectMessage(b.userId!)]);
  assert.equal(roomId, same, "Concurrent starts must only create one room");
  assert.equal(hs.rooms.size, 1);
  assert.equal(hs.rooms.get(roomId)!.members.get(b.userId!), "invite");
  assert.ok(hs.rooms.get(roomId)!.events.some(event => event.type === "m.room.member" && event.state_key === b.userId && event.content.is_direct === true));
  assert.ok(hs.rooms.get(roomId)!.events.some(event => event.type === "m.room.encryption"));
  assert.deepEqual(a.getAccountData("m.direct")?.["@other:mock.hs"], ["!existing:mock.hs"]);
  assert.deepEqual(a.getAccountData("m.direct")?.[b.userId!], [roomId]);
  assert.equal(await a.startDirectMessage(b.userId!), roomId, "Reuse must also work before initial sync");
  a.startSync(); b.startSync(); t.after(() => { a.stopSync(); b.stopSync(); });
  await waitFor(() => a.getRoom(roomId)?.isDirect === true && b.getInvites().length === 1);
  assert.equal(a.getRoom(roomId)?.directUserId, b.userId);
  assert.notEqual(a.getRoom(roomId)?.title, "Empty room");
  await a.sendMessage(roomId, "hello before acceptance");
  await b.acceptInvite(roomId);
  await waitFor(() => a.getRoom(roomId)?.members.get(b.userId!)?.membership === "join" && b.getRoom(roomId)?.isEncrypted === true);
  await waitFor(() => b.getRoom(roomId)?.timeline.some(item => item.kind === "message" && item.body === "hello before acceptance") === true);
  await a.sendMessage(roomId, "private hello");
  await waitFor(() => b.getRoom(roomId)?.timeline.some(item => item.kind === "message" && item.body === "private hello") === true);
  assert.ok(hs.rooms.get(roomId)!.events.some(event => event.type === "m.room.encrypted"));
  assert.equal(await a.startDirectMessage(b.userId!), roomId);
  await assert.rejects(a.startDirectMessage(a.userId!), /another user/);
  await assert.rejects(a.startDirectMessage("not-a-matrix-id"), /full Matrix ID/);
});
