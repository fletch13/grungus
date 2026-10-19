/*
 * Grungus — E2EE (Olm/Megolm) integration tests against the in-repo mock
 * homeserver. Two full clients with real libolm WASM identities exchange
 * encrypted messages through real HTTP; the mock's stored events are
 * asserted to contain no plaintext.
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import {
  MatrixClient,
  type MessageItem,
} from "../src/renderer/services/matrix-client.ts";
import {
  CryptoIdentityResetError,
  E2eeCrypto,
  MemoryCryptoStore,
} from "../src/renderer/services/e2ee.ts";

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

/** A user with the E2EE layer attached — the same wiring app.ts performs. */
async function makeCryptoUser(
  hs: MockHomeserver,
  name: string,
  password: string
): Promise<MatrixClient> {
  hs.registerUser(name, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: name, password });
  const crypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await crypto.init();
  client.crypto = crypto;
  return client;
}

function messageBodies(client: MatrixClient, roomId: string): string[] {
  const room = client.getRoom(roomId);
  if (!room) return [];
  return room.timeline
    .filter((item): item is MessageItem => item.kind === "message")
    .map((item) => item.body);
}

test("a wiped crypto store under a live session is detected (identity reset)", async (t) => {
  /*
   * The user's bug: the crypto store was cleared while the session stayed
   * logged in. The fresh olm identity reuses the token's device id, the
   * server keeps the OLD account's identity + one-time keys, and every
   * self-share fails (OLM.BAD_MESSAGE_KEY_ID) — the sender's own messages
   * turn UTD. init() must REFUSE (so the app logs out) instead of starting
   * half-broken.
   */
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const client = await makeCryptoUser(hs, "splitbrain", "pw1");
  const deviceId = client.deviceId!;
  assert.ok(deviceId, "login assigned a device id");

  /* simulate the store wipe: same client/token/device id, EMPTY store */
  const fresh = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await assert.rejects(
    () => fresh.init(),
    (err: unknown) => err instanceof CryptoIdentityResetError,
    "init must refuse a fresh identity under a device id the server knows"
  );
  /* and the client must not have been re-armed with the broken crypto */
  assert.equal(client.crypto === fresh, false);
});

test("device keys are uploaded on init", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const client = await makeCryptoUser(hs, "kim", "pw9");

  const devices = hs.devices.get("kim");
  assert.ok(devices, "device map exists");
  assert.equal(devices.size, 1);
  const device = [...devices.values()][0]!;
  const deviceKeys = device.deviceKeys as {
    user_id?: string;
    keys?: Record<string, string>;
    signatures?: Record<string, Record<string, string>>;
  };
  assert.equal(deviceKeys.user_id, "@kim:mock.hs");
  assert.ok(
    deviceKeys.keys?.[`curve25519:${client.deviceId}`],
    "curve25519 key uploaded"
  );
  assert.ok(
    deviceKeys.keys?.[`ed25519:${client.deviceId}`],
    "ed25519 key uploaded"
  );
  assert.ok(deviceKeys.signatures?.["@kim:mock.hs"], "device keys are signed");
  assert.ok(device.oneTimeKeys.size > 0, "one-time keys uploaded");
  client.stopSync();
});

test("encrypted room: messages round-trip as megolm ciphertext, both ways", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeCryptoUser(hs, "lena", "pw1");
  const b = await makeCryptoUser(hs, "omar", "pw2");

  const roomId = await a.createRoom({
    name: "war-room",
    isPublic: true,
    encrypted: true,
  });
  await b.joinRoom(roomId);

  a.startSync();
  b.startSync();
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });

  await waitFor(
    () =>
      a.getRoom(roomId)?.isEncrypted === true &&
      b.getRoom(roomId)?.isEncrypted === true,
    5_000,
    "both clients see the room as encrypted"
  );

  /* a -> b: encrypted send, shared room key via to-device olm */
  await a.sendMessage(roomId, "attack at dawn");
  await waitFor(
    () => messageBodies(b, roomId).includes("attack at dawn"),
    5_000,
    "bob decrypts alice's message"
  );

  /* the server never saw the plaintext */
  const storedRoom = hs.rooms.get(roomId)!;
  const storedEvent = storedRoom.events.find(
    (event) =>
      event.type === "m.room.encrypted" &&
      JSON.stringify(event.content).includes("m.megolm")
  );
  assert.ok(storedEvent, "an encrypted event is stored");
  assert.ok(
    !JSON.stringify(storedEvent.content).includes("attack at dawn"),
    "plaintext is absent from the stored ciphertext"
  );
  const content = storedEvent.content as { algorithm?: string; ciphertext?: string };
  assert.equal(content.algorithm, "m.megolm.v1.aes-sha2");
  assert.ok(content.ciphertext && content.ciphertext.length > 50, "real ciphertext");

  /* b -> a: the reverse direction must also work */
  await b.sendMessage(roomId, "roger that");
  await waitFor(
    () => messageBodies(a, roomId).includes("roger that"),
    5_000,
    "alice decrypts bob's reply"
  );

  /* a second message reuses the shared session (no re-share needed) */
  await a.sendMessage(roomId, "and a second one");
  await waitFor(
    () => messageBodies(b, roomId).includes("and a second one"),
    5_000,
    "second message decrypts with the same session"
  );
});

