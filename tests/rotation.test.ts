/*
 * Grungus — megolm key rotation on membership change, against the mock
 * homeserver.
 *
 * A member who joins an encrypted room can read messages sent after the
 * join (fresh session shared with them) but NOT the pre-join history
 * (old session never shared, forwarding declined for unverified peers).
 * A member who leaves cannot read messages sent after the leave.
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient, type MessageItem } from "../src/renderer/services/matrix-client.ts";
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

async function makeCryptoClient(
  hs: MockHomeserver,
  username: string,
  password: string
): Promise<MatrixClient> {
  hs.registerUser(username, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username, password });
  const crypto = new E2eeCrypto({ host: client, store: new MemoryCryptoStore() });
  await crypto.init();
  client.crypto = crypto;
  return client;
}

function bodies(client: MatrixClient, roomId: string): string[] {
  return (client.getRoom(roomId)?.timeline ?? [])
    .filter((item): item is MessageItem => item.kind === "message")
    .map((item) => item.body);
}

function utdCount(client: MatrixClient, roomId: string): number {
  return (client.getRoom(roomId)?.timeline ?? []).filter(
    (item) => item.kind === "system" && item.text.includes("Unable to decrypt")
  ).length;
}

test("rotation: joiner reads post-join messages but not pre-join history", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeCryptoClient(hs, "rot_a", "pw1");
  a.startSync();
  t.after(() => a.stopSync());

  const roomId = await a.createRoom({
    name: "rot-room",
    isPublic: true,
    encrypted: true,
  });
  await waitFor(() => a.getRoom(roomId) !== null, 5_000, "room syncs");
  await a.sendMessage(roomId, "before-join");
  await waitFor(
    () => bodies(a, roomId).includes("before-join"),
    5_000,
    "sender sees own message"
  );

  const b = await makeCryptoClient(hs, "rot_b", "pw2");
  b.startSync();
  t.after(() => b.stopSync());
  await b.joinRoom(roomId);

  /* wait for the sender's client to process the join (rotation) */
  await waitFor(
    () => a.getRoom(roomId)?.members.get(b.userId ?? "")?.membership === "join",
    8_000,
    "sender sees the join"
  );

  /* the join rotates the sender's outbound session — this next message
     uses a fresh session that includes B */
  await a.sendMessage(roomId, "after-join");
  await waitFor(
    () => bodies(b, roomId).includes("after-join"),
    8_000,
    "joiner reads the post-join message"
  );

  /* the pre-join message must stay undecryptable: B never received that
     session's key, and forwarding is declined (B is unverified) */
  await new Promise((r) => setTimeout(r, 1_500));
  assert.ok(
    !bodies(b, roomId).includes("before-join"),
    "joiner cannot read pre-join history"
  );
  assert.ok(utdCount(b, roomId) >= 1, "pre-join message stays UTD");

  /* and the sender's own view is unaffected */
  assert.ok(bodies(a, roomId).includes("after-join"));
  assert.ok(bodies(a, roomId).includes("before-join"));
});

test("rotation: a leaving member cannot read future messages", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeCryptoClient(hs, "lv_a", "pw1");
  const b = await makeCryptoClient(hs, "lv_b", "pw2");
  a.startSync();
  b.startSync();
  t.after(() => {
    a.stopSync();
    b.stopSync();
  });

  const roomId = await a.createRoom({
    name: "leave-room",
    isPublic: true,
    encrypted: true,
  });
  await waitFor(() => a.getRoom(roomId) !== null, 5_000, "room syncs");
  await b.joinRoom(roomId);
  /* wait for the sender to process the join (rotation) before sending */
  await waitFor(
    () => a.getRoom(roomId)?.members.get(b.userId ?? "")?.membership === "join",
    8_000,
    "sender sees the join"
  );
  await a.sendMessage(roomId, "while-joined");
  await waitFor(
    () => bodies(b, roomId).includes("while-joined"),
    8_000,
    "member reads messages while joined"
  );

  await b.leaveRoom(roomId);
  /* wait for the sender's client to process the leave (rotation), then
     send a message B must never be able to read */
  await waitFor(
    () => {
      const member = a.getRoom(roomId)?.members.get(b.userId ?? "");
      return member?.membership === "leave";
    },
    8_000,
    "sender sees the leave"
  );
  await a.sendMessage(roomId, "after-leave");

  await waitFor(
    () => {
      const room = a.getRoom(roomId);
      return !!room && bodies(a, roomId).includes("after-leave");
    },
    8_000,
    "sender's own view is fine"
  );
  await new Promise((r) => setTimeout(r, 1_500));
  assert.ok(
    !bodies(b, roomId).includes("after-leave"),
    "former member cannot read post-leave messages"
  );
});
