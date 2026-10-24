import test from "node:test";
import assert from "node:assert/strict";
import { beginDeviceLogin, discoverOAuth, pollDeviceLogin, oauthUrl, DEVICE_GRANT, type OAuthMetadata } from "../src/renderer/services/oauth.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";

const metadata: OAuthMetadata = {
  issuer: "https://auth.example/", registration_endpoint: "https://auth.example/register",
  device_authorization_endpoint: "https://auth.example/device", token_endpoint: "https://auth.example/token",
  revocation_endpoint: "https://auth.example/revoke", grant_types_supported: [DEVICE_GRANT, "refresh_token"],
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("OAuth-only discovery does not need the disabled legacy login endpoint", async t => {
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://matrix.example/_matrix/client/v1/auth_metadata");
    return json(metadata);
  });
  assert.deepEqual(await discoverOAuth("https://matrix.example"), metadata);
});

test("legacy homeservers remain supported when OAuth discovery returns 404", async t => {
  t.mock.method(globalThis, "fetch", async () => json({ errcode: "M_UNRECOGNIZED" }, 404));
  assert.equal(await discoverOAuth("https://matrix.example"), null);
});

test("device grant registers a public client and requests a unique Matrix device", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    calls++;
    if (url.endsWith("/register")) {
      const body = JSON.parse(String(options.body));
      assert.equal(body.token_endpoint_auth_method, "none");
      assert.ok(body.grant_types.includes(DEVICE_GRANT));
      return json({ client_id: "grungus-client" });
    }
    assert.equal(url, metadata.device_authorization_endpoint);
    const body = new URLSearchParams(String(options.body));
    assert.equal(body.get("client_id"), "grungus-client");
    assert.match(body.get("scope")!, /^urn:matrix:client:api:\* urn:matrix:client:device:[a-z0-9-]+$/);
    return json({ device_code: "private", user_code: "ABCD", verification_uri: "https://auth.example/verify", expires_in: 600 });
  });
  const result = await beginDeviceLogin(metadata);
  assert.equal(result.authorization.user_code, "ABCD");
  assert.ok(result.deviceId);
  assert.equal(calls, 2);
});

test("device polling waits for approval and accepts a bearer token", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => ++calls === 1
    ? json({ error: "authorization_pending" }, 400)
    : json({ access_token: "approved", token_type: "Bearer", expires_in: 300 }));
  const tokens = await pollDeviceLogin(metadata, "client", {
    device_code: "private", user_code: "ABCD", verification_uri: "https://auth.example/verify", expires_in: 10, interval: 1,
  }, new AbortController().signal);
  assert.equal(tokens.access_token, "approved");
  assert.equal(calls, 2);
});

test("cancelled authorization never polls the token endpoint", async t => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("must not fetch"); });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(pollDeviceLogin(metadata, "client", {
    device_code: "private", user_code: "ABCD", verification_uri: "https://auth.example/verify", expires_in: 10,
  }, controller.signal), { name: "AbortError" });
});

test("expired restored OAuth sessions refresh once across concurrent requests and persist rotated tokens", async t => {
  let refreshes = 0;
  let saves = 0;
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    if (url === metadata.token_endpoint) {
      refreshes++;
      assert.equal(new URLSearchParams(String(options.body)).get("refresh_token"), "old-refresh");
      return json({ access_token: "new-access", refresh_token: "new-refresh", token_type: "Bearer", expires_in: 300 });
    }
    assert.equal((options.headers as Record<string, string>).Authorization, "Bearer new-access");
    return json({ user_id: "@alice:example", device_id: "DEVICE" });
  });
  const client = new MatrixClient({ baseUrl: "https://matrix.example", accessToken: "expired" });
  client.oauth = { clientId: "client", tokenEndpoint: metadata.token_endpoint, revocationEndpoint: metadata.revocation_endpoint, expiresAt: 0, refreshToken: "old-refresh" };
  client.onSessionChanged = async () => { saves++; };
  await Promise.all([client.whoami(), client.whoami()]);
  assert.equal(refreshes, 1);
  assert.equal(saves, 1);
  assert.equal(client.oauth.refreshToken, "new-refresh");
});

test("OAuth endpoints reject executable URLs, embedded credentials, and remote HTTP", () => {
  for (const url of ["javascript:alert(1)", "file:///tmp/auth", "https://user:secret@auth.example", "http://auth.example"]) {
    assert.throws(() => oauthUrl(url));
  }
});
