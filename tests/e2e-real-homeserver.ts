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
 *   node tests/e2e-real-homeserver.ts
 *
 * If the accounts already exist, drop GRUNGUS_E2E_REGISTER and it just
 * logs in. On Synapse, registration goes through user-interactive auth
 * with a shared secret — pre-create users with register_new_matrix_user
 * and run without GRUNGUS_E2E_REGISTER.
 */
import assert from "node:assert/strict";
import {
  MatrixClient,
  type MessageItem,
  type Room,
} from "../src/renderer/services/matrix-client.ts";
import {
  E2eeCrypto,
  MemoryCryptoStore,
} from "../src/renderer/services/e2ee.ts";

const HOME = process.env.GRUNGUS_E2E_HOMESERVER ?? "";
const USER1 = process.env.GRUNGUS_E2E_USER1 ?? "grungus_a";
const PASS1 = process.env.GRUNGUS_E2E_PASS1 ?? "";
const USER2 = process.env.GRUNGUS_E2E_USER2 ?? "grungus_b";
const PASS2 = process.env.GRUNGUS_E2E_PASS2 ?? "";
const REGISTER = process.env.GRUNGUS_E2E_REGISTER === "1";
const SERVER_NAME = process.env.GRUNGUS_E2E_SERVER_NAME ?? "";
const WAIT_MS = Number(process.env.GRUNGUS_E2E_WAIT_MS ?? "15000");

function log(...args: unknown[]): void {
  console.log("[e2e]", ...args);
}

function fail(message: string): never {
  console.error("[e2e] FAIL: " + message);
  process.exit(1);
}

