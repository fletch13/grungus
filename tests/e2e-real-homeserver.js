#!/usr/bin/env node
/*
 * Grungus — end-to-end test against a REAL Matrix homeserver.
 *
 * Not part of `npm test` (which uses the in-repo mock homeserver).
 * Point it at any homeserver with registration enabled, e.g. conduwuit:
 *
 *   GRUNGUS_E2E_HOMESERVER=http://127.0.0.1:8008 \
 *   GRUNGUS_E2E_USER1=grungus_a GRUNGUS_E2E_PASS1=secret-one \
 *   GRUNGUS_E2E_USER2=grungus_b GRUNGUS_E2E_PASS2=secret-two \
 *   GRUNGUS_E2E_REGISTER=1 \
 *   node tests/e2e-real-homeserver.js
 *
 * If the accounts already exist, drop GRUNGUS_E2E_REGISTER and it just
 * logs in. On Synapse, registration goes through user-interactive auth
 * with a shared secret — pre-create users with register_new_matrix_user
 * and run without GRUNGUS_E2E_REGISTER.
 */
"use strict";

const assert = require("node:assert");
const { MatrixClient } = require("../src/renderer/services/matrix-client.js");

const HOME = process.env.GRUNGUS_E2E_HOMESERVER || "";
const USER1 = process.env.GRUNGUS_E2E_USER1 || "grungus_a";
const PASS1 = process.env.GRUNGUS_E2E_PASS1 || "";
const USER2 = process.env.GRUNGUS_E2E_USER2 || "grungus_b";
const PASS2 = process.env.GRUNGUS_E2E_PASS2 || "";
const REGISTER = process.env.GRUNGUS_E2E_REGISTER === "1";
const SERVER_NAME = process.env.GRUNGUS_E2E_SERVER_NAME || "";
const WAIT_MS = Number(process.env.GRUNGUS_E2E_WAIT_MS || 15000);

function log() {
  console.log.apply(console, ["[e2e]"].concat([].slice.call(arguments)));
}

function fail(message) {
  console.error("[e2e] FAIL: " + message);
  process.exit(1);
}

