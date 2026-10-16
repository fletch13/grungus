/*
 * Grungus — message relations tests: edits (m.replace), reactions
 * (m.reaction / m.annotation), replies (m.in_reply_to), and
 * redactions, against the mock homeserver.
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import type { MessageItem } from "../src/renderer/services/matrix-client.ts";

function waitFor(predicate: () => boolean, timeoutMs = 5_000, label = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out: ${label}`));
      setTimeout(poll, 25);
    };
    poll();
  });
}

/** Find a message item by body (null until it arrives). */
function findMsg(client: MatrixClient, roomId: string, body: string): MessageItem | null {
  for (const item of client.getRoom(roomId)?.timeline ?? []) {
    if (item.kind === "message" && item.body === body) return item;
  }
  return null;
}

/** Find a message item by event id. */
function byId(client: MatrixClient, roomId: string, eventId: string): MessageItem | null {
  for (const item of client.getRoom(roomId)?.timeline ?? []) {
    if (item.kind === "message" && item.id === eventId) return item;
  }
  return null;
}

async function setup(): Promise<{
  alice: MatrixClient;
  bob: MatrixClient;
  roomId: string;
  cleanup: () => void;
}> {
  const hs = new MockHomeserver();
  await hs.listen();

  hs.registerUser("alice", "pw-alice");
  hs.registerUser("bob", "pw-bob");

  const alice = new MatrixClient({ baseUrl: hs.baseUrl! });
  await alice.loginWithPassword({ username: "alice", password: "pw-alice" });
  alice.startSync();

  const bob = new MatrixClient({ baseUrl: hs.baseUrl! });
  await bob.loginWithPassword({ username: "bob", password: "pw-bob" });
  bob.startSync();

  const roomId = await alice.createRoom({ name: "relations", isPublic: true });
  await waitFor(() => alice.getRoom(roomId) !== null, 5_000, "alice sees own room");
  await bob.joinRoom(roomId);
  await waitFor(
    () => (alice.getRoom(roomId)?.members.get(bob.userId ?? "")?.membership ?? "") === "join",
    5_000,
    "bob joins"
  );

  const cleanup = (): void => {
    alice.stopSync();
    bob.stopSync();
    hs.close();
  };
  return { alice, bob, roomId, cleanup };
}

test("edit (m.replace) updates the original message in place", async (t) => {
  const { alice, bob, roomId, cleanup } = await setup();
  t.after(() => void cleanup());

  await alice.sendMessage(roomId, "original text");
  await waitFor(() => findMsg(bob, roomId, "original text") !== null, 5_000, "bob sees original");

  const origItem = findMsg(bob, roomId, "original text")!;
  assert.equal(origItem.edited, undefined);
  const eventId = origItem.id!;

  await alice.editMessage(roomId, eventId, "edited text");
  await waitFor(() => {
    const item = byId(bob, roomId, eventId);
    return item !== null && item.body === "edited text" && item.edited === true;
  }, 5_000, "bob sees the edit");

  /* the edit did NOT create a new timeline item */
  const msgCount = (bob.getRoom(roomId)?.timeline ?? []).filter((i) => i.kind === "message").length;
  assert.equal(msgCount, 1, "edit updates in place, no new item");
});

test("reactions aggregate by emoji with counts", async (t) => {
  const { alice, bob, roomId, cleanup } = await setup();
  t.after(() => void cleanup());

  await alice.sendMessage(roomId, "react to me");
  await waitFor(() => findMsg(bob, roomId, "react to me") !== null, 5_000, "bob sees message");
  const eventId = findMsg(bob, roomId, "react to me")!.id!;

  /* bob reacts 👍 */
  await bob.sendReaction(roomId, eventId, "👍");
  await waitFor(() => {
    const item = byId(bob, roomId, eventId);
    return item?.reactions?.get("👍")?.has(bob.userId ?? "") === true;
  }, 5_000, "bob sees own reaction");

  /* alice reacts 👍 too — count is 2 */
  await alice.sendReaction(roomId, eventId, "👍");
  await waitFor(() => {
    const item = byId(bob, roomId, eventId);
    return item?.reactions?.get("👍")?.size === 2;
  }, 5_000, "two 👍 reactions");

  /* alice reacts ❤️ — a second emoji chip */
  await alice.sendReaction(roomId, eventId, "❤️");
  await waitFor(() => {
    const item = byId(bob, roomId, eventId);
    return item?.reactions?.get("❤️")?.size === 1;
  }, 5_000, "one ❤️ reaction");

  /* reaction events don't create timeline items */
  const msgCount = (bob.getRoom(roomId)?.timeline ?? []).filter((i) => i.kind === "message").length;
  assert.equal(msgCount, 1, "reactions don't add timeline items");
});

test("reply (m.in_reply_to) carries the parent context", async (t) => {
  const { alice, bob, roomId, cleanup } = await setup();
  t.after(() => void cleanup());

  await alice.sendMessage(roomId, "the parent message");
  await waitFor(() => findMsg(bob, roomId, "the parent message") !== null, 5_000, "bob sees parent");
  const parentId = findMsg(bob, roomId, "the parent message")!.id!;

  await bob.replyMessage(roomId, parentId, alice.userId ?? "", "the parent message", "a reply");
  await waitFor(() => {
    const reply = findMsg(alice, roomId, "a reply");
    return (
      reply !== null &&
      reply.replyTo?.eventId === parentId &&
      reply.replyTo?.sender === alice.userId
    );
  }, 5_000, "alice sees reply with context");
});

test("redaction removes the message from the timeline", async (t) => {
  const { alice, bob, roomId, cleanup } = await setup();
  t.after(() => void cleanup());

  await alice.sendMessage(roomId, "delete me");
  await waitFor(() => findMsg(bob, roomId, "delete me") !== null, 5_000, "bob sees message");
  const eventId = findMsg(bob, roomId, "delete me")!.id!;

  await alice.redactEvent(roomId, eventId);
  await waitFor(() => byId(bob, roomId, eventId) === null, 5_000, "bob sees the redaction");
});