function waitFor(predicate: () => boolean, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      let ok = false;
      try {
        ok = predicate();
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() - start > WAIT_MS) {
        reject(new Error(`Timed out waiting for: ${label}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

interface ApiResult {
  status: number;
  data: Record<string, unknown>;
}

async function api(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {}
): Promise<ApiResult> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(HOME + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, data };
}

/** Register a user through Matrix's User-Interactive Auth. */
async function register(username: string, password: string): Promise<void> {
  const first = await api("POST", "/_matrix/client/v3/register", { body: {} });
  const flows: string[] = [];
  for (const flow of (first.data.flows as { stages?: string[] }[] | undefined) ?? []) {
    for (const stage of flow.stages ?? []) flows.push(stage);
  }
  const session = first.data.session as string | undefined;
  let auth: Record<string, unknown>;
  if (flows.includes("m.login.dummy")) {
    auth = { type: "m.login.dummy" };
  } else if (flows.includes("m.login.registration_token")) {
    const token = process.env.GRUNGUS_E2E_REGISTRATION_TOKEN;
    if (!token) {
      fail("homeserver requires a registration token: set GRUNGUS_E2E_REGISTRATION_TOKEN");
    }
    auth = { type: "m.login.registration_token", registration_token: token };
  } else if (first.status === 200) {
    return; /* server registered without UIA */
  } else {
    fail(`unsupported registration flows: ${JSON.stringify(flows)}`);
  }
  if (session) auth.session = session;
  const res = await api("POST", "/_matrix/client/v3/register", {
    body: { username, password, auth, inhibit_login: false },
  });
  if (res.status === 200) {
    log("registered:", res.data.user_id);
    return;
  }
  if (res.data.errcode === "M_USER_IN_USE") {
    log("user already exists:", username);
    return;
  }
  fail(`register failed for ${username}: ${JSON.stringify(res.data)}`);
}

function timelineHas(client: MatrixClient, roomId: string, body: string): boolean {
  const room = client.getRoom(roomId);
  if (!room) return false;
  return room.timeline.some(
    (item) =>
      item.kind === "message" && (item as MessageItem).body === body && !item.failed
  );
}

async function main(): Promise<void> {
  if (!HOME) {
    console.log(
      "[e2e] SKIPPED: set GRUNGUS_E2E_HOMESERVER (and GRUNGUS_E2E_REGISTER=1) to run."
    );
    return;
  }
  if (!PASS1 || !PASS2) fail("set GRUNGUS_E2E_PASS1 and GRUNGUS_E2E_PASS2");

  const versions = await api("GET", "/_matrix/client/versions");
  if (versions.status !== 200) fail(`homeserver not reachable at ${HOME}`);
  log(
    "homeserver reachable; versions:",
    JSON.stringify((versions.data.versions as string[] | undefined)?.slice(0, 4))
  );

  if (REGISTER) {
    await register(USER1, PASS1);
    await register(USER2, PASS2);
  }

  const a = new MatrixClient({ baseUrl: HOME });
  const b = new MatrixClient({ baseUrl: HOME });
  await a.loginWithPassword({ username: USER1, password: PASS1 });
  await b.loginWithPassword({ username: USER2, password: PASS2 });
  log("logged in as", a.userId, "and", b.userId);

  /* attach the E2EE layer (same wiring app.ts performs) — this exercises
     device key upload + signatures against the real homeserver */
  const cryptoA = new E2eeCrypto({ host: a, store: new MemoryCryptoStore() });
  await cryptoA.init();
  a.crypto = cryptoA;
  const cryptoB = new E2eeCrypto({ host: b, store: new MemoryCryptoStore() });
  await cryptoB.init();
  b.crypto = cryptoB;
  log("E2EE devices initialized and keys uploaded ✓");

  const stamp = Date.now();
  const roomId = await a.createRoom({ name: `grungus-e2e-${stamp}`, isPublic: true });
  log("created public room:", roomId);
  await b.joinRoom(roomId);

  a.startSync();
  b.startSync();

  await waitFor(
    () => a.getRoom(roomId) !== null && b.getRoom(roomId) !== null,
    "rooms visible to both"
  );
  const roomA = a.getRoom(roomId)!;
  assert.equal(roomA.joinedMemberCount, 2);
  log("room joined by both users; member count = 2 ✓");

  /* 1. bidirectional message delivery via /sync */
  const bodyA = `hello from ${USER1}`;
  await a.sendMessage(roomId, bodyA);
  await waitFor(() => timelineHas(b, roomId, bodyA), "b receives a's message");
  log(`message ${USER1} → ${USER2} delivered over /sync ✓`);

  const bodyB = `hello from ${USER2}`;
  await b.sendMessage(roomId, bodyB);
  await waitFor(() => timelineHas(a, roomId, bodyB), "a receives b's message");
  log(`message ${USER2} → ${USER1} delivered over /sync ✓`);

  await waitFor(
    () => {
      const room = a.getRoom(roomId)!;
      const items = room.timeline.filter(
        (item): item is MessageItem =>
          item.kind === "message" && item.body === bodyA
      );
      return items.length === 1 && !items[0]!.pending && !items[0]!.txnId;
    },
    "local echo reconciled with the server event"
  );
  log("local echo replaced by the real event (no duplicates) ✓");

  /* 2. unnamed 1:1 room resolves as a direct message */
  const dmId = await a.createRoom({ isPublic: true }); /* no name: 1:1 */
  await b.joinRoom(dmId);
  await waitFor(
    () => {
      const dm = a.getRoom(dmId);
      return dm !== null && dm.isDirect;
    },
    "DM resolution"
  );
  const dmRoom: Room = a.getRoom(dmId)!;
  assert.equal(dmRoom.directUserId, b.userId);
  log("unnamed 1:1 room resolves as DM with", dmRoom.title, "✓");

  /* 3. space with a child room (state event set directly, as the app UI
        for space management is still on the roadmap) */
  const via = SERVER_NAME || new URL(HOME).host;
  const spaceId = await a.createRoom({
    name: `grungus-space-${stamp}`,
    isPublic: true,
    isSpace: true,
  });
  const putChild = await api(
    "PUT",
    `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(roomId)}`,
    { token: a.accessToken ?? "", body: { via: [via] } }
  );
  if (putChild.status !== 200) {
    fail(`m.space.child failed: ${JSON.stringify(putChild.data)}`);
  }
  await waitFor(
    () => {
      const space = a.getSpaces().find((candidate) => candidate.id === spaceId);
      return space !== undefined && space.children.has(roomId);
    },
    "space + child visible to the client"
  );
  log("space with child room visible to the client ✓");

  /* 4. E2EE: megolm-encrypted room against the REAL homeserver */
  const encRoomId = await a.createRoom({
    name: `grungus-e2ee-${stamp}`,
    isPublic: true,
    encrypted: true,
  });
  await b.joinRoom(encRoomId);
  await waitFor(
    () =>
      a.getRoom(encRoomId)?.isEncrypted === true &&
      b.getRoom(encRoomId)?.isEncrypted === true,
    "both clients see the room as encrypted"
  );
  log("encrypted room created and joined ✓");

  const secret = `secret-${stamp}-via-e2ee`;
  const secretEventId = await a.sendMessage(encRoomId, secret);
  await waitFor(
    () =>
      (b.getRoom(encRoomId)?.timeline ?? []).some(
        (item) => item.kind === "message" && (item as MessageItem).body === secret
      ),
    "b decrypts a's encrypted message"
  );
  log("encrypted message decrypted by the other client ✓");

  /* the server never saw the plaintext: fetch the raw event back */
  if (secretEventId) {
    const raw = await api(
      "GET",
      `/_matrix/client/v3/rooms/${encodeURIComponent(encRoomId)}/event/${encodeURIComponent(secretEventId)}`,
      { token: a.accessToken ?? "" }
    );
    if (raw.status !== 200) {
      fail(`could not fetch raw event: ${JSON.stringify(raw.data)}`);
    }
    const rawContent = JSON.stringify(raw.data.content ?? {});
    assert.ok(rawContent.includes("m.megolm.v1.aes-sha2"), "stored event is megolm");
    assert.ok(
      !rawContent.includes(secret),
      "plaintext absent from the stored ciphertext"
    );
    log("server-side event is opaque ciphertext (no plaintext) ✓");
  }

  /* reverse direction */
  const reply = `encrypted-reply-${stamp}`;
  await b.sendMessage(encRoomId, reply);
  await waitFor(
    () =>
      (a.getRoom(encRoomId)?.timeline ?? []).some(
        (item) => item.kind === "message" && (item as MessageItem).body === reply
      ),
    "a decrypts b's encrypted reply"
  );
  log("reverse-direction encrypted message decrypted ✓");

  a.stopSync();
  b.stopSync();
  log("ALL E2E CHECKS PASSED against", HOME);
  process.exit(0);
}

void main().catch((e: unknown) => fail(e instanceof Error && e.stack ? e.stack : String(e)));
