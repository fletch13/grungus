/** Matrix OAuth device authorization (RFC 8628). No browser callback needed. */
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
export interface OAuthMetadata {
  issuer: string;
  registration_endpoint: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  grant_types_supported: string[];
}
export interface OAuthSession {
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
  refreshToken?: string;
  expiresAt: number;
}
export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}
export interface OAuthTokens {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_in: number;
}
export function oauthUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("The sign-in server must use HTTPS");
  }
  return url.href;
}
export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export async function oauthRequest<T>(url: string, body: URLSearchParams | Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const response = await fetch(oauthUrl(url), {
    method: "POST", redirect: "error",
    headers: { "Content-Type": body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json" },
    body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  });
  const data = await response.json();
  if (!response.ok) throw new OAuthError(data.error ?? "server_error", data.error_description ?? data.error ?? "Sign-in request failed");
  return data as T;
}
export async function discoverOAuth(baseUrl: string): Promise<OAuthMetadata | null> {
  const response = await fetch(`${baseUrl}/_matrix/client/v1/auth_metadata`, { signal: AbortSignal.timeout(10_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Could not discover browser sign-in");
  const data = await response.json() as OAuthMetadata;
  if (!data.grant_types_supported?.includes(DEVICE_GRANT)) throw new Error("This server requires OAuth browser sign-in but does not support device authorization yet");
  for (const url of [data.issuer, data.registration_endpoint, data.device_authorization_endpoint, data.token_endpoint, data.revocation_endpoint]) oauthUrl(url);
  return data;
}
export async function beginDeviceLogin(metadata: OAuthMetadata, signal?: AbortSignal): Promise<{ clientId: string; deviceId: string; authorization: DeviceAuthorization }> {
  const registration = await oauthRequest<{ client_id: string }>(metadata.registration_endpoint, {
    client_name: "Grungus", client_uri: "https://github.com/fletch13/grungus",
    application_type: "native", token_endpoint_auth_method: "none",
    grant_types: [DEVICE_GRANT, "refresh_token"], response_types: [],
  }, signal);
  if (!registration.client_id) throw new Error("Sign-in server returned no client ID");
  const deviceId = crypto.randomUUID();
  const authorization = await oauthRequest<DeviceAuthorization>(metadata.device_authorization_endpoint, new URLSearchParams({
    client_id: registration.client_id, scope: `urn:matrix:client:api:* urn:matrix:client:device:${deviceId}`,
  }), signal);
  if (!authorization.device_code || !authorization.user_code || !Number.isFinite(authorization.expires_in) || authorization.expires_in <= 0) throw new Error("Invalid device sign-in response");
  oauthUrl(authorization.verification_uri);
  if (authorization.verification_uri_complete) oauthUrl(authorization.verification_uri_complete);
  return { clientId: registration.client_id, deviceId, authorization };
}
export async function pollDeviceLogin(metadata: OAuthMetadata, clientId: string, authorization: DeviceAuthorization, signal: AbortSignal): Promise<OAuthTokens> {
  const deadline = Date.now() + authorization.expires_in * 1000;
  let interval = Math.max(1, authorization.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, Math.min(interval, deadline - Date.now()));
      signal.addEventListener("abort", abort, { once: true });
    });
    if (Date.now() >= deadline) break;
    try {
      const tokens = await oauthRequest<OAuthTokens>(metadata.token_endpoint, new URLSearchParams({
        grant_type: DEVICE_GRANT, client_id: clientId, device_code: authorization.device_code,
      }), signal);
      validateTokens(tokens);
      return tokens;
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      if (error.code === "slow_down") interval += 5000;
      else if (error.code !== "authorization_pending") throw error;
    }
  }
  throw new Error("Sign-in expired. Please try again.");
}
export function validateTokens(tokens: OAuthTokens): void {
  if (!tokens.access_token || tokens.token_type?.toLowerCase() !== "bearer" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new Error("Invalid sign-in token response");
}