test("plaintext rooms are unaffected by the crypto layer", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeCryptoUser(hs, "petra", "pw3");
  const b = await makeCryptoUser(hs, "quinn", "pw4");

  const roomId = await a.createRoom({ name: "plain-room", isPublic: true });
  await b.joinRoom(roomId);

  a.startSync();
  b.startSync();
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });

  await waitFor(
    () => a.getRoom(roomId) !== null && b.getRoom(roomId) !== null,
    5_000,
    "rooms sync"
  );
  assert.equal(a.getRoom(roomId)!.isEncrypted, false);

  await a.sendMessage(roomId, "plain hello");
  await waitFor(
    () => messageBodies(b, roomId).includes("plain hello"),
    5_000,
    "plaintext delivery still works"
  );

  const storedRoom = hs.rooms.get(roomId)!;
  const stored = storedRoom.events.find((event) =>
    JSON.stringify(event.content).includes("plain hello")
  );
  assert.ok(stored, "plaintext room stores the plaintext event (as expected)");
});

test("encrypted attachments upload ciphertext and decrypt on the receiving device", async t => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());
  const a = await makeCryptoUser(hs, "image_a", "pw");
  const b = await makeCryptoUser(hs, "image_b", "pw");
  const roomId = await a.createRoom({ name: "encrypted images", isPublic: true, encrypted: true });
  await b.joinRoom(roomId);
  a.startSync();
  b.startSync();
  t.after(() => { a.stopSync(); b.stopSync(); });
  await waitFor(() => !!a.getRoom(roomId) && !!b.getRoom(roomId));
  const original = new TextEncoder().encode("secret image content");
  await assert.rejects(() => a.sendMedia(roomId, { mxc: "mxc://mock.hs/raw", name: "raw.png", mimeType: "image/png" }), /encrypted attachments/);
  await a.uploadAndSendMedia(roomId, "private.png", "image/png", original);
  const image = (): MessageItem | undefined => b.getRoom(roomId)?.timeline.find((item): item is MessageItem => item.kind === "message" && !!item.media?.file);
  await waitFor(() => !!image());
  const media = image()!.media!;
  const stored = hs.media.get(media.mxc.slice("mxc://mock.hs/".length))!;
  assert.notDeepEqual(new Uint8Array(stored.bytes), original);
  const src = await b.mediaSrc(media.mxc, media.file, media.mimetype!);
  assert.ok(src);
  assert.deepEqual(new Uint8Array(await (await fetch(src)).arrayBuffer()), original);
  URL.revokeObjectURL(src);
});

test("a partially synced encrypted room cannot downgrade sends to plaintext", async t => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());
  const client = await makeCryptoUser(hs, "partial_room", "pw");
  const roomId = await client.createRoom({ name: "partial", encrypted: true, isPublic: true });
  client.startSync();
  t.after(() => client.stopSync());
  await waitFor(() => !!client.getRoom(roomId));
  client.stopSync();
  // Reproduce the room-create sync arriving ahead of its encryption state.
  client.getRoom(roomId)!.isEncrypted = false;
  const eventId = await client.sendMessage(roomId, "must remain private");
  const event = hs.rooms.get(roomId)!.events.find(event => event.event_id === eventId);
  assert.equal(event?.type, "m.room.encrypted");
  await client.sendRoomEvent(roomId, "m.test", { private: true });
  assert.equal(hs.rooms.get(roomId)!.events.at(-1)?.type, "m.room.encrypted");
  client.crypto = null;
  await assert.rejects(() => client.uploadAndSendMedia(roomId, "private.png", "image/png", new Uint8Array([1])), /E2EE is unavailable/);
  assert.equal(hs.media.size, 0);
});

test("edits, replies, and reactions use the encrypted sender and fail closed without crypto", async t => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());
  const a = await makeCryptoUser(hs, "relations_a", "pw");
  const b = await makeCryptoUser(hs, "relations_b", "pw");
  const roomId = await a.createRoom({ name: "private relations", isPublic: true, encrypted: true });
  await b.joinRoom(roomId);
  a.startSync();
  b.startSync();
  t.after(() => { a.stopSync(); b.stopSync(); });
  await waitFor(() => a.getRoom(roomId)?.members.get(b.userId!)?.membership === "join" && !!b.getRoom(roomId));
  const original = await a.sendMessage(roomId, "private original");
  await waitFor(() => messageBodies(b, roomId).includes("private original"));
  const edit = await a.editMessage(roomId, original!, "private edited text");
  await waitFor(() => messageBodies(b, roomId).includes("private edited text"));
  const reply = await a.replyMessage(roomId, original!, a.userId!, "private edited text", "private reply text");
  await waitFor(() => messageBodies(b, roomId).includes("private reply text"));
  const reaction = await b.sendReaction(roomId, original!, "👍");
  await waitFor(() => a.getRoom(roomId)!.timeline.some(item => item.kind === "message" && item.id === original && item.reactions?.get("👍")?.has(b.userId!)));
  for (const eventId of [edit, reply, reaction]) {
    const event = hs.rooms.get(roomId)!.events.find(event => event.event_id === eventId)!;
    assert.equal(event.type, "m.room.encrypted");
    assert.ok(!JSON.stringify(event.content).includes("private"));
  }
  a.crypto = null;
  const count = hs.rooms.get(roomId)!.events.length;
  await assert.rejects(() => a.editMessage(roomId, original!, "do not leak"), /E2EE is unavailable/);
  await assert.rejects(() => a.replyMessage(roomId, original!, a.userId!, "parent", "do not leak"), /E2EE is unavailable/);
  await assert.rejects(() => a.sendReaction(roomId, original!, "👍"), /E2EE is unavailable/);
  assert.equal(hs.rooms.get(roomId)!.events.length, count);
});
