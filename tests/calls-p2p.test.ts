/*
 * Grungus — legacy 1:1 call protocol (MSC2746 room events) signaling
 * tests against the in-repo mock homeserver: invites ring the callee
 * (plaintext AND megolm-encrypted rooms), stale invites are ignored,
 * hangups cancel the ring, and the wire shapes match Element's. (The
 * WebRTC media path needs a browser — verified there.)
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { P2PCallManager } from "../src/renderer/services/calls-p2p.ts";
import {
  E2eeCrypto,
  MemoryCryptoStore,
} from "../src/renderer/services/e2ee.ts";

function waitFor(
  predicate: () => boolean,
  timeoutMs = 8_000,
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

/** Wire a client's raw m.call.* room events to a P2PCallManager (app wiring). */
function wireCallEvents(client: MatrixClient, manager: P2PCallManager): void {
  client.onCallEvent = (roomId, ev) => manager.onCallEvent(roomId, ev);
}

test("p2p: an m.call.invite rings the callee (plaintext room)", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  hs.registerUser("caller", "pw1");
  hs.registerUser("callee", "pw2");
  const a = new MatrixClient({ baseUrl: hs.baseUrl! });
  await a.loginWithPassword({ username: "caller", password: "pw1" });
  const b = new MatrixClient({ baseUrl: hs.baseUrl! });
  await b.loginWithPassword({ username: "callee", password: "pw2" });

  const roomId = await a.createRoom({ name: "dm", isPublic: false });
  await a.invite(roomId, b.userId!);
  await b.joinRoom(roomId);

  a.startSync();
  b.startSync();
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });
  await waitFor(
    () => a.getRoom(roomId) !== null && b.getRoom(roomId) !== null,
    8_000,
    "rooms sync"
  );

  const bP2p = new P2PCallManager(b);
  wireCallEvents(b, bP2p);
  const rings: { roomId: string; title: string }[] = [];
  bP2p.setIncomingListener((roomId, title) => rings.push({ roomId, title }));

  /* the caller sends the invite exactly like the manager does */
  await a.sendRoomEvent(roomId, "m.call.invite", {
    call_id: "call-1",
    lifetime: 60_000,
    party_id: a.deviceId,
    version: "1",
    offer: { type: "offer", sdp: "v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n" },
  });

  await waitFor(() => rings.length > 0, 8_000, "the invite rings");
  assert.equal(rings[0]!.roomId, roomId);
  assert.equal(bP2p.pendingIncomingRoomId, roomId);

  /* the invite is on the wire for Element to parse: a room event with
     the MSC2746 shape (never a to-device message) */
  const stored = hs.rooms.get(roomId)!.events.find(
    (event) => event.type === "m.call.invite"
  );
  assert.ok(stored, "m.call.invite stored as a room event");
  assert.equal((stored!.content as { call_id?: string }).call_id, "call-1");
  assert.equal((stored!.content as { version?: string }).version, "1");
});

test("p2p: invites in ENCRYPTED rooms ring too (megolm-wrapped)", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeCryptoUser(hs, "enc_caller", "pw1");
  const b = await makeCryptoUser(hs, "enc_callee", "pw2");

  const roomId = await a.createRoom({
    name: "enc-dm",
    isPublic: false,
    encrypted: true,
  });
  await a.invite(roomId, b.userId!);
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
    8_000,
    "both clients see the room as encrypted"
  );

  const bP2p = new P2PCallManager(b);
  wireCallEvents(b, bP2p);
  const rings: string[] = [];
  bP2p.setIncomingListener((roomId) => rings.push(roomId));

  await a.sendRoomEvent(roomId, "m.call.invite", {
    call_id: "enc-call-1",
    lifetime: 60_000,
    party_id: a.deviceId,
    version: "1",
    offer: { type: "offer", sdp: "v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n" },
  });

  await waitFor(() => rings.length > 0, 8_000, "the encrypted invite rings");

  /* the server only ever saw megolm ciphertext */
  const stored = hs.rooms.get(roomId)!.events.find(
    (event) => event.type === "m.room.encrypted"
  );
  assert.ok(stored, "the invite was stored encrypted");
  assert.ok(
    !JSON.stringify(stored!.content).includes("enc-call-1"),
    "the call id is inside the ciphertext only"
  );
});

test("p2p: stale invites (past their lifetime) never ring", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  hs.registerUser("late", "pw1");
  hs.registerUser("sleepy", "pw2");
  const a = new MatrixClient({ baseUrl: hs.baseUrl! });
  await a.loginWithPassword({ username: "late", password: "pw1" });
  const b = new MatrixClient({ baseUrl: hs.baseUrl! });
  await b.loginWithPassword({ username: "sleepy", password: "pw2" });

  const roomId = await a.createRoom({ name: "dm", isPublic: false });
  await a.invite(roomId, b.userId!);
  await b.joinRoom(roomId);

  a.startSync();
  b.startSync();
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });
  await waitFor(
    () => a.getRoom(roomId) !== null && b.getRoom(roomId) !== null,
    8_000,
    "rooms sync"
  );

  const bP2p = new P2PCallManager(b);
  wireCallEvents(b, bP2p);
  let rings = 0;
  bP2p.setIncomingListener(() => rings++);

  /* a 1ms lifetime is expired by the time the event arrives */
  await a.sendRoomEvent(roomId, "m.call.invite", {
    call_id: "stale-1",
    lifetime: 1,
    party_id: a.deviceId,
    version: "1",
    offer: { type: "offer", sdp: "v=0\r\n" },
  });
  /* let the sync deliver it for sure */
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(rings, 0, "the stale invite did not ring");
  assert.equal(bP2p.pendingIncomingRoomId, null);
});

test("p2p: the caller's hangup cancels the ring", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  hs.registerUser("impatient", "pw1");
  hs.registerUser("slowpoke", "pw2");
  const a = new MatrixClient({ baseUrl: hs.baseUrl! });
  await a.loginWithPassword({ username: "impatient", password: "pw1" });
  const b = new MatrixClient({ baseUrl: hs.baseUrl! });
  await b.loginWithPassword({ username: "slowpoke", password: "pw2" });

  const roomId = await a.createRoom({ name: "dm", isPublic: false });
  await a.invite(roomId, b.userId!);
  await b.joinRoom(roomId);

  a.startSync();
  b.startSync();
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });
  await waitFor(
    () => a.getRoom(roomId) !== null && b.getRoom(roomId) !== null,
    8_000,
    "rooms sync"
  );

  const bP2p = new P2PCallManager(b);
  wireCallEvents(b, bP2p);
  const rings: string[] = [];
  const cancels: string[] = [];
  bP2p.setIncomingListener((roomId) => rings.push(roomId));
  bP2p.setRingCancelListener((roomId) => cancels.push(roomId));

  await a.sendRoomEvent(roomId, "m.call.invite", {
    call_id: "cancel-1",
    lifetime: 60_000,
    party_id: a.deviceId,
    version: "1",
    offer: { type: "offer", sdp: "v=0\r\n" },
  });
  await waitFor(() => rings.length > 0, 8_000, "the invite rings");

  await a.sendRoomEvent(roomId, "m.call.hangup", {
    call_id: "cancel-1",
    party_id: a.deviceId,
    version: "1",
  });
  await waitFor(() => cancels.length > 0, 8_000, "the hangup cancels the ring");
  assert.equal(bP2p.pendingIncomingRoomId, null);
});
