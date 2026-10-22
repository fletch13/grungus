/*
 * Grungus — typing notifications and media sending, against the mock
 * homeserver.
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

function makeUser(hs: MockHomeserver, name: string, password: string): Promise<MatrixClient> {
  hs.registerUser(name, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  return client.loginWithPassword({ username: name, password }).then(() => client);
}

test("typing state round-trips through sync ephemeral", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeUser(hs, "tia", "pw1");
  const b = await makeUser(hs, "uri", "pw2");
  const roomId = await a.createRoom({ name: "typing-room", isPublic: true });
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

  assert.deepEqual(b.getRoom(roomId)!.typingUsers, []);

  await a.setTyping(roomId, true);
  await waitFor(
    () => b.getRoom(roomId)!.typingUsers.includes(a.userId!),
    5_000,
    "b sees a typing"
  );

  await a.setTyping(roomId, false);
  await waitFor(
    () => b.getRoom(roomId)!.typingUsers.length === 0,
    5_000,
    "typing cleared"
  );
});

test("media: upload, send, receive metadata, download round-trip", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeUser(hs, "mel", "pw1");
  const b = await makeUser(hs, "nora", "pw2");
  const roomId = await a.createRoom({ name: "media-room", isPublic: true });
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

  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
  const mxc = await a.uploadMedia("test.png", "image/png", bytes);
  assert.ok(mxc.startsWith("mxc://mock.hs/"), "upload returns an mxc URI");
  assert.equal(hs.media.get(mxc.slice("mxc://mock.hs/".length))?.bytes.length, bytes.length);

  await a.sendMedia(roomId, {
    mxc,
    name: "test.png",
    mimeType: "image/png",
    size: bytes.length,
    width: 64,
    height: 64,
  });

  await waitFor(
    () =>
      (b.getRoom(roomId)?.timeline ?? []).some(
        (item): item is MessageItem =>
          item.kind === "message" && item.media !== null && item.media.mimetype === "image/png"
      ),
    5_000,
    "b receives the image metadata"
  );

  const item = b
    .getRoom(roomId)!
    .timeline.find(
      (entry): entry is MessageItem => entry.kind === "message" && entry.media !== null
    )!;
  assert.equal(item.media!.mxc, mxc);
  assert.equal(item.media!.width, 64);
  assert.equal(item.media!.name, "test.png");

  /* B can fetch the media back through the authenticated download */
  const src = await b.crypto === undefined ? null : null; /* crypto not attached here */
  void src;
  const downloadUrl =
    hs.baseUrl! +
    "/_matrix/media/v3/download/" +
    encodeURIComponent("mock.hs") +
    "/" +
    encodeURIComponent(mxc.slice("mxc://mock.hs/".length));
  const res = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${b.accessToken}` },
  });
  assert.equal(res.status, 200);
  const roundTrip = new Uint8Array(await res.arrayBuffer());
  assert.equal(roundTrip.length, bytes.length);
  assert.deepEqual([...roundTrip], [...bytes], "bytes survive the round trip");
  for (const [name, mimeType, msgtype] of [["Schicksalsschlag.webm", "video/webm", "m.video"], ["no-mime.webm", "", "m.video"], ["voice.ogg", "audio/ogg", "m.audio"], ["notes.pdf", "application/pdf", "m.file"]]) {
    await a.uploadAndSendMedia(roomId, name!, mimeType!, bytes);
    await waitFor(() => b.getRoom(roomId)!.timeline.some(entry => entry.kind === "message" && entry.body === name), 5000, `receive ${name}`);
    const received = b.getRoom(roomId)!.timeline.find(entry => entry.kind === "message" && entry.body === name) as MessageItem;
    assert.equal(received.msgtype, msgtype); assert.equal(received.media?.name, name); assert.equal(received.media?.mimetype, mimeType || "video/webm");
    assert.ok(received.media?.mxc, "Attachments must retain downloadable media metadata instead of a text placeholder");
  }

});
