/*
 * Grungus — SSO login (m.login.sso redirect + m.login.token exchange)
 * against the mock homeserver's fake Keycloak-style IdP.
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient, type MessageItem } from "../src/renderer/services/matrix-client.ts";

function waitFor(predicate: () => boolean, timeoutMs = 8_000, label = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("Timed out: " + label));
      setTimeout(poll, 25);
    };
    poll();
  });
}

/** Follow one redirect hop (manual), returning the Location header. */
async function followRedirect(url: string): Promise<string> {
  const res = await fetch(url, { redirect: "manual" });
  assert.equal(res.status, 302, `expected a redirect from ${url}`);
  const location = res.headers.get("location");
  assert.ok(location, "redirect carries a Location header");
  return location;
}

test("sso: flows discovery, redirect dance, token exchange, working session", async (t) => {
  const hs = new MockHomeserver();
  hs.ssoEnabled = true;
  await hs.listen();
  t.after(() => hs.close());
  hs.registerUser("other", "pw0");
  hs.registerUser("sso_user", "pw1"); /* the fake IdP authenticates the LAST registered user */

  const client = new MatrixClient({ baseUrl: hs.baseUrl! });

  /* 1. discovery: the server advertises SSO with its provider */
  const flows = await client.loginFlows();
  assert.ok(flows.some((flow) => flow.type === "m.login.password"), "password flow offered");
  const ssoFlow = flows.find((flow) => flow.type === "m.login.sso");
  assert.ok(ssoFlow, "sso flow offered");
  assert.ok(
    ssoFlow!.identity_providers?.some((p) => p.id === "keycloak"),
    "keycloak provider advertised"
  );

  /* 2. the redirect dance: homeserver → IdP → callback with loginToken */
  const callbackUrl = "http://127.0.0.1:9/hidden-callback";
  const startUrl = client.ssoLoginUrl("keycloak", callbackUrl);
  const idpUrl = await followRedirect(startUrl); /* homeserver → IdP */
  assert.ok(idpUrl.startsWith(hs.baseUrl!), "homeserver redirected to its IdP");
  const backUrl = await followRedirect(idpUrl); /* IdP → callback */
  assert.ok(backUrl.startsWith(callbackUrl), "IdP redirected back to the callback");
  const loginToken = new URL(backUrl).searchParams.get("loginToken");
  assert.ok(loginToken, "callback carries the loginToken");

  /* 3. token exchange: m.login.token completes the login */
  await client.loginWithToken(loginToken);
  assert.equal(client.userId, "@sso_user:mock.hs");
  assert.ok(client.accessToken, "access token issued");
  assert.ok(client.deviceId, "device id issued");

  /* 4. the SSO session is a fully working client */
  client.startSync();
  t.after(() => client.stopSync());
  const roomId = await client.createRoom({ name: "sso-room", isPublic: true });
  await waitFor(() => client.getRoom(roomId) !== null, 5_000, "room syncs");
  await client.sendMessage(roomId, "logged in via keycloak");
  await waitFor(
    () =>
      (client.getRoom(roomId)?.timeline ?? []).some(
        (item): item is MessageItem => item.kind === "message" && item.body === "logged in via keycloak"
      ),
    5_000,
    "sso session sends messages"
  );
});

test("sso: a bad login token is rejected", async (t) => {
  const hs = new MockHomeserver();
  hs.ssoEnabled = true;
  await hs.listen();
  t.after(() => hs.close());
  hs.registerUser("sso2", "pw1");

  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await assert.rejects(
    () => client.loginWithToken("sso_tok_forged"),
    (err: unknown) => err instanceof Error && /Invalid login token|403/.test(err.message)
  );
});

test("sso: without enableSso the server offers no SSO flow", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());
  hs.registerUser("plain", "pw1");

  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  const flows = await client.loginFlows();
  assert.ok(!flows.some((flow) => flow.type === "m.login.sso"));
  assert.ok(flows.some((flow) => flow.type === "m.login.password"));
});
