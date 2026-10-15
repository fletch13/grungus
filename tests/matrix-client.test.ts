/*
 * Grungus — MatrixClient integration tests against the in-process mock
 * homeserver. These drive the REAL client code (the same module the
 * renderer bundles) over real HTTP.
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import {
  MatrixClient,
  HttpError,
  type MessageItem,
  type TimelineItem,
} from "../src/renderer/services/matrix-client.ts";

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  label = "condition"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      let ok = false;
      try {
        ok = predicate();
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
    };
    poll();
  });
}

async function makeUser(hs: MockHomeserver, name: string, password: string): Promise<MatrixClient> {
  hs.registerUser(name, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: name, password });
  return client;
}

function messageBodies(client: MatrixClient, roomId: string): string[] {
  const room = client.getRoom(roomId);
  if (!room) return [];
  return room.timeline
    .filter((item): item is MessageItem => item.kind === "message")
    .map((item) => item.body);
}

test("login, whoami, and bad-password rejection", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());
  hs.registerUser("alice", "correct-horse");

  const c = new MatrixClient({ baseUrl: hs.baseUrl! });
  await c.loginWithPassword({ username: "alice", password: "correct-horse" });
  assert.equal(c.userId, "@alice:mock.hs");
  assert.ok(c.accessToken?.startsWith("tok_"));

  const who = await c.whoami();
  assert.equal(who.user_id, "@alice:mock.hs");

  const bad = new MatrixClient({ baseUrl: hs.baseUrl! });
  await assert.rejects(
    bad.loginWithPassword({ username: "alice", password: "wrong" }),
    (err: unknown) => err instanceof HttpError && err.status === 403
  );
});

test("resolveBaseUrl keeps http for localhost, honors explicit scheme", async (t) => {
  const hs = new MockHomeserver();
  const { baseUrl, port } = await hs.listen();
  t.after(() => hs.close());

  const explicit = await MatrixClient.resolveBaseUrl(baseUrl);
  assert.equal(explicit, baseUrl);

  const typed = await MatrixClient.resolveBaseUrl(`127.0.0.1:${port}`);
  assert.equal(typed, baseUrl);
});

test("rooms: create, join, sync, bidirectional messages, local echo, unread", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeUser(hs, "alice", "pw1");
  const b = await makeUser(hs, "bob", "pw2");

  const roomId = await a.createRoom({ name: "test-room", isPublic: true });
  assert.ok(roomId.startsWith("!"), "room id looks like a Matrix room id");

  const joined = await b.joinRoom(roomId);
  assert.equal(joined, roomId);

  a.startSync();
  b.startSync();
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });

  await waitFor(
    () => a.getRoom(roomId) !== null && b.getRoom(roomId) !== null,
    5_000,
    "rooms to appear in both syncs"
  );

  const roomA = a.getRoom(roomId)!;
  assert.equal(roomA.title, "test-room");
  assert.equal(roomA.joinedMemberCount, 2);
  assert.equal(roomA.isSpace, false);
  const bobMember = roomA.members.get("@bob:mock.hs");
  assert.ok(bobMember, "bob is in member state");
  assert.equal(bobMember.displayname, "bob");

  /* a → b */
  await a.sendMessage(roomId, "hello bob");
  await waitFor(
    () => messageBodies(b, roomId).includes("hello bob"),
    5_000,
    "bob receives alice's message"
  );

  /* b's unread counter bumped (no room selected on b) */
  await waitFor(
    () => (b.getRoom(roomId)?.unread ?? 0) >= 1,
    5_000,
    "unread count increments"
  );
  b.markRoomRead(roomId);
  assert.equal(b.getRoom(roomId)!.unread, 0);

  /* b → a */
  await b.sendMessage(roomId, "hi alice");
  await waitFor(
    () => messageBodies(a, roomId).includes("hi alice"),
    5_000,
    "alice receives bob's message"
  );

  /* local echo reconciled: exactly one copy of alice's message, not pending */
  await waitFor(
    () => {
      const room = a.getRoom(roomId)!;
      const hellos = room.timeline.filter(
        (item): item is MessageItem =>
          item.kind === "message" && item.body === "hello bob"
      );
      return hellos.length === 1 && !hellos[0]!.pending && !hellos[0]!.txnId;
    },
    5_000,
    "local echo replaced by server event"
  );
});

