import test from "node:test";
import assert from "node:assert/strict";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { createRoomRecord } from "../src/renderer/services/matrix-rooms.ts";
import { E2eeCrypto } from "../src/renderer/services/e2ee.ts";
import { RoomFeatures, parsePoll, tallyPoll, searchLoaded } from "../src/renderer/services/room-features.ts";
import type { MessageItem } from "../src/renderer/services/matrix-types.ts";
import { MockHomeserver } from "./mock-homeserver.ts";
async function waitFor(check: () => boolean): Promise<void> { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw new Error("Sync timed out"); await new Promise(resolve => setTimeout(resolve, 20)); } }
async function relationsReady(client: MatrixClient, roomId: string, id: string): Promise<MessageItem[]> {
  const end = Date.now() + 5000;
  for (;;) { try { return await client.features.pollRelations(roomId, id); } catch (error) { if (Date.now() > end || !(error instanceof Error) || !error.message.includes("decrypted")) throw error; await new Promise(resolve => setTimeout(resolve, 20)); } }
}
for (const encrypted of [false, true]) test(`polls create, vote, paginate and end in ${encrypted ? "encrypted" : "plain"} rooms`, async t => {
  const hs = new MockHomeserver(); await hs.listen(); t.after(() => hs.close());
  hs.registerUser("poll-owner", "pw"); hs.registerUser("poll-voter", "pw");
  const a = new MatrixClient({ baseUrl: hs.baseUrl! }), b = new MatrixClient({ baseUrl: hs.baseUrl! });
  await a.loginWithPassword({ username: "poll-owner", password: "pw" }); await b.loginWithPassword({ username: "poll-voter", password: "pw" });
  if (encrypted) for (const client of [a, b]) { client.crypto = new E2eeCrypto({ host: client }); await client.crypto.init(); }
  const roomId = await a.createRoom({ name: "Poll room", isPublic: true, encrypted }); await b.joinRoom(roomId);
  a.startSync(); b.startSync(); t.after(() => { a.stopSync(); b.stopSync(); });
  await waitFor(() => !!a.getRoom(roomId) && !!b.getRoom(roomId));
  const id = await a.features.createPoll(roomId, "Tonight?", ["Game", "Film"], false);
  await waitFor(() => b.getRoom(roomId)!.timeline.some(item => item.kind === "message" && item.id === id && !!item.pollEvent));
  const root = b.getRoom(roomId)!.timeline.find(item => item.kind === "message" && item.id === id) as MessageItem;
  assert.equal(parsePoll(root.pollEvent!.content)?.question, "Tonight?");
  await b.features.vote(roomId, root, ["answer-0"]); await relationsReady(a, roomId, id!); await a.features.vote(roomId, root, ["answer-1"]);
  await waitFor(() => a.features.cachedPollRelations(roomId, id!).some(event => event.sender === b.userId));
  const originalApi = a.api.bind(a);
  a.api = (async (method: string, path: string, options: any) => path.includes("/relations/") ? { chunk: [] } : originalApi(method, path, options)) as typeof a.api;
  const syncedTally = tallyPoll(root, await a.features.pollRelations(roomId, id!));
  assert.equal(syncedTally.counts.get("answer-0"), 1, "Remote sync votes must remain visible when the relation endpoint lags");
  assert.equal(syncedTally.counts.get("answer-1"), 1, "Acknowledged local votes must remain visible when the relation endpoint lags");
  a.api = originalApi;
  hs.historyPageLimit = 1;
  const tally = tallyPoll(root, await relationsReady(a, roomId, id!));
  assert.equal(tally.counts.get("answer-0"), 1); assert.equal(tally.counts.get("answer-1"), 1);
  await assert.rejects(b.features.endPoll(roomId, root), /creator/);
  await a.features.endPoll(roomId, root);
  assert.equal(tallyPoll(root, await relationsReady(b, roomId, id!)).ended, true);
  await assert.rejects(b.features.vote(roomId, root, ["answer-0"]), /ended/);
  const sent = hs.rooms.get(roomId)!.events.find(event => event.event_id === id)!;
  assert.equal(sent.type, encrypted ? "m.room.encrypted" : "org.matrix.msc3381.poll.start");
  if (encrypted) assert.equal(sent.content["org.matrix.msc3381.poll.start"], undefined, "Poll contents must never appear outside ciphertext");
  await a.features.pin(a.getRoom(roomId)!, id!, true);
  assert.deepEqual(await a.features.pins(roomId), [id]);
  await a.features.pin(a.getRoom(roomId)!, id!, false);
  assert.deepEqual(await a.features.pins(roomId), []);
  await a.features.setNotificationMode(roomId, "mute");
  assert.equal(a.features.shouldNotify(a.getRoom(roomId)!, b.userId!, "hello"), false);
  await b.loadLatestMessages(roomId);
  assert.ok(!b.getRoom(roomId)!.timeline.some(item => item.kind === "message" && /poll.response$/.test(item.msgtype)), "Responses must not clutter the timeline");
});

