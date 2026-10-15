/*
 * Grungus — MSC3401 call signaling tests against the in-repo mock
 * homeserver: m.call.member state visibility, plaintext to-device
 * signals, and olm-encrypted call signaling. (WebRTC itself needs a
 * browser — verified there.)
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import {
  MatrixClient,
  type ToDeviceEvent,
} from "../src/renderer/services/matrix-client.ts";
import {
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

test("m.call.member state is published and visible to other members", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  hs.registerUser("ana", "pw1");
  hs.registerUser("bo", "pw2");
  const a = new MatrixClient({ baseUrl: hs.baseUrl! });
  await a.loginWithPassword({ username: "ana", password: "pw1" });
  const b = new MatrixClient({ baseUrl: hs.baseUrl! });
  await b.loginWithPassword({ username: "bo", password: "pw2" });

  const roomId = await a.createRoom({ name: "call-room", isPublic: true });
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

  assert.equal(b.getRoom(roomId)!.callMembers.size, 0);

  await a.sendStateEvent(roomId, "m.call.member", a.userId!, {
    "m.calls": [
      { "m.call_id": "", "m.devices": [{ device_id: a.deviceId ?? "D", muted: false }] },
    ],
  });

  await waitFor(
    () => b.getRoom(roomId)!.callMembers.has(a.userId!),
    5_000,
    "b sees a's call membership"
  );
  const content = b.getRoom(roomId)!.callMembers.get(a.userId!)!;
  const calls = content["m.calls"] as { "m.devices"?: { device_id?: string }[] }[];
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!["m.devices"]![0]!.device_id, a.deviceId);

  /* clearing the state removes membership */
  await a.sendStateEvent(roomId, "m.call.member", a.userId!, { "m.calls": [] });
  await waitFor(
    () => !b.getRoom(roomId)!.callMembers.has(a.userId!),
    5_000,
    "membership cleared"
  );
});

test("plaintext call signals reach the other client's hook (unencrypted room)", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  hs.registerUser("cy", "pw1");
  hs.registerUser("dee", "pw2");
  const a = new MatrixClient({ baseUrl: hs.baseUrl! });
  await a.loginWithPassword({ username: "cy", password: "pw1" });
  const b = new MatrixClient({ baseUrl: hs.baseUrl! });
  await b.loginWithPassword({ username: "dee", password: "pw2" });

  const received: ToDeviceEvent[] = [];
  b.onToDevice = (event) => {
    if (event.type.startsWith("m.call.")) received.push(event);
  };

  const roomId = await a.createRoom({ name: "plain", isPublic: true });
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

  await a.sendToDevice(b.userId!, b.deviceId ?? "", "m.call.negotiate", {
    call_id: "",
    device_id: a.deviceId,
    description: { type: "offer", sdp: "v=0 fake" },
  });

  await waitFor(
    () => received.length > 0,
    5_000,
    "b receives the call signal"
  );
  const signal = received[0]!;
  assert.equal(signal.type, "m.call.negotiate");
  assert.equal(signal.sender, a.userId);
  const content = signal.content as { device_id?: string; description?: { sdp?: string } };
  assert.equal(content.device_id, a.deviceId);
  assert.equal(content.description?.sdp, "v=0 fake");
});

test("olm-encrypted call signals decrypt on the other side (encrypted room)", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  hs.registerUser("eli", "pw1");
  hs.registerUser("fen", "pw2");
  const a = new MatrixClient({ baseUrl: hs.baseUrl! });
  await a.loginWithPassword({ username: "eli", password: "pw1" });
  const b = new MatrixClient({ baseUrl: hs.baseUrl! });
  await b.loginWithPassword({ username: "fen", password: "pw2" });

  const cryptoA = new E2eeCrypto({ host: a, store: new MemoryCryptoStore() });
  await cryptoA.init();
  a.crypto = cryptoA;
  const cryptoB = new E2eeCrypto({ host: b, store: new MemoryCryptoStore() });
  await cryptoB.init();
  b.crypto = cryptoB;

  const received: { sender: string; type: string; content: Record<string, unknown> }[] = [];
  cryptoB.addPayloadListener((sender, type, content) => {
    if (type.startsWith("m.call.")) {
      received.push({ sender, type, content });
    }
  });

  const roomId = await a.createRoom({ name: "enc-call", isPublic: true, encrypted: true });
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

  /* warm the olm session by sending a message (shares keys), then signal */
  await a.sendMessage(roomId, "warm-up");
  await waitFor(
    () => (b.getRoom(roomId)?.timeline ?? []).some((i) => i.kind === "message"),
    5_000,
    "warm-up message arrives"
  );

  await cryptoA.sendToDeviceEncrypted(b.userId!, b.deviceId ?? "", "m.call.negotiate", {
    call_id: "",
    device_id: a.deviceId,
    description: { type: "offer", sdp: "v=0 secret-offer" },
  });

  await waitFor(
    () => received.length > 0,
    5_000,
    "b receives the olm-encrypted call signal"
  );
  assert.equal(received[0]!.type, "m.call.negotiate");
  assert.equal(received[0]!.sender, a.userId);
  const content = received[0]!.content as {
    device_id?: string;
    description?: { sdp?: string };
  };
  assert.equal(content.description?.sdp, "v=0 secret-offer");
  assert.equal(content.device_id, a.deviceId);
});
