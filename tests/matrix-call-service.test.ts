import test from "node:test";
import assert from "node:assert/strict";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { createRoomRecord, applyStateEvent } from "../src/renderer/services/matrix-rooms.ts";
import { discoverCallService, requestCallToken } from "../src/renderer/services/matrix-call-service.ts";
import { MatrixTimeline } from "../src/renderer/services/matrix-timeline.ts";

test("Element oldest-membership focus selection reads preferred foci and ignores expired sessions", () => {
  const room = createRoomRecord("!room:example.org");
  const now = Date.now();
  const add = (sender: string, created: number, service: string, expires: number) => applyStateEvent(room, {
    type: "org.matrix.msc3401.call.member", sender, origin_server_ts: created, state_key: `_${sender}_DEVICE_m.call`,
    content: { application: "m.call", scope: "m.room", call_id: "", device_id: "DEVICE", created_ts: created, expires,
      focus_active: { type: "livekit", focus_selection: "oldest_membership" },
      foci_preferred: [{ type: "livekit", livekit_service_url: service }],
    },
  });
  add("@new:example.org", now - 1000, "https://new.example.org", 60000);
  add("@expired:example.org", now - 120000, "https://expired.example.org", 60000);
  add("@older_user:example.org", now - 2000, "https://old.example.org", 60000);
  assert.equal(room.rtcMemberships.length, 2);
  assert.deepEqual(room.rtcMemberships.map(member => member.focusUrl), ["https://old.example.org", "https://old.example.org"]);
  assert.equal(room.rtcMemberships[0]?.sender, "@older_user:example.org");
});

test("empty video rooms discover a homeserver transport while active calls keep the existing backend", async () => {
  const client = new MatrixClient({ baseUrl: "https://hs.example.org" });
  const room = createRoomRecord("!room:example.org");
  let requests = 0;
  client.api = async <T>() => { requests++; return { rtc_transports: [{ type: "livekit", livekit_service_url: "https://rtc.example.org/jwt" }] } as T; };
  assert.equal(await discoverCallService(client, room), "https://rtc.example.org/jwt");
  room.rtcMemberships = [{ sender: "@friend:example.org", deviceId: "DEVICE", callId: "", expiresTs: Date.now() + 60000, focusUrl: "https://existing.example.org" }];
  assert.equal(await discoverCallService(client, room), "https://existing.example.org");
  assert.equal(requests, 1, "Joining must not choose a fresh backend");
  room.rtcMemberships[0]!.focusUrl = null;
  await assert.rejects(discoverCallService(client, room), /cannot join it using a separate call transport/);
});

test("legacy well-known discovery works and sends no session credentials", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const client = new MatrixClient({ baseUrl: "https://hs.example.org" });
  client.userId = "@user:example.org";
  client.api = async () => { throw new Error("Not implemented"); };
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://example.org/.well-known/matrix/client");
    assert.equal(init?.credentials, "omit"); assert.equal(init?.headers, undefined);
    return Response.json({ "org.matrix.msc4143.rtc_foci": [{ type: "livekit", livekit_service_url: "https://rtc.example.org" }] });
  };
  assert.equal(await discoverCallService(client, createRoomRecord("!room:example.org")), "https://rtc.example.org");
});

test("Element token authorization sends a full OpenID proof and device-specific request schemas", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const client = new MatrixClient({ baseUrl: "https://hs.example.org" });
  client.userId = "@user:example.org"; client.deviceId = "DEVICE"; client.accessToken = "private-session-token";
  const proof = { access_token: "temporary-openid-proof", matrix_server_name: "example.org", token_type: "Bearer", expires_in: 3600 };
  client.requestOpenIdToken = async () => proof;
  const requests: { url: string; body: unknown }[] = [];
  let modern = false;
  globalThis.fetch = async (input, init) => {
    const body = JSON.parse(String(init?.body)); requests.push({ url: String(input), body });
    assert.ok(!String(init?.body).includes(client.accessToken!));
    assert.deepEqual(body.openid_token, proof);
    if (String(input).endsWith("/sfu/get")) {
      assert.equal(body.device_id, "DEVICE"); assert.equal(body.room, "!room:example.org");
      if (modern) return Response.json({}, { status: 404 });
    } else {
      assert.equal(body.room_id, "!room:example.org"); assert.equal(body.slot_id, "m.call#ROOM");
      assert.deepEqual(body.member, { id: "@user:example.org:DEVICE", claimed_user_id: "@user:example.org", claimed_device_id: "DEVICE" });
    }
    return Response.json({ jwt: "livekit-jwt", url: "wss://sfu.example.org" });
  };
  assert.equal((await requestCallToken(client, "!room:example.org", "https://rtc.example.org")).token, "livekit-jwt");
  modern = true;
  await requestCallToken(client, "!room:example.org", "https://rtc.example.org");
  assert.equal(requests.at(-1)?.url, "https://rtc.example.org/get_token");
});

test("Element call notifications and call membership activity remain visible without replaying historical signaling", () => {
  const room = createRoomRecord("!room:example.org");
  let signals = 0;
  const timeline = new MatrixTimeline({ userId: "@me:example.org", crypto: null, onCallEvent: () => { signals++; }, getRoom: () => room, handleMediaKeys: () => {}, notify: () => {}, notifyRooms: () => {} });
  const event = { sender: "@friend:example.org", content: {}, event_id: "$call", origin_server_ts: 123 };
  const notification = timeline.toItem(room, { ...event, type: "org.matrix.msc4075.call.notify" }, true);
  assert.equal(notification?.kind, "system");
  assert.ok(notification?.kind === "system" && notification.callActivity === "started");
  const historical = timeline.toItem(room, { ...event, type: "m.call.invite" }, true);
  assert.ok(historical?.kind === "system" && historical.text.includes("Call started"));
  assert.equal(signals, 0);
  timeline.toItem(room, { ...event, type: "m.call.invite" }); assert.equal(signals, 1);
});

test("video rooms and Element call history never fall into an unrelated legacy call", async () => {
  const { selectCallBackend } = await import("../src/renderer/services/matrix-call-service.ts");
  const client = new MatrixClient({ baseUrl: "https://hs.example.org" });
  const room = createRoomRecord("!room:example.org");
  room.joinedMemberCount = 2;
  room.roomType = "io.element.video";
  assert.equal((await selectCallBackend(client, room)).kind, "livekit");
  room.roomType = null;
  room.timeline = [{ kind: "system", id: "$notification", ts: 0, text: "Call started", callActivity: "started", matrixRtc: true }];
  assert.equal((await selectCallBackend(client, room)).kind, "livekit");
  room.timeline = []; room.isDirect = true;
  assert.equal((await selectCallBackend(client, room)).kind, "p2p");
  room.isDirect = false;
  client.api = async <T>() => ({ rtc_transports: [{ type: "livekit", livekit_service_url: "https://rtc.example.org" }] }) as T;
  assert.equal((await selectCallBackend(client, room)).kind, "livekit", "A two-person text room with MatrixRTC must not become a legacy DM call");
});

test("authorization errors surface without trying other endpoints or exposing session tokens", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  const client = new MatrixClient({ baseUrl: "https://hs.example.org" });
  client.requestOpenIdToken = async () => ({ access_token: "openid", matrix_server_name: "example.org", token_type: "Bearer", expires_in: 3600 });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: "Room access denied" }, { status: 403 }); };
  await assert.rejects(requestCallToken(client, "!room:example.org", "https://rtc.example.org"), /Room access denied/);
  assert.equal(calls, 1);
});