test("pin and role writes preserve existing state and recheck permissions", async () => {
  const room = createRoomRecord("!room:test"); room.creator = "@me:test";
  let power = { users: { "@me:test": 100, "@peer:test": 0 }, events: { "m.room.name": 75 }, ban: 90 };
  let pinned = ["$old"]; const writes: any[] = [];
  const client = { userId: "@me:test", getRoomPowerLevels: async () => power,
    api: async () => ({ pinned }), sendStateEvent: async (_room: string, type: string, _key: string, content: any) => { writes.push({ type, content }); if (type === "m.room.pinned_events") pinned = content.pinned; },
  } as unknown as MatrixClient;
  const features = new RoomFeatures(client);
  await features.pin(room, "$new", true); assert.deepEqual(pinned, ["$old", "$new"]);
  await features.pin(room, "$old", false); assert.deepEqual(pinned, ["$new"]);
  await features.setMemberLevel(room, "@peer:test", 50);
  assert.deepEqual(writes.at(-1).content.events, { "m.room.name": 75 }); assert.equal(writes.at(-1).content.ban, 90);
  assert.equal(writes.at(-1).content.users["@peer:test"], 50);
  await features.setThresholds(room, { invite: 50, events_default: 0 });
  assert.equal(writes.at(-1).content.invite, 50); assert.deepEqual(writes.at(-1).content.events, { "m.room.name": 75 });
  await assert.rejects(features.setThresholds(room, { kick: 101 }), /thresholds/);
  power = { ...power, users: { "@me:test": 0, "@peer:test": 0 } };
  const before = writes.length; await assert.rejects(features.pin(room, "$blocked", true), /permission/);
  await assert.rejects(features.setMemberLevel(room, "@peer:test", 100), /permission/); assert.equal(writes.length, before);
});

test("notification inheritance, explicit overrides and mentions filter alerts", () => {
  const room = createRoomRecord("!room:test"), space = createRoomRecord("!space:test"); space.isSpace = true; space.children.add(room.id);
  const preferences: Record<string, string> = { [space.id]: "mute" };
  const client = { userId: "@me:test", getIgnoredUsers: () => ["@blocked:test"], getAccountData: () => preferences, getSpaces: () => [space] } as unknown as MatrixClient;
  const features = new RoomFeatures(client);
  assert.equal(features.shouldNotify(room, "@friend:test", "hello"), false);
  preferences[room.id] = "all"; assert.equal(features.shouldNotify(room, "@friend:test", "hello"), true);
  preferences[room.id] = "mentions"; assert.equal(features.shouldNotify(room, "@friend:test", "hello"), false);
  assert.equal(features.shouldNotify(room, "@friend:test", "hello", ["@me:test"]), true);
  assert.equal(features.shouldNotify(room, "@blocked:test", "hello", ["@me:test"]), false);
});

test("device-side search filters sender, dates, attachment types and blocked users", () => {
  const room = createRoomRecord("!room:test");
  room.timeline = [100, 200, 300].map((ts, i) => ({ kind: "message", id: `$${i}`, sender: i === 2 ? "@blocked:test" : "@friend:test", senderName: "Friend", ts, msgtype: "m.video", body: "Holiday WEBM", media: null }));
  assert.equal(searchLoaded(room, { text: "webm", sender: "@friend:test", after: 150, before: 250, type: "m.video" }).length, 1);
  assert.equal(searchLoaded(room, { text: "holiday" }, ["@blocked:test"]).length, 2);
});

test("moderation rejects self and peers, uses fresh powers and keeps reasons", async () => {
  const room = createRoomRecord("!room:test"); let own = 100;
  const calls: any[] = [];
  const client = { userId: "@me:test", getRoomPowerLevels: async () => ({ users: { "@me:test": own, "@admin:test": 100 }, ban: 75, kick: 50 }),
    api: async (method: string, path: string, options: any) => { calls.push({ method, path, body: options.body }); return {}; },
  } as unknown as MatrixClient;
  const features = new RoomFeatures(client);
  await features.moderate(room, "@friend:test", "kick", "Spam");
  assert.equal(calls[0].body.reason, "Spam"); assert.match(calls[0].path, /\/kick$/);
  await assert.rejects(features.moderate(room, "@me:test", "ban", ""), /permission/);
  await assert.rejects(features.moderate(room, "@admin:test", "ban", ""), /permission/);
  own = 50; await assert.rejects(features.moderate(room, "@friend:test", "ban", ""), /permission/);
  assert.equal(calls.length, 1);
});