test("unnamed 1:1 rooms resolve as direct messages", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeUser(hs, "carol", "pw3");
  const b = await makeUser(hs, "dave", "pw4");

  const roomId = await a.createRoom({ isPublic: true }); /* no name */
  await b.joinRoom(roomId);

  a.startSync();
  b.startSync();
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });

  await waitFor(() => a.getRoom(roomId) !== null, 5_000, "room syncs for carol");
  const room = a.getRoom(roomId)!;
  assert.equal(room.title, "dave");
  assert.equal(room.isDirect, true);
  assert.equal(room.directUserId, "@dave:mock.hs");
});

test("spaces are tracked with their children and excluded from rooms", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeUser(hs, "erin", "pw5");
  const generalId = await a.createRoom({ name: "general", isPublic: true });
  const randomId = await a.createRoom({ name: "random", isPublic: true });
  const spaceId = await a.createRoom({
    name: "HQ",
    isPublic: true,
    isSpace: true,
  });
  hs.addSpaceChild(spaceId, generalId);

  a.startSync();
  t.after(() => a.stopSync());

  await waitFor(() => a.getRoom(spaceId) !== null, 5_000, "space room syncs");

  const spaces = a.getSpaces();
  assert.equal(spaces.length, 1);
  assert.equal(spaces[0]!.id, spaceId);
  assert.equal(spaces[0]!.title, "HQ");
  assert.equal(spaces[0]!.children.has(generalId), true);
  assert.equal(spaces[0]!.children.has(randomId), false);

  const rooms = a.getRooms();
  assert.ok(rooms.some((room) => room.id === generalId));
  assert.ok(!rooms.some((room) => room.id === spaceId), "space not in room list");
  assert.ok(!rooms.some((room) => room.isSpace), "no spaces leak into room list");
});

test("image messages carry media metadata for rendering", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeUser(hs, "hilary", "pw7");
  const roomId = await a.createRoom({ name: "media-room", isPublic: true });

  a.startSync();
  t.after(() => a.stopSync());
  await waitFor(() => a.getRoom(roomId) !== null, 5_000, "room syncs");

  /* send an m.image directly through the mock (upload is out of scope) */
  hs.pushEvent(roomId, "m.room.message", a.userId ?? "", {
    msgtype: "m.image",
    body: "dance.gif",
    url: "mxc://mock.hs/dance.gif",
    info: { mimetype: "image/gif", w: 64, h: 64, size: 1234 },
  });
  await waitFor(
    () =>
      a
        .getRoom(roomId)!
        .timeline.some(
          (item: TimelineItem) =>
            item.kind === "message" && item.media?.mimetype === "image/gif"
        ),
    5_000,
    "image message parsed with media metadata"
  );

  const item = a
    .getRoom(roomId)!
    .timeline.find(
      (entry): entry is MessageItem =>
        entry.kind === "message" && entry.media !== null
    )!;
  assert.equal(item.media!.mxc, "mxc://mock.hs/dance.gif");
  assert.equal(item.media!.width, 64);
  assert.equal(item.media!.name, "dance.gif");

  /* mediaSrc: invalid URIs and unknown media resolve to null */
  assert.equal(await a.mediaSrc("not-an-mxc"), null);
  assert.equal(await a.mediaSrc("mxc://mock.hs/missing"), null);
});

test("sync loop: online/offline states and auth-error on dead token", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const c = await makeUser(hs, "frank", "pw6");
  c.startSync();
  await waitFor(
    () => c.connectionState === "online",
    5_000,
    "first sync completes"
  );
  c.stopSync();
  await new Promise((resolve) => setTimeout(resolve, 100));

  await c.logout(); /* invalidates the token server-side, clears locally */
  assert.equal(c.accessToken, null);

  /* restart with a dead token to exercise the 401 path */
  c.accessToken = "tok_deadbeef";
  let authErr: HttpError | null = null;
  c.on("auth-error", (err) => {
    authErr = err;
  });
  c.startSync();
  await waitFor(() => authErr !== null, 5_000, "auth-error event");
  assert.equal((authErr as HttpError | null)?.status, 401);
  assert.equal(c.connectionState, "auth-error");
  c.stopSync();
});
