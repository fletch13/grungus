/*
 * Grungus — LiveKit-path E2EE media (Element interop).
 *
 *   - key-event content matches the js-sdk's exact shape
 *     (io.element.call.encryption_keys with unpadded url-safe base64 keys)
 *   - rotation: indexes only grow, old keys retained for decrypt
 *   - transport: A's key event (Megolm-wrapped in an encrypted room)
 *     reaches B through MatrixClient.onMediaKeys with the same bytes
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ELEMENT_ENCRYPTION_KEYS_TYPE,
  encodeKeyMaterial,
  decodeKeyMaterial,
  buildEncryptionKeysEvent,
  buildEncryptionKeysToDeviceEvent,
  parseEncryptionKeysToDeviceEvent,
  KeyRotation,
} from "../src/renderer/services/lk-e2ee.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { MockHomeserver } from "./mock-homeserver.ts";
import { E2eeCrypto, MemoryCryptoStore } from "../src/renderer/services/e2ee.ts";

test("key material round-trips through Element's base64 encoding", () => {
  const bytes = new Uint8Array(16).map((_, i) => (i * 7 + 3) & 0xff);
  const encoded = encodeKeyMaterial(bytes);
  /* url-safe and unpadded, like secureRandomBase64Url in the js-sdk */
  assert.ok(!encoded.includes("+"));
  assert.ok(!encoded.includes("/"));
  assert.ok(!encoded.includes("="));
  const decoded = decodeKeyMaterial(encoded);
  assert.deepEqual([...decoded], [...bytes]);
  /* tolerant: standard base64 with padding also decodes */
  const standard = Buffer.from(bytes).toString("base64");
  assert.deepEqual([...decodeKeyMaterial(standard)], [...bytes]);
});

test("the to-device key event matches the current js-sdk's shape", () => {
  /* pinned js-sdk ToDeviceKeyTransport: single media_key plus the
     deprecated keys/member fields for older receivers */
  const content = buildEncryptionKeysToDeviceEvent(
    "!room:hs",
    "@user:hs",
    "DEVICEA",
    3,
    "KEYB64"
  );
  assert.deepEqual(content, {
    room_id: "!room:hs",
    member_id: "@user:hs",
    media_key: { index: 3, key: "KEYB64" },
    keys: { index: 3, key: "KEYB64" },
    member: { claimed_device_id: "DEVICEA", id: "@user:hs" },
  });
  /* parse: media_key wins, `keys` is the fallback, junk is rejected */
  assert.deepEqual(parseEncryptionKeysToDeviceEvent(content), { index: 3, key: "KEYB64" });
  assert.deepEqual(parseEncryptionKeysToDeviceEvent({ keys: { index: 0, key: "OLD" } }), {
    index: 0,
    key: "OLD",
  });
  assert.equal(parseEncryptionKeysToDeviceEvent({ media_key: { index: 1, key: "" } }), null);
  assert.equal(parseEncryptionKeysToDeviceEvent({}), null);
});

test("the key event matches the js-sdk's content shape", () => {
  const content = buildEncryptionKeysEvent(
    [
      { index: 0, key: "AAA" },
      { index: 1, key: "BBB" },
    ],
    "MOCK_DEVICE"
  );
  assert.deepEqual(content, {
    keys: [
      { index: 0, key: "AAA" },
      { index: 1, key: "BBB" },
    ],
    device_id: "MOCK_DEVICE",
    call_id: "",
  });
  assert.equal(ELEMENT_ENCRYPTION_KEYS_TYPE, "io.element.call.encryption_keys");
});

test("rotation issues growing indexes and keeps old keys decryptable", () => {
  const rotation = new KeyRotation();
  const first = rotation.next();
  assert.equal(first.index, 0);
  assert.equal(first.bytes.length, 16, "16-byte key like Element's");
  const second = rotation.next();
  assert.equal(second.index, 1);
  assert.notEqual(first.key, second.key, "a rotation must change the key");
  /* the resend event carries the FULL key set — receivers keep every
     index so late frames under an old index still decrypt */
  assert.deepEqual(
    rotation.all().map((k) => k.index),
    [0, 1]
  );
});

test("key events ride Megolm and reach the other participant", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  hs.registerUser("ea", "pw1");
  hs.registerUser("eb", "pw2");
  const a = new MatrixClient({ baseUrl: hs.baseUrl! });
  const b = new MatrixClient({ baseUrl: hs.baseUrl! });
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });
  await a.loginWithPassword({ username: "ea", password: "pw1" });
  await b.loginWithPassword({ username: "eb", password: "pw2" });

  /* both sides get the E2EE layer (same harness as the e2ee suite) */
  a.crypto = new E2eeCrypto({ host: a, store: new MemoryCryptoStore() });
  b.crypto = new E2eeCrypto({ host: b, store: new MemoryCryptoStore() });
  await a.crypto.init();
  await b.crypto.init();

  /* sync BEFORE the encrypted send: the send path reads room.isEncrypted
     from the synced state (fail-closed for unknown rooms) */
  a.startSync();
  b.startSync();
  const roomId = await a.createRoom({ name: "e2ee-keys", isPublic: true, encrypted: true });
  await b.joinRoom(roomId);
  await new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      const roomA = a.getRoom(roomId);
      const roomB = b.getRoom(roomId);
      if (roomA && roomB) {
        if (roomA.isEncrypted && roomB.isEncrypted) resolve();
        else if (Date.now() - start > 8000) reject(new Error("rooms not encrypted"));
        else setTimeout(poll, 25);
      } else if (Date.now() - start > 8000) {
        reject(new Error("rooms never synced"));
      } else setTimeout(poll, 25);
    };
    poll();
  });

  /* B listens for media keys */
  const received: Array<{ sender: string; keys: Array<{ index: number; key: string }> }> = [];
  b.onMediaKeys((event) => {
    received.push({ sender: event.sender, keys: event.keys });
  });

  /* A distributes its key exactly like the LiveKit E2EE layer does */
  const rotation = new KeyRotation();
  const own = rotation.next();
  const eventId = await a.sendRoomEvent(
    roomId,
    ELEMENT_ENCRYPTION_KEYS_TYPE,
    buildEncryptionKeysEvent(rotation.all(), a.deviceId ?? "")
  );
  assert.ok(eventId, "the key event landed on the server");

  await new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      if (received.length > 0) resolve();
      else if (Date.now() - start > 5000) reject(new Error("key event never arrived"));
      else setTimeout(poll, 25);
    };
    poll();
  });

  assert.equal(received[0]!.sender, a.userId);
  assert.equal(received[0]!.keys.length, 1);
  assert.equal(received[0]!.keys[0]!.index, 0);
  assert.equal(received[0]!.keys[0]!.key, own.key, "B decrypted the exact key A sent");

  /* the key event never shows up as a timeline item */
  const roomB = b.getRoom(roomId)!;
  assert.ok(
    roomB.timeline.every(
      (item) => item.kind !== "system" || !item.text.includes("encryption_keys")
    ),
    "key events stay out of the timeline"
  );

  /* and on the wire it is Megolm-wrapped: the mock stored it as m.room.encrypted */
  const stored = hs.rooms.get(roomId)?.events.find(
    (ev) => ev.event_id === eventId
  );
  assert.equal(stored?.type, "m.room.encrypted", "the homeserver only sees ciphertext");
});