test("poll tallies use the latest valid ballot, withdrawals, creator ends and the matching root", () => {
  const content = { "org.matrix.msc3381.poll.start": { question: { "org.matrix.msc1767.text": "Pick" }, kind: "org.matrix.msc3381.poll.disclosed", max_selections: 1, answers: [{ id: "a", "org.matrix.msc1767.text": "A" }, { id: "b", "org.matrix.msc1767.text": "B" }] } };
  const root: MessageItem = { kind: "message", id: "$poll", sender: "@owner:test", senderName: "Owner", body: "Pick", ts: 1, msgtype: "poll", media: null, pollEvent: { type: "org.matrix.msc3381.poll.start", content } };
  const event = (ts: number, sender: string, answers: string[], type = "response", id = "$poll"): MessageItem => ({ ...root, id: `$${ts}`, sender, ts, pollEvent: { type: `org.matrix.msc3381.poll.${type}`, content: { "m.relates_to": { event_id: id }, "org.matrix.msc3381.poll.response": { answers } } } });
  const events = [event(2, "@friend:test", ["a"]), event(3, "@friend:test", ["b"]), event(4, "@other:test", ["a"]), event(5, "@other:test", []), event(6, "@imposter:test", [], "end"), event(7, "@owner:test", [], "end"), event(8, "@friend:test", ["a"]), event(4, "@foreign:test", ["a"], "response", "$different")];
  const tally = tallyPoll(root, events); assert.equal(tally.ended, true); assert.equal(tally.counts.get("a"), 0); assert.equal(tally.counts.get("b"), 1);
});

test("poll results merge acknowledged and synced votes while the server relation index lags", async () => {
  const content = { "org.matrix.msc3381.poll.start": { question: { "org.matrix.msc1767.text": "Pick" }, kind: "org.matrix.msc3381.poll.disclosed", answers: [{ id: "a", "org.matrix.msc1767.text": "A" }, { id: "b", "org.matrix.msc1767.text": "B" }] } };
  const root: MessageItem = { kind: "message", id: "$poll-lag", sender: "@me:test", senderName: "Me", body: "Pick", ts: 1, msgtype: "poll", media: null, pollEvent: { type: "org.matrix.msc3381.poll.start", content } };
  let sent = 0, rejectSend = false;
  const client = { userId: "@me:test", api: async () => ({ chunk: [] }), sendRoomEvent: async () => { if (rejectSend) throw new Error("Offline"); return `$sent-${++sent}`; } } as unknown as MatrixClient;
  const features = new RoomFeatures(client);
  await features.vote("!room:test", root, ["a"]);
  assert.equal(tallyPoll(root, await features.pollRelations("!room:test", root.id!)).counts.get("a"), 1);
  const vote = (id: string, sender: string, answer: string, ts: number): MessageItem => ({ ...root, id, sender, ts, pollEvent: { type: "org.matrix.msc3381.poll.response", content: { "m.relates_to": { event_id: root.id, rel_type: "m.reference" }, "org.matrix.msc3381.poll.response": { answers: [answer] } } } });
  let updates = 0; const unsubscribe = features.subscribePoll("!room:test", root.id!, () => { updates++; });
  features.recordPollEvent("!room:test", vote("$remote", "@other:test", "b", 2));
  features.recordPollEvent("!room:test", vote("$remote", "@other:test", "b", 2));
  assert.equal(updates, 1, "Duplicate sync/history events must not cause repeated refreshes");
  let tally = tallyPoll(root, await features.pollRelations("!room:test", root.id!));
  assert.equal(tally.counts.get("a"), 1); assert.equal(tally.counts.get("b"), 1);
  features.recordPollEvent("!room:test", vote("$sent-1", "@me:test", "a", 3));
  features.recordPollEvent("!room:test", vote("$new-own", "@me:test", "b", 4));
  tally = tallyPoll(root, await features.pollRelations("!room:test", root.id!));
  assert.equal(tally.counts.get("a"), 0); assert.equal(tally.counts.get("b"), 2, "Authoritative server timestamps must replace local acknowledgement timestamps");
  features.redactPollEvent("!room:test", "$remote"); features.recordPollEvent("!room:test", vote("$remote", "@other:test", "b", 2));
  assert.equal(tallyPoll(root, await features.pollRelations("!room:test", root.id!)).counts.get("b"), 1, "Stale relation pages must not resurrect redacted votes");
  unsubscribe(); const before = updates;
  rejectSend = true; await assert.rejects(features.vote("!room:test", root, ["a"]), /Offline/);
  assert.equal(updates, before, "Failed sends must not create locally counted votes");
});
