/*
 * Grungus — account registration (POST /register with UIA) against the
 * in-repo mock homeserver: the m.login.dummy flow, the
 * m.login.registration_token flow, and the error paths. Drives the REAL
 * client code (the same module the renderer bundles).
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import {
  MatrixClient,
  HttpError,
  type MessageItem,
} from "../src/renderer/services/matrix-client.ts";

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

test("register: dummy flow creates the account and the session works", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const client = new MatrixClient({ baseUrl: hs.baseUrl! });

  /* the UIA probe returns the flows (a 401 challenge, not an error) */
  const challenge = await client.registrationFlows();
  assert.ok(
    challenge.flows.some((flow) => (flow.stages ?? []).includes("m.login.dummy")),
    "dummy stage advertised"
  );
  assert.ok(challenge.session, "UIA session in the challenge");

  const res = await client.registerWithPassword({
    username: "newbie",
    password: "hunter2",
  });
  assert.equal(res.user_id, "@newbie:mock.hs");
  assert.ok(res.access_token, "register logs in (inhibit_login: false)");
  assert.equal(client.userId, "@newbie:mock.hs");
  assert.ok(client.accessToken);
  assert.ok(client.deviceId);

  /* the fresh session is a fully working client: sync + create + send */
  client.startSync();
  t.after(() => client.stopSync());
  const roomId = await client.createRoom({ name: "first-room" });
  await client.sendMessage(roomId, "hello from the new account");
  await waitFor(
    () =>
      (client.getRoom(roomId)?.timeline ?? []).some(
        (item): item is MessageItem =>
          item.kind === "message" && item.body === "hello from the new account"
      ),
    8_000,
    "registered account sees its own message"
  );
});

test("register: duplicate and invalid usernames are rejected", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());
  hs.registerUser("taken", "pw");

  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await assert.rejects(
    client.registerWithPassword({ username: "taken", password: "x" }),
    (err: unknown) => err instanceof HttpError && err.errcode === "M_USER_IN_USE"
  );
  await assert.rejects(
    client.registerWithPassword({ username: "No Caps!", password: "x" }),
    (err: unknown) => err instanceof HttpError && err.errcode === "M_INVALID_USERNAME"
  );
});

test("register: registration-token flow (shared-token homeservers)", async (t) => {
  const hs = new MockHomeserver();
  hs.registrationToken = "sekrit";
  await hs.listen();
  t.after(() => hs.close());

  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  const challenge = await client.registrationFlows();
  assert.ok(
    challenge.flows.some((flow) =>
      (flow.stages ?? []).includes("m.login.registration_token")
    ),
    "registration_token stage advertised"
  );

  /* no token → a clear client-side error before any account is created */
  await assert.rejects(
    client.registerWithPassword({ username: "t", password: "x" }),
    (err: unknown) =>
      err instanceof Error && /registration token/.test(err.message)
  );
  /* wrong token → the server rejects it */
  await assert.rejects(
    client.registerWithPassword({
      username: "t",
      password: "x",
      registrationToken: "wrong",
    }),
    (err: unknown) => err instanceof HttpError && err.errcode === "M_FORBIDDEN"
  );
  /* correct token → the account exists and the session works */
  const res = await client.registerWithPassword({
    username: "t",
    password: "x",
    registrationToken: "sekrit",
  });
  assert.equal(res.user_id, "@t:mock.hs");
  assert.ok(client.accessToken);
});
