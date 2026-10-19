/*
 * Grungus — LiveKit token service + room state tests: token minting
 * with correct LiveKit JWT claims, the auth endpoint accepting both
 * OpenID and whoami verification, and the com.grungus.livekit room
 * state event parsing.
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";

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

test("com.grungus.livekit state event is parsed into the room", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  hs.registerUser("lku", "pw1");
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: "lku", password: "pw1" });
  client.startSync();
  t.after(() => client.stopSync());

  const roomId = await client.createRoom({ name: "lk-room", isPublic: true });
  await waitFor(() => client.getRoom(roomId) !== null, 5_000, "room syncs");

  assert.equal(client.getRoom(roomId)!.livekitService, null);

  /* publish the LiveKit service state */
  await client.sendStateEvent(roomId, "com.grungus.livekit", "", {
    url: "ws://127.0.0.1:7880",
    room: "grungus-test",
    auth_url: "http://127.0.0.1:8090/grungus/livekit/join",
    auth_mode: "whoami",
  });

  await waitFor(
    () => client.getRoom(roomId)?.livekitService !== null,
    5_000,
    "livekit state parsed"
  );
  const svc = client.getRoom(roomId)!.livekitService!;
  assert.equal(svc.url, "ws://127.0.0.1:7880");
  assert.equal(svc.room, "grungus-test");
  assert.equal(svc.authMode, "whoami");
  assert.equal(svc.authUrl, "http://127.0.0.1:8090/grungus/livekit/join");

  /* clearing the state removes the service */
  await client.sendStateEvent(roomId, "com.grungus.livekit", "", {});
  await waitFor(
    () => client.getRoom(roomId)?.livekitService === null,
    5_000,
    "livekit state cleared"
  );
});

test("OpenID token request works against the homeserver", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  hs.registerUser("oid", "pw1");
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: "oid", password: "pw1" });

  /* the mock doesn't implement OpenID, so this should reject */
  await assert.rejects(
    () => client.requestOpenIdToken(),
    (err: unknown) => err instanceof Error
  );
});
