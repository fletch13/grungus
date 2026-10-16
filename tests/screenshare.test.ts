/*
 * Grungus — screenshare signaling (m.call.screenshare start/stop) over
 * both plaintext and olm-encrypted call paths, against the mock
 * homeserver. The media path itself (renegotiation + track routing) is
 * verified in the browser against a real peer connection.
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient, type ToDeviceEvent } from "../src/renderer/services/matrix-client.ts";
import { E2eeCrypto, MemoryCryptoStore } from "../src/renderer/services/e2ee.ts";

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

test("screenshare start/stop signals reach the peer (unencrypted room)", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  hs.registerUser("sha", "pw1");
  hs.registerUser("lin", "pw2");
  const a = new MatrixClient({ baseUrl: hs.baseUrl! });
  await a.loginWithPassword({ username: "sha", password: "pw1" });
  const b = new MatrixClient({ baseUrl: hs.baseUrl! });
  await b.loginWithPassword({ username: "lin", password: "pw2" });

  const received: ToDeviceEvent[] = [];
  b.onToDevice = (event) => {
    if (event.type === "m.call.screenshare") received.push(event);
  };

  const roomId = await a.createRoom({ name: "share-room", isPublic: true });
  await b.joinRoom(roomId);
  a.startSync();
  b.startSync();
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });
  await waitFor(() => a.getRoom(roomId) !== null && b.getRoom(roomId) !== null, 5_000, "rooms sync");

  await a.sendToDevice(b.userId!, b.deviceId ?? "", "m.call.screenshare", {
    call_id: "",
    device_id: a.deviceId,
    active: true,
  });
  await waitFor(() => received.length > 0, 5_000, "share-start signal arrives");
  assert.equal(received[0]!.sender, a.userId);
  const startContent = received[0]!.content as { device_id?: string; active?: boolean };
  assert.equal(startContent.device_id, a.deviceId);
  assert.equal(startContent.active, true);

  await a.sendToDevice(b.userId!, b.deviceId ?? "", "m.call.screenshare", {
    call_id: "",
    device_id: a.deviceId,
    active: false,
  });
  await waitFor(() => received.length > 1, 5_000, "share-stop signal arrives");
  const stopContent = received[1]!.content as { active?: boolean };
  assert.equal(stopContent.active, false);
});

test("screenshare signals ride the olm-encrypted path (encrypted room)", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  hs.registerUser("enc1", "pw1");
  hs.registerUser("enc2", "pw2");
  const a = new MatrixClient({ baseUrl: hs.baseUrl! });
  await a.loginWithPassword({ username: "enc1", password: "pw1" });
  const b = new MatrixClient({ baseUrl: hs.baseUrl! });
  await b.loginWithPassword({ username: "enc2", password: "pw2" });

  const cryptoA = new E2eeCrypto({ host: a, store: new MemoryCryptoStore() });
  await cryptoA.init();
  a.crypto = cryptoA;
  const cryptoB = new E2eeCrypto({ host: b, store: new MemoryCryptoStore() });
  await cryptoB.init();
  b.crypto = cryptoB;

  const received: { sender: string; content: Record<string, unknown> }[] = [];
  cryptoB.addPayloadListener((sender, type, content) => {
    if (type === "m.call.screenshare") received.push({ sender, content });
  });

  const roomId = await a.createRoom({ name: "enc-share", isPublic: true, encrypted: true });
  await b.joinRoom(roomId);
  a.startSync();
  b.startSync();
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });
  await waitFor(() => a.getRoom(roomId) !== null && b.getRoom(roomId) !== null, 5_000, "rooms sync");

  /* warm the olm session so encrypted signaling is possible */
  await a.sendMessage(roomId, "warm-up");
  await waitFor(
    () => (b.getRoom(roomId)?.timeline ?? []).some((i) => i.kind === "message"),
    5_000,
    "warm-up arrives"
  );

  await cryptoA.sendToDeviceEncrypted(b.userId!, b.deviceId ?? "", "m.call.screenshare", {
    call_id: "",
    device_id: a.deviceId,
    active: true,
  });
  await waitFor(() => received.length > 0, 5_000, "encrypted share signal arrives");
  assert.equal(received[0]!.sender, a.userId);
  const content = received[0]!.content as { active?: boolean };
  assert.equal(content.active, true);
});
