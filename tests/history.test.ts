import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient, type MessageItem } from "../src/renderer/services/matrix-client.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for history");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const messages = (client: MatrixClient, roomId: string): MessageItem[] =>
  client.getRoom(roomId)!.timeline.filter((item): item is MessageItem => item.kind === "message");

test("history pages backward, deduplicates, preserves current state, and never rings old calls", async t => {
  const hs = new MockHomeserver();
  hs.timelineLimit = 2;
  hs.historyPageLimit = 3;
  await hs.listen();
  t.after(() => hs.close());
  hs.registerUser("history", "pw");
  const sender = new MatrixClient({ baseUrl: hs.baseUrl! });
  await sender.loginWithPassword({ username: "history", password: "pw" });
  const roomId = await sender.createRoom({ name: "history", isPublic: true });
  const firstId = await sender.sendMessage(roomId, "original");
  await sender.sendStateEvent(roomId, "m.room.name", "", { name: "old name" });
  await sender.sendRoomEvent(roomId, "m.call.invite", { call_id: "old-call", offer: { type: "offer", sdp: "old" } });
  for (let index = 0; index < 8; index++) await sender.sendMessage(roomId, `message-${index}`);
  await sender.editMessage(roomId, firstId!, "edited");
  await sender.sendStateEvent(roomId, "m.room.name", "", { name: "current name" });
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: "history", password: "pw" });
  let rings = 0;
  client.onCallEvent = () => { rings++; };
  client.startSync();
  t.after(() => client.stopSync());
  await waitFor(() => !!client.getRoom(roomId));
  const room = client.getRoom(roomId)!;
  assert.ok(room.historyCursor);
  hs.failHistory = true;
  const cursor = room.historyCursor;
  await assert.rejects(() => client.loadOlderMessages(roomId));
  assert.equal(room.historyCursor, cursor);
  assert.equal(room.historyLoading, false);
  hs.failHistory = false;
  for (let pages = 0; room.historyCursor && pages < 20; pages++) await client.loadOlderMessages(roomId);
  assert.equal(room.historyCursor, null);
  assert.deepEqual(messages(client, roomId).map(item => item.body), ["edited", ...Array.from({ length: 8 }, (_, index) => `message-${index}`)]);
  assert.equal(new Set(room.timeline.map(item => item.id)).size, room.timeline.length);
  assert.equal(room.name, "current name");
  assert.equal(rings, 0);
});

test("limited sync replaces disconnected history and automatically starts filling its gap", async t => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());
  hs.registerUser("gap", "pw");
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: "gap", password: "pw" });
  const roomId = await client.createRoom({ name: "gap", isPublic: true });
  await client.sendMessage(roomId, "before-gap");
  client.startSync();
  t.after(() => client.stopSync());
  await waitFor(() => messagesIfReady().includes("before-gap"));
  client.stopSync();
  await new Promise(resolve => setTimeout(resolve, 40));
  for (let index = 0; index < 6; index++) await client.sendMessage(roomId, `gap-${index}`);
  hs.timelineLimit = 2;
  client.startSync();
  await waitFor(() => messagesIfReady().includes("gap-0") && !client.getRoom(roomId)?.historyLoading);
  assert.deepEqual(messages(client, roomId).map(item => item.body), ["before-gap", ...Array.from({ length: 6 }, (_, index) => `gap-${index}`)]);
  function messagesIfReady(): string[] {
    return client.getRoom(roomId) ? messages(client, roomId).map(item => item.body) : [];
  }
});

