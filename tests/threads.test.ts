import test from "node:test";
import assert from "node:assert/strict";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { E2eeCrypto } from "../src/renderer/services/e2ee.ts";
import { MockHomeserver } from "./mock-homeserver.ts";
import { canChangeState } from "../src/renderer/services/room-permissions.ts";
async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Sync timed out"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
for (const encrypted of [false, true]) test(`Matrix threads preserve relations, paginate, and ${encrypted ? "encrypt bodies" : "send normal replies"}`, async t => {
  const hs = new MockHomeserver(); await hs.listen(); t.after(() => hs.close());
  hs.registerUser("threads", "pw"); const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: "threads", password: "pw" });
  if (encrypted) { client.crypto = new E2eeCrypto({ host: client }); await client.crypto.init(); }
  client.startSync(); t.after(() => client.stopSync());
  const id = await client.createRoom({ name: "Threads", encrypted }); await waitFor(() => !!client.getRoom(id));
  const rootId = (await client.sendMessage(id, "Root message"))!;
  await waitFor(() => client.getRoom(id)!.timeline.some(item => item.id === rootId));
  const replyId = await client.sendThreadReply(id, rootId, "First reply");
  await client.sendThreadReply(id, rootId, "Second reply", replyId!);
  await waitFor(() => client.getRoom(id)!.timeline.some(item => item.kind === "message" && item.body === "Second reply"));
  hs.historyPageLimit = 1;
  const roots = await client.getThreads(id);
  assert.equal(roots.items[0]?.id, rootId); assert.equal(roots.items[0]?.body, "Root message"); assert.equal(roots.items[0]?.threadReplyCount, 2);
  const page = await client.getThreadReplies(id, rootId);
  assert.equal(page.items[0]?.threadRootId, rootId); assert.equal(page.items[0]?.body, "First reply"); assert.ok(page.next);
  assert.equal((await client.getThreadReplies(id, rootId, page.next)).items[0]?.body, "Second reply");
  const sent = hs.rooms.get(id)!.events.find(event => event.event_id === replyId)!;
  assert.equal(sent.type, encrypted ? "m.room.encrypted" : "m.room.message");
  assert.equal((sent.content["m.relates_to"] as { event_id: string }).event_id, rootId);
  if (encrypted) assert.equal(sent.content.body, undefined, "Thread indexing must not expose encrypted message text");
  assert.equal((await client.getThreadRoot(id, rootId))?.body, "Root message");
  await assert.rejects(client.sendThreadReply(id, rootId, " "), /Enter a thread reply/);
});
test("room state permissions respect specific events, defaults, and creator fallback", () => {
  assert.equal(canChangeState({}, "@owner:hs", "@owner:hs", "m.room.name"), true);
  assert.equal(canChangeState({}, "@member:hs", "@owner:hs", "m.room.name"), false);
  assert.equal(canChangeState({ users: { "@mod:hs": 50 }, events: { "m.room.encryption": 100 } }, "@mod:hs", null, "m.room.encryption"), false);
  assert.equal(canChangeState({ state_default: 0 }, "@member:hs", null, "m.room.topic"), true);
});