function waitFor(predicate, label) {
  return new Promise(function (resolve, reject) {
    const start = Date.now();
    const poll = () => {
      let ok = false;
      try {
        ok = predicate();
      } catch (e) {
        return reject(e);
      }
      if (ok) return resolve();
      if (Date.now() - start > WAIT_MS) {
        return reject(new Error("Timed out waiting for: " + label));
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

async function api(method, path, opts) {
  opts = opts || {};
  const headers = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = "Bearer " + opts.token;
  const res = await fetch(HOME + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

/** Register a user through Matrix's User-Interactive Auth. */
async function register(username, password) {
  const first = await api("POST", "/_matrix/client/v3/register", { body: {} });
  const flows = [];
  ((first.data && first.data.flows) || []).forEach((f) => {
    (f.stages || []).forEach((s) => flows.push(s));
  });
  const session = first.data && first.data.session;
  let auth;
  if (flows.indexOf("m.login.dummy") !== -1) {
    auth = { type: "m.login.dummy" };
  } else if (flows.indexOf("m.login.registration_token") !== -1) {
    const token = process.env.GRUNGUS_E2E_REGISTRATION_TOKEN;
    if (!token) {
      fail("homeserver requires a registration token: set GRUNGUS_E2E_REGISTRATION_TOKEN");
    }
    auth = { type: "m.login.registration_token", registration_token: token };
  } else if (first.status === 200) {
    return first.data; /* server registered without UIA */
  } else {
    fail("unsupported registration flows: " + JSON.stringify(flows));
  }
  if (session) auth.session = session;
  const res = await api("POST", "/_matrix/client/v3/register", {
    body: { username, password, auth, inhibit_login: false },
  });
  if (res.status === 200) return res.data;
  const errcode = res.data && res.data.errcode;
  if (errcode === "M_USER_IN_USE") return { existed: true };
  fail("register failed for " + username + ": " + JSON.stringify(res.data));
}

async function ensureUser(username, password) {
  const res = await register(username, password);
  if (res && res.existed) log("user already exists:", username);
  else log("registered:", (res && res.user_id) || username);
}

function timelineHas(client, roomId, body) {
  const room = client.getRoom(roomId);
  if (!room) return false;
  return room.timeline.some(
    (i) => i.kind === "message" && i.body === body && !i.failed
  );
}

async function main() {
  if (!HOME) {
    console.log(
      "[e2e] SKIPPED: set GRUNGUS_E2E_HOMESERVER (and GRUNGUS_E2E_REGISTER=1) to run."
    );
    return;
  }
  if (!PASS1 || !PASS2) fail("set GRUNGUS_E2E_PASS1 and GRUNGUS_E2E_PASS2");

  const versions = await api("GET", "/_matrix/client/versions");
  if (versions.status !== 200) fail("homeserver not reachable at " + HOME);
  log(
    "homeserver reachable; versions:",
    JSON.stringify((versions.data.versions || []).slice(0, 4))
  );

  if (REGISTER) {
    await ensureUser(USER1, PASS1);
    await ensureUser(USER2, PASS2);
  }

  const a = new MatrixClient({ baseUrl: HOME });
  const b = new MatrixClient({ baseUrl: HOME });
  await a.loginWithPassword({ username: USER1, password: PASS1 });
  await b.loginWithPassword({ username: USER2, password: PASS2 });
  log("logged in as", a.userId, "and", b.userId);

  const stamp = Date.now();
  const roomId = await a.createRoom({ name: "grungus-e2e-" + stamp, isPublic: true });
  log("created public room:", roomId);
  await b.joinRoom(roomId);

  a.startSync();
  b.startSync();

  await waitFor(() => a.getRoom(roomId) && b.getRoom(roomId), "rooms visible to both");
  assert.strictEqual(a.getRoom(roomId).joinedMemberCount, 2);
  log("room joined by both users; member count = 2 ✓");

  /* 1. bidirectional message delivery via /sync */
  const bodyA = "hello from " + USER1;
  await a.sendMessage(roomId, bodyA);
  await waitFor(() => timelineHas(b, roomId, bodyA), "b receives a's message");
  log("message " + USER1 + " → " + USER2 + " delivered over /sync ✓");

  const bodyB = "hello from " + USER2;
  await b.sendMessage(roomId, bodyB);
  await waitFor(() => timelineHas(a, roomId, bodyB), "a receives b's message");
  log("message " + USER2 + " → " + USER1 + " delivered over /sync ✓");

  await waitFor(
    () => {
      const items = a
        .getRoom(roomId)
        .timeline.filter((i) => i.kind === "message" && i.body === bodyA);
      return items.length === 1 && !items[0].pending && !items[0].txnId;
    },
    "local echo reconciled with the server event"
  );
  log("local echo replaced by the real event (no duplicates) ✓");

  /* 2. unnamed 1:1 room resolves as a direct message */
  const dmId = await a.createRoom({ isPublic: true }); /* no name: 1:1 */
  await b.joinRoom(dmId);
  await waitFor(() => a.getRoom(dmId) && a.getRoom(dmId).isDirect, "DM resolution");
  assert.strictEqual(a.getRoom(dmId).directUserId, b.userId);
  log("unnamed 1:1 room resolves as DM with", a.getRoom(dmId).title, "✓");

  /* 3. space with a child room (state event set directly, as the app UI
        for space management is still on the roadmap) */
  const via = SERVER_NAME || new URL(HOME).host;
  const spaceId = await a.createRoom({
    name: "grungus-space-" + stamp,
    isPublic: true,
    isSpace: true,
  });
  const putChild = await api(
    "PUT",
    "/_matrix/client/v3/rooms/" +
      encodeURIComponent(spaceId) +
      "/state/m.space.child/" +
      encodeURIComponent(roomId),
    { token: a.accessToken, body: { via: [via] } }
  );
  if (putChild.status !== 200) {
    fail("m.space.child failed: " + JSON.stringify(putChild.data));
  }
  await waitFor(
    () => {
      const space = a.getSpaces().find((s) => s.id === spaceId);
      return space && space.children.has(roomId);
    },
    "space + child visible to the client"
  );
  log("space with child room visible to the client ✓");

  a.stopSync();
  b.stopSync();
  log("ALL E2E CHECKS PASSED against", HOME);
  process.exit(0);
}

main().catch((e) => fail((e && e.stack) || e));
