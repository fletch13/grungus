/*
 * Grungus — read markers against the mock homeserver:
 *   - selecting/reading a room sends the public m.read receipt AND the
 *     m.fully_read room account-data marker
 *   - other users' receipts arrive via ephemeral m.receipt and land
 *     in room.readReceipts
 *   - receiptCoversEvent compares by timeline position (the DM "Seen"
 *     indicator's logic): the peer's receipt covers our message when
 *     it points at that event or a later one
 *   - the fully-read marker parses back from room account data
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";

function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  label = "condition"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      void (async () => {
        let ok = false;
        try {
          ok = await predicate();
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
      })();
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

test("reading a room sends the m.read receipt and the m.fully_read marker", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeClient(hs, "rma", "pw1");
  const b = await makeClient(hs, "rmb", "pw2");
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });

  const room = await a.createRoom({ name: "read-room", isPublic: true });
  await b.joinRoom(room);
  await waitFor(() => a.getRoom(room) !== null && b.getRoom(room) !== null, 5_000, "rooms sync");

  await a.sendMessage(room, "hello read-marker world");
  await waitFor(
    () => (b.getRoom(room)?.timeline ?? []).some((i) => i.kind === "message"),
    5_000,
    "b sees the message"
  );

  /* B reads the room */
  b.markRoomRead(room);
  /* the receipt + marker are async — wait for them to land */
  await waitFor(
    () => hs.rooms.get(room)?.readReceipts.has(b.userId ?? "") === true,
    5_000,
    "receipt on the server"
  );
  const receipt = hs.rooms.get(room)!.readReceipts.get(b.userId!)!;
  const lastEventId = b.latestTimelineEventId(room);
  assert.ok(lastEventId, "the latest event id exists");
  assert.equal(receipt.eventId, lastEventId, "the receipt points at the latest message");

  await waitFor(
    () =>
      (hs.roomAccountData.get(`rmb|${room}`)?.get("m.fully_read") as
        | { event_id?: string }
        | undefined)?.event_id === lastEventId,
    5_000,
    "m.fully_read marker on the server"
  );

  /* A receives B's receipt via ephemeral sync */
  await waitFor(
    () => a.getRoom(room)?.readReceipts.get(b.userId ?? "")?.eventId === lastEventId,
    5_000,
    "A sees B's receipt"
  );

  /* the marker parses back for B */
  await waitFor(
    () => b.getRoom(room)?.fullyReadEventId === lastEventId,
    5_000,
    "fully-read marker parses back"
  );

  /* receiptCoversEvent: B's receipt covers the message */
  assert.equal(
    a.receiptCoversEvent(room, b.userId!, lastEventId),
    true,
    "the receipt covers the latest message"
  );
  /* ... and does NOT cover an event that never happened */
  assert.equal(
    a.receiptCoversEvent(room, b.userId!, "$nonexistent"),
    false,
    "an unknown event is not covered"
  );
});

test("receiptCoversEvent compares by timeline position (the Seen logic)", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeClient(hs, "sena", "pw1");
  const b = await makeClient(hs, "senb", "pw2");
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });

  const room = await a.createRoom({ name: "seen-room", isPublic: true });
  await b.joinRoom(room);
  await waitFor(() => a.getRoom(room) !== null && b.getRoom(room) !== null, 5_000, "rooms sync");

  /* A sends three messages; B reads up to the SECOND one */
  await a.sendMessage(room, "message one");
  await waitFor(
    () => (b.getRoom(room)?.timeline ?? []).some((i) => i.kind === "message" && i.body === "message one"),
    5_000,
    "b sees message one"
  );
  await a.sendMessage(room, "message two");
  await waitFor(
    () => (b.getRoom(room)?.timeline ?? []).some((i) => i.kind === "message" && i.body === "message two"),
    5_000,
    "b sees message two"
  );
  const secondEventId = b.latestTimelineEventId(room);
  b.markRoomRead(room);
  await waitFor(
    () => hs.rooms.get(room)?.readReceipts.get(b.userId ?? "")?.eventId === secondEventId,
    5_000,
    "b read up to message two"
  );

  /* a third message arrives AFTER b read */
  await a.sendMessage(room, "message three");
  await waitFor(
    () => (a.getRoom(room)?.timeline ?? []).some((i) => i.kind === "message" && i.body === "message three"),
    5_000,
    "a sees message three"
  );

  /* A gets B's receipt */
  await waitFor(
    () => a.getRoom(room)?.readReceipts.get(b.userId ?? "")?.eventId === secondEventId,
    5_000,
    "a receives b's receipt"
  );

  const first = a
    .getRoom(room)!.timeline.find((i) => i.kind === "message" && i.body === "message one")!;
  const second = a
    .getRoom(room)!.timeline.find((i) => i.kind === "message" && i.body === "message two")!;
  const third = a
    .getRoom(room)!.timeline.find((i) => i.kind === "message" && i.body === "message three")!;

  /* B read up to the second message: covers one and two, not three */
  assert.equal(a.receiptCoversEvent(room, b.userId!, first.id!), true, "covers message one");
  assert.equal(a.receiptCoversEvent(room, b.userId!, second.id!), true, "covers message two");
  assert.equal(a.receiptCoversEvent(room, b.userId!, third.id!), false, "does NOT cover message three");
});
