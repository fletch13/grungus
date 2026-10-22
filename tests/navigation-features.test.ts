import test from "node:test";
import assert from "node:assert/strict";
import { mentionedUsers } from "../src/renderer/services/mentions.ts";
import { RoomOrder } from "../src/renderer/services/room-order.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { MatrixMessaging } from "../src/renderer/services/matrix-messaging.ts";
import { createRoomRecord } from "../src/renderer/services/matrix-rooms.ts";

test("mentions match complete Matrix identities and ignore partial names and addresses", () => {
  const ids = ["@alex:test", "@alice:test", "@alice:test.org"];
  assert.deepEqual(mentionedUsers("Hi @alice:test.org, (@alex:test)! @alice:test.org", ids), ["@alex:test", "@alice:test.org"]);
  assert.deepEqual(mentionedUsers("mail@alex:test @alex:testing", ids), []);
});

test("mention metadata is sent inside encryption and reply fallback quotes do not ping", async () => {
  const room = createRoomRecord("!r:test"); room.isEncrypted = true;
  room.members.set("@alice:test", { userId: "@alice:test", displayname: "Alice", membership: "join", avatarMxc: null });
  let encrypted: Record<string, unknown> = {}, sent: unknown;
  const messaging = new MatrixMessaging({ userId: "@me:test", getRoom: () => room, encryptionForRoom: () => true,
    crypto: { encryptRoomMessage: async (_room: string, content: Record<string, unknown>) => { encrypted = content; return { ciphertext: "secret" }; } } as never,
    api: async <T>(_method: string, _path: string, options?: { body?: unknown }) => { sent = options?.body; return { event_id: "$ack" } as T; },
    uploadMedia: async () => "", notify: () => {}, notifyRooms: () => {},
  });
  await messaging.sendMessage(room.id, "Hello @alice:test");
  assert.deepEqual(encrypted["m.mentions"], { user_ids: ["@alice:test"] });
  assert.deepEqual(sent, { ciphertext: "secret" });
  await messaging.replyMessage(room.id, "$parent", "@alice:test", "Original", "No mention here");
  assert.deepEqual(encrypted["m.mentions"], { user_ids: [] });
  await messaging.editMessage(room.id, "$parent", "Hi @alice:test");
  assert.deepEqual((encrypted["m.new_content"] as Record<string, unknown>)["m.mentions"], { user_ids: ["@alice:test"] });
});

test("favorites and order persist per account and space and preserve new rooms", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), storage = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
  try {
    const rooms = ["a", "b", "c"].map(id => ({ id }));
    const order = new RoomOrder("@me:test", "!space"); order.toggle("b"); order.move("c", "a", rooms);
    const restored = new RoomOrder("@me:test", "!space");
    assert.deepEqual(restored.favorites, ["b"]); assert.deepEqual(restored.sorted([...rooms, { id: "new" }]).map(room => room.id), ["c", "a", "b", "new"]);
    assert.deepEqual(rooms.map(room => room.id), ["a", "b", "c"]);
    assert.deepEqual(new RoomOrder("@other:test", "!space").favorites, []);
    assert.deepEqual(new RoomOrder("@me:test", "!other").order, []);
    restored.toggle("b"); assert.deepEqual(new RoomOrder("@me:test", "!space").favorites, []);
  } finally { if (original) Object.defineProperty(globalThis, "localStorage", original); else Reflect.deleteProperty(globalThis, "localStorage"); }
});

test("message context decodes chronological surrounding history without replacing the live timeline", async () => {
  const client = new MatrixClient({ baseUrl: "https://example.test" });
  const room = createRoomRecord("!r:test"); client.rooms.set(room.id, room);
  const event = (id: string) => ({ type: "m.room.message", event_id: id, sender: "@alice:test", origin_server_ts: 1000, content: { msgtype: "m.text", body: id } });
  const live = { kind: "message" as const, id: "$live", sender: "@alice:test", senderName: "Alice", ts: 2000, msgtype: "m.text", body: "Live", media: null }; room.timeline.push(live);
  client.api = async <T>(_method: string, path: string) => {
    assert.ok(path.endsWith("/context/%24target"));
    return { events_before: [event("$before2"), event("$before1")], event: event("$target"), events_after: [event("$after")], start: "back", end: "forward" } as T;
  };
  const page = await client.getMessageContext(room.id, "$target");
  assert.deepEqual(page.items.map(item => item.id), ["$before1", "$before2", "$target", "$after"]);
  assert.equal(page.before, "back"); assert.equal(page.after, "forward"); assert.deepEqual(room.timeline, [live]);
  client.api = async <T>() => ({ event: event("$target"), events_after: [
    { ...event("$edit"), content: { msgtype: "m.text", body: "* corrected", "m.new_content": { msgtype: "m.text", body: "corrected" }, "m.relates_to": { rel_type: "m.replace", event_id: "$target" } } },
    { ...event("$vote"), type: "org.matrix.msc3381.poll.response", content: { "m.relates_to": { rel_type: "m.reference", event_id: "$poll" }, "org.matrix.msc3381.poll.response": { answers: ["a"] } } },
  ] }) as T;
  const related = await client.getMessageContext(room.id, "$target");
  assert.equal(related.items.length, 1); assert.equal(related.items[0]?.kind === "message" && related.items[0].body, "corrected");
  client.api = async <T>() => ({ chunk: [event("$older2"), event("$older1")], end: "back" }) as T;
  const older = await client.getContextPage(room.id, "back", "b");
  assert.deepEqual(older.items.map(item => item.id), ["$older1", "$older2"]); assert.equal(older.next, undefined);
});
