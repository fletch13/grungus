/*
 * Grungus — deleting chats.
 *
 *   - deleteRoom leaves on the server and drops the room locally
 *   - the room never resurrects from a later sync (the leave arrives
 *     in rooms.leave; the ignore set holds)
 *   - a leave made on another device arrives via sync and deletes too
 *   - declining an invite never leaves a room behind
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";

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

async function makeClient(hs: MockHomeserver, username: string): Promise<MatrixClient> {
  hs.registerUser(username, "pw");
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username, password: "pw" });
  client.startSync();
  return client;
}

test("deleteRoom leaves the server and the room never comes back", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeClient(hs, "del_a");
  const b = await makeClient(hs, "del_b");
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });

  const roomId = await a.createRoom({ name: "doomed", isPublic: true });
  await b.joinRoom(roomId);
  await waitFor(
    () => a.getRoom(roomId) !== null && b.getRoom(roomId) !== null,
    "both see the room"
  );
  await a.sendMessage(roomId, "message in a doomed room");
  await waitFor(
    () => (b.getRoom(roomId)?.timeline ?? []).some((i) => i.kind === "message"),
    "message lands"
  );

  /* delete on B */
  const deletedIds: string[] = [];
  b.on("room-deleted", (id) => deletedIds.push(id));
  await b.deleteRoom(roomId);

  assert.equal(b.getRoom(roomId) ?? null, null, "gone from getRoom immediately");
  assert.deepEqual(deletedIds, [roomId], "the room-deleted event fired");
  /* the membership really left the server */
  assert.equal(hs.rooms.get(roomId)?.members.get(b.userId ?? ""), "leave");

  /* B keeps syncing — the leave must NOT resurrect the chat */
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(b.getRoom(roomId) ?? null, null, "still gone after a sync cycle");

  /* A still sees the room and its history (only B left) */
  assert.ok(a.getRoom(roomId), "the other member keeps the room");
});

test("a leave from another device arrives via sync and deletes locally", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  /* two devices of the same user */
  hs.registerUser("del_multi", "pw");
  const d1 = new MatrixClient({ baseUrl: hs.baseUrl! });
  await d1.loginWithPassword({ username: "del_multi", password: "pw" });
  d1.startSync();
  const d2 = new MatrixClient({ baseUrl: hs.baseUrl! });
  await d2.loginWithPassword({ username: "del_multi", password: "pw" });
  d2.startSync();
  t.after(() => {
    d1.stopSync();
    d2.stopSync();
  });

  const other = await makeClient(hs, "del_other");
  t.after(() => other.stopSync());
  const roomId = await other.createRoom({ name: "multi-device-doom", isPublic: true });
  await d1.joinRoom(roomId);
  await waitFor(() => d1.getRoom(roomId) !== null && d2.getRoom(roomId) !== null, "both devices see it");

  /* device 1 deletes; device 2 must learn via the rooms.leave sync section */
  await d1.deleteRoom(roomId);
  await waitFor(() => d2.getRoom(roomId) === null, "device 2 drops it via sync");
  assert.equal(d1.getRoom(roomId) ?? null, null);
});

test("declining an invite leaves nothing behind", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeClient(hs, "inv_a");
  const b = await makeClient(hs, "inv_b");
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });

  const roomId = await a.createRoom({ name: "invite-me", isPublic: false });
  await a.invite(roomId, b.userId!);
  await waitFor(() => b.getInvites().some((i) => i.id === roomId), "invite arrives");

  await b.declineInvite(roomId);
  assert.equal(b.getInvites().length, 0, "invite gone");
  assert.equal(b.getRoom(roomId) ?? null, null, "no room shell left behind");
  assert.equal(hs.rooms.get(roomId)?.members.get(b.userId ?? ""), "leave");
});
