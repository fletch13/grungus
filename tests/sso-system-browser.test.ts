/*
 * Grungus — system-browser SSO: the loopback return channel (the exact
 * module the Electron main process uses) captures the loginToken from a
 * redirect dance against the mock homeserver.
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { startSsoLoopback } from "../src/main/sso-loopback.ts";

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

/** Follow redirect hops until the loopback callback; returns the callback URL. */
async function followToCallback(startUrl: string, callbackPrefix: string): Promise<string> {
  let url = startUrl;
  for (let hop = 0; hop < 5; hop++) {
    const res = await fetch(url, { redirect: "manual" });
    const location = res.headers.get("location");
    if (!location) throw new Error(`expected a redirect at hop ${hop}, got ${res.status}`);
    url = new URL(location, url).toString();
    if (url.startsWith(callbackPrefix)) return url;
  }
  throw new Error("redirect chain did not reach the callback");
}

test("system-browser SSO: loopback captures the loginToken from the redirect dance", async (t) => {
  const hs = new MockHomeserver();
  hs.ssoEnabled = true;
  await hs.listen();
  t.after(() => hs.close());
  hs.registerUser("other", "pw0");
  hs.registerUser("sysbrowser_user", "pw1"); /* fake IdP picks the LAST registered user */

  /* the main process starts the loopback first — its URL is the redirectUrl */
  const loopback = await startSsoLoopback();
  t.after(() => loopback.close());

  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  const ssoUrl = client.ssoLoginUrl("keycloak", loopback.redirectUrl);
  assert.ok(
    ssoUrl.includes(encodeURIComponent(loopback.redirectUrl)),
    "the SSO URL embeds the loopback redirectUrl"
  );

  /* the "system browser" walks the redirect chain: homeserver → IdP →
     callback. The final fetch IS the browser hitting our loopback server. */
  const callbackUrl = await followToCallback(ssoUrl, loopback.redirectUrl);
  const hit = await fetch(callbackUrl);
  assert.equal(hit.status, 200, "the loopback serves a completion page");

  /* the loopback captured the token */
  const loginToken = await loopback.waitForToken(5_000);
  assert.ok(loginToken, "loginToken captured via the loopback");

  /* the captured token completes the login */
  await client.loginWithToken(loginToken);
  assert.equal(client.userId, "@sysbrowser_user:mock.hs");
  assert.ok(client.accessToken, "a working session was issued");
});

test("system-browser SSO: waitForToken resolves null on abort without a callback", async (t) => {
  const loopback = await startSsoLoopback();
  const tokenPromise = loopback.waitForToken(1_000);
  loopback.close();
  const token = await tokenPromise;
  assert.equal(token, null, "no token when the flow is aborted");
});
