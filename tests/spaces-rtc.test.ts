/*
 * Grungus — space management + MatrixRTC (Element Call interop)
 * against the mock homeserver:
 *   - create a space, add/remove rooms via m.space.child state, sync
 *     reflects the changes
 *   - m.call.member parsing in BOTH formats: the MSC4143 per-device
 *     session events (what Element Call publishes today) and the legacy
 *     per-user m.calls format (js-sdk <= v33); expiry filtering and
 *     LiveKit focus extraction
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";

function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  label = "condition"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      void (async () => {
        let ok = false;
        try {
          ok = await predicate();
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
      })();
    };
    poll();
  });
}

async function makeClient(
  hs: MockHomeserver,
  username: string
): Promise<MatrixClient> {
  hs.registerUser(username, "pw");
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username, password: "pw" });
  client.startSync();
  return client;
}

/* ----------------------------- space management ------------------------- */

test("spaces: create, add a room, sync reflects it, remove", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeClient(hs, "spu");
  t.after(() => a.stopSync());

  const roomA = await a.createRoom({ name: "room-a", isPublic: true });
  const space = await a.createRoom({ name: "my-space", isPublic: true, isSpace: true });
  await waitFor(() => a.getRoom(space) !== null, 5_000, "space syncs");
  assert.equal(a.getRoom(space)!.isSpace, true, "room is a space (creation_content.type)");

  /* add room-a to the space via m.space.child state */
  await a.addToSpace(space, roomA);
  await waitFor(
    () => a.getRoom(space)?.children.has(roomA) === true,
    5_000,
    "child appears in the space"
  );

  /* another client sees the same space tree (spaces are rooms — join it) */
  const b = await makeClient(hs, "spv");
  t.after(() => b.stopSync());
  await b.joinRoom(roomA);
  await b.joinRoom(space);
  await waitFor(() => b.getRoom(space) !== null, 5_000, "b sees the space");
  await waitFor(
    () => b.getRoom(space)?.children.has(roomA) === true,
    5_000,
    "b sees the child"
  );

  /* remove it again */
  await a.removeFromSpace(space, roomA);
  await waitFor(
    () => a.getRoom(space)?.children.has(roomA) === false,
    5_000,
    "child removed from the space"
  );
});

/* ------------------------- MatrixRTC membership parsing ------------------ */

test("MatrixRTC: parses the MSC4143 per-device session format (Element Call today)", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeClient(hs, "rtc1");
  t.after(() => a.stopSync());

  const room = await a.createRoom({ name: "rtc-room", isPublic: true });
  await waitFor(() => a.getRoom(room) !== null, 5_000, "room syncs");

  /* Element Call's format: state_key = `${userId}_${deviceId}_m.call`,
     flattened session content with focus_active */
  const userId = a.userId!;
  const deviceId = a.deviceId!;
  await a.sendStateEvent(room, "m.call.member", `${userId}_${deviceId}_m.call`, {
    application: "m.call",
    call_id: "",
    scope: "m.room",
    device_id: deviceId,
    expires: 3_600_000,
    focus_active: {
      active_focus: {
        focus: "livekit",
        livekit_service_url: "https://matrixrtc.example.com/livekit/jwt",
      },
      joined_ts: Date.now(),
    },
    foci_preferred: [],
    created_ts: Date.now(),
  });

  await waitFor(
    () => (a.getRoom(room)?.rtcMemberships ?? []).length === 1,
    5_000,
    "membership parsed"
  );
  const m = a.getRoom(room)!.rtcMemberships[0]!;
  assert.equal(m.sender, userId);
  assert.equal(m.deviceId, deviceId);
  assert.equal(m.callId, "");
  assert.equal(
    m.focusUrl,
    "https://matrixrtc.example.com/livekit/jwt",
    "LiveKit focus URL extracted"
  );
  assert.ok(m.expiresTs > Date.now(), "not expired");
});

test("MatrixRTC: parses the legacy per-user m.calls format (js-sdk <= v33)", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeClient(hs, "rtc2");
  t.after(() => a.stopSync());

  const room = await a.createRoom({ name: "rtc-legacy", isPublic: true });
  await waitFor(() => a.getRoom(room) !== null, 5_000, "room syncs");

  const userId = a.userId!;
  await a.sendStateEvent(room, "m.call.member", userId, {
    "m.calls": [
      {
        "m.call_id": "group-call-1",
        "m.devices": [
          {
            device_id: "OLDDEVICE1",
            expires_ts: Date.now() + 60_000,
            foci_active: [
              { focus: "livekit", livekit_service_url: "https://old.example.com/jwt" },
            ],
          },
        ],
      },
    ],
  });

  await waitFor(
    () => (a.getRoom(room)?.rtcMemberships ?? []).length === 1,
    5_000,
    "legacy membership parsed"
  );
  const m = a.getRoom(room)!.rtcMemberships[0]!;
  assert.equal(m.sender, userId);
  assert.equal(m.deviceId, "OLDDEVICE1");
  assert.equal(m.callId, "group-call-1");
  assert.equal(m.focusUrl, "https://old.example.com/jwt");
});

test("MatrixRTC: expired memberships are dropped", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const a = await makeClient(hs, "rtc3");
  t.after(() => a.stopSync());

  const room = await a.createRoom({ name: "rtc-exp", isPublic: true });
  await waitFor(() => a.getRoom(room) !== null, 5_000, "room syncs");

  const userId = a.userId!;
  /* an expired session event (created_ts far in the past with 1s expires) */
  await a.sendStateEvent(room, "m.call.member", `${userId}_EXPIRED_m.call`, {
    application: "m.call",
    call_id: "",
    scope: "m.room",
    device_id: "EXPIRED",
    expires: 1_000,
    focus_active: {
      active_focus: { focus: "livekit", livekit_service_url: "https://x.example.com" },
      joined_ts: Date.now() - 120_000,
    },
    foci_preferred: [],
    created_ts: Date.now() - 120_000,
  });

  await waitFor(
    () => (a.getRoom(room)?.callMembers.size ?? 0) === 1,
    5_000,
    "raw membership stored"
  );
  assert.equal(
    a.getRoom(room)!.rtcMemberships.length,
    0,
    "expired membership is not offered"
  );
});
