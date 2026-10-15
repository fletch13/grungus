/*
 * Grungus — MatrixClient integration tests against the in-process mock
 * homeserver. These drive the REAL client code (the same module the
 * renderer loads) over real HTTP.
 *
 * Run: npm test
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { MockHomeserver } = require("./mock-homeserver.js");
const { MatrixClient } = require("../src/renderer/services/matrix-client.js");

function waitFor(predicate, timeoutMs, label) {
  timeoutMs = timeoutMs || 5000;
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch (e) {
        return reject(e);
      }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("Timed out waiting for: " + label));
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function makeUser(hs, name, password) {
  hs.registerUser(name, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl });
  await client.loginWithPassword({ username: name, password });
  return client;
}

test("login, whoami, and bad-password rejection", async (t) => {
  const hs = new MockHomeserver();
  const { baseUrl, port } = await hs.listen();
  t.after(() => hs.close());
  hs.registerUser("alice", "correct-horse");

  const c = new MatrixClient({ baseUrl });
  await c.loginWithPassword({ username: "alice", password: "correct-horse" });
  assert.strictEqual(c.userId, "@alice:mock.hs");
  assert.ok(c.accessToken.startsWith("tok_"));

  const who = await c.whoami();
  assert.strictEqual(who.user_id, "@alice:mock.hs");

  const bad = new MatrixClient({ baseUrl });
  await assert.rejects(
    bad.loginWithPassword({ username: "alice", password: "wrong" }),
    (err) => err.status === 403
  );
});

test("resolveBaseUrl keeps http for localhost, honors explicit scheme", async (t) => {
  const hs = new MockHomeserver();
  const { baseUrl, port } = await hs.listen();
  t.after(() => hs.close());

  const explicit = await MatrixClient.resolveBaseUrl(baseUrl);
  assert.strictEqual(explicit, baseUrl);

  const typed = await MatrixClient.resolveBaseUrl("127.0.0.1:" + port);
  assert.strictEqual(typed, baseUrl);
});

test("rooms: create, join, sync, bidirectional messages, local echo, unread", async (t) => {
  const hs = new MockHomeserver();
  const { baseUrl } = await hs.listen();
  t.after(() => hs.close());

  const a = await makeUser(hs, "alice", "pw1");
  const b = await makeUser(hs, "bob", "pw2");

  const roomId = await a.createRoom({ name: "test-room", isPublic: true });
  assert.ok(roomId.startsWith("!"), "room id looks like a Matrix room id");

  const joined = await b.joinRoom(roomId);
  assert.strictEqual(joined, roomId);

  a.startSync();
  b.startSync();
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });

  await waitFor(
    () => a.getRoom(roomId) && b.getRoom(roomId),
    5000,
    "rooms to appear in both syncs"
  );

  const roomA = a.getRoom(roomId);
  assert.strictEqual(roomA.title, "test-room");
  assert.strictEqual(roomA.joinedMemberCount, 2);
  assert.strictEqual(roomA.isSpace, false);
  const bobMember = roomA.members.get("@bob:mock.hs");
  assert.ok(bobMember, "bob is in member state");
  assert.strictEqual(bobMember.displayname, "bob");

  /* a → b */
  await a.sendMessage(roomId, "hello bob");
  await waitFor(
    () =>
      (b.getRoom(roomId) || { timeline: [] }).timeline.some(
        (i) => i.kind === "message" && i.body === "hello bob"
      ),
    5000,
    "bob receives alice's message"
  );

  /* b's unread counter bumped (no room selected on b) */
  await waitFor(
    () => (b.getRoom(roomId).unread || 0) >= 1,
    5000,
    "unread count increments"
  );
  b.markRoomRead(roomId);
  assert.strictEqual(b.getRoom(roomId).unread, 0);

  /* b → a */
  await b.sendMessage(roomId, "hi alice");
  await waitFor(
    () =>
      (a.getRoom(roomId) || { timeline: [] }).timeline.some(
        (i) => i.kind === "message" && i.body === "hi alice"
      ),
    5000,
    "alice receives bob's message"
  );

  /* local echo reconciled: exactly one copy of alice's message, not pending */
  await waitFor(
    () => {
      const hellos = a
        .getRoom(roomId)
        .timeline.filter((i) => i.kind === "message" && i.body === "hello bob");
      return hellos.length === 1 && !hellos[0].pending && !hellos[0].txnId;
    },
    5000,
    "local echo replaced by server event"
  );
});

test("unnamed 1:1 rooms resolve as direct messages", async (t) => {
  const hs = new MockHomeserver();
  const { baseUrl } = await hs.listen();
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

  await waitFor(() => a.getRoom(roomId), 5000, "room syncs for carol");
  const room = a.getRoom(roomId);
  assert.strictEqual(room.title, "dave");
  assert.strictEqual(room.isDirect, true);
  assert.strictEqual(room.directUserId, "@dave:mock.hs");
});

test("spaces are tracked with their children and excluded from rooms", async (t) => {
  const hs = new MockHomeserver();
  const { baseUrl } = await hs.listen();
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

  await waitFor(() => a.getRoom(spaceId), 5000, "space room syncs");

  const spaces = a.getSpaces();
  assert.strictEqual(spaces.length, 1);
  assert.strictEqual(spaces[0].id, spaceId);
  assert.strictEqual(spaces[0].title, "HQ");
  assert.strictEqual(spaces[0].children.has(generalId), true);
  assert.strictEqual(spaces[0].children.has(randomId), false);

  const rooms = a.getRooms();
  assert.ok(rooms.some((r) => r.id === generalId));
  assert.ok(!rooms.some((r) => r.id === spaceId), "space not in the room list");
  assert.ok(!rooms.some((r) => r.isSpace), "no spaces leak into the room list");
});

test("sync loop: online/offline states and auth-error on dead token", async (t) => {
  const hs = new MockHomeserver();
  const { baseUrl } = await hs.listen();
  t.after(() => hs.close());

  const c = await makeUser(hs, "frank", "pw6");
  c.startSync();
  await waitFor(
    () => c.connectionState === "online",
    5000,
    "first sync completes"
  );
  c.stopSync();
  await new Promise((r) => setTimeout(r, 100));

  await c.logout(); /* invalidates the token server-side, clears locally */
  assert.strictEqual(c.accessToken, null);

  /* restart with a dead token to exercise the 401 path */
  c.accessToken = "tok_deadbeef";
  let authErr = null;
  c.on("auth-error", (e) => {
    authErr = e;
  });
  c.startSync();
  await waitFor(() => authErr !== null, 5000, "auth-error event");
  assert.strictEqual(authErr.status, 401);
  assert.strictEqual(c.connectionState, "auth-error");
  c.stopSync();
});