test("large timelines stay bounded and older windows can return to live messages", async t => {
  const hs = new MockHomeserver();
  hs.timelineLimit = 1100;
  await hs.listen();
  t.after(() => hs.close());
  hs.registerUser("bounded", "pw");
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: "bounded", password: "pw" });
  const roomId = await client.createRoom({ name: "bounded", isPublic: true });
  // Populate server history directly to avoid 1100 HTTP round trips.
  const room = hs.rooms.get(roomId)!;
  const base = room.events.at(-1)!;
  for (let index = 0; index < 1100; index++) room.events.push({ ...base, event_id: `$history${index}`, type: "m.room.message", state_key: undefined, content: { msgtype: "m.text", body: `bounded-${index}` }, seq: base.seq + index + 1 });
  client.startSync();
  t.after(() => client.stopSync());
  await waitFor(() => (client.getRoom(roomId)?.timeline.length ?? 0) >= 1000);
  assert.equal(client.getRoom(roomId)!.timeline.length, 1000);
  while (client.getRoom(roomId)!.atLiveEdge !== false && client.getRoom(roomId)!.historyCursor) await client.loadOlderMessages(roomId);
  assert.equal(client.getRoom(roomId)!.atLiveEdge, false);
  assert.equal(client.getRoom(roomId)!.timeline.length, 1000);
  await client.loadLatestMessages(roomId);
  assert.equal(client.getRoom(roomId)!.atLiveEdge, true);
});

test("opening a room with only reaction events in initial sync automatically hydrates older chat", async t => {
  const hs = new MockHomeserver(); hs.timelineLimit = 1; hs.historyPageLimit = 1; await hs.listen(); t.after(() => hs.close());
  hs.registerUser("initial-history", "pw");
  const writer = new MatrixClient({ baseUrl: hs.baseUrl! }); await writer.loginWithPassword({ username: "initial-history", password: "pw" });
  const roomId = await writer.createRoom({ name: "Quiet space room" }); writer.startSync(); t.after(() => writer.stopSync());
  await waitFor(() => !!writer.getRoom(roomId));
  const id = await writer.sendMessage(roomId, "Message from before startup");
  for (const emoji of ["👍", "🎉", "❤️"]) await writer.sendReaction(roomId, id!, emoji);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! }); await client.loginWithPassword({ username: "initial-history", password: "pw" });
  client.startSync(); t.after(() => client.stopSync()); await waitFor(() => !!client.getRoom(roomId));
  assert.equal(messages(client, roomId).length, 0, "The regression fixture must start without visible messages");
  let requests = 0; const api = client.api.bind(client);
  client.api = (async (method: string, path: string, options: any) => { if (path.endsWith("/messages")) requests++; return api(method, path, options); }) as typeof client.api;
  await Promise.all([client.ensureRoomHistory(roomId), client.ensureRoomHistory(roomId), client.ensureRoomHistory(roomId)]);
  assert.equal(messages(client, roomId)[0]?.body, "Message from before startup");
  assert.equal(requests, 3, "Concurrent selection updates must share one paginated history load");
  assert.ok(messages(client, roomId)[0]?.reactions?.has("❤️"), "Relations received before backfilling must apply to recovered messages");
  await client.ensureRoomHistory(roomId); assert.equal(requests, 3, "Loaded chats must not reload on every selection");
});

test("automatic initial history retries failures and does not repeatedly fetch empty rooms", async t => {
  const hs = new MockHomeserver(); await hs.listen(); t.after(() => hs.close()); hs.registerUser("empty-history", "pw");
  const client = new MatrixClient({ baseUrl: hs.baseUrl! }); await client.loginWithPassword({ username: "empty-history", password: "pw" });
  const id = await client.createRoom({ name: "Empty room" }); client.startSync(); t.after(() => client.stopSync()); await waitFor(() => !!client.getRoom(id));
  hs.failHistory = true;
  await assert.rejects(client.ensureRoomHistory(id)); assert.equal(client.getRoom(id)!.historyLoading, false);
  hs.failHistory = false; await client.ensureRoomHistory(id);
  let requests = 0; const api = client.api.bind(client);
  client.api = (async (method: string, path: string, options: any) => { if (path.endsWith("/messages")) requests++; return api(method, path, options); }) as typeof client.api;
  await client.ensureRoomHistory(id); await client.ensureRoomHistory(id);
  assert.equal(requests, 0, "Successfully checked empty rooms must not trigger an automatic request loop");
});
