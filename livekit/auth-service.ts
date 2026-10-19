/*
 * Grungus — LiveKit token service (Element lk-jwt-service pattern).
 *
 * Clients prove their Matrix identity and receive a short-lived LiveKit
 * access token; the API secret never leaves this service.
 *
 * Verification modes (env VERIFY_MODE):
 *   - "openid" (standard, default): the client sends a Matrix OpenID
 *     token (POST /user/<id>/openid/request_token); this service redeems
 *     it at the homeserver's /_matrix/federation/v1/openid_userinfo.
 *   - "whoami" (fallback for homeservers with federation disabled, e.g.
 *     dev servers): the client sends its regular access token, verified
 *     via /_matrix/client/v3/account/whoami. Only for trusted self-hosted
 *     deployments — the client hands its session token to this service.
 *
 * POST /grungus/livekit/join
 *   { room_id: string, openid_token?: string, matrix_token?: string }
 * → { token, url, room }
 *
 * Run: node livekit/auth-service.ts
 * Env: LK_URL, LK_API_KEY, LK_API_SECRET, HS_URL, HS_AUTH_TOKEN, VERIFY_MODE, PORT
 */
import http from "node:http";
import jwt from "jsonwebtoken";
import { authorizeRoom, liveKitRoomName } from "./authorization.ts";

const LK_URL = process.env.LK_URL ?? "http://127.0.0.1:7880";
const LK_API_KEY = process.env.LK_API_KEY?.trim();
const LK_API_SECRET = process.env.LK_API_SECRET;
const HS_URL = process.env.HS_URL ?? "http://127.0.0.1:8008";
const VERIFY_MODE = process.env.VERIFY_MODE ?? "openid";
if (!LK_API_KEY || !LK_API_SECRET || LK_API_SECRET === "secret" || LK_API_KEY === "devkey") {
  throw new Error("Set LK_API_KEY and LK_API_SECRET to non-default credentials");
}
if (VERIFY_MODE !== "openid" && VERIFY_MODE !== "whoami") throw new Error("VERIFY_MODE must be openid or whoami");
const MAX_BODY_BYTES = 16 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const PORT = Number(process.env.PORT ?? 8090);
const TOKEN_TTL_S = 3600;

function send(res: http.ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

/** Verify the client's Matrix identity → the user id, or throws. */
async function verifyMatrixIdentity(body: Record<string, unknown>): Promise<string> {
  const errors: string[] = [];

  /* Use only the configured identity-verification mode.
     The token may arrive as a bare string (Grungus) or as the full
     OpenID token object (element-call's /sfu/get convention). */
  const rawOpenid = body.openid_token;
  const openidToken =
    typeof rawOpenid === "string"
      ? rawOpenid
      : rawOpenid && typeof rawOpenid === "object"
        ? String((rawOpenid as { access_token?: unknown }).access_token ?? "")
        : null;
  if (VERIFY_MODE === "openid" && openidToken) {
    try {
      const res = await fetch(
        `${HS_URL}/_matrix/federation/v1/openid_userinfo?access_token=${encodeURIComponent(openidToken)}`,
        { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) }
      );
      if (res.ok) {
        const data = (await res.json()) as { sub?: string };
        if (data.sub) return data.sub;
      }
      errors.push(`openid failed (${res.status})`);
    } catch (err) {
      errors.push(`openid failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /* Whoami mode requires an explicit deployment and client opt-in. */
  const matrixToken = typeof body.matrix_token === "string" ? body.matrix_token : null;
  if (VERIFY_MODE === "whoami" && matrixToken) {
    const res = await fetch(`${HS_URL}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${matrixToken}` },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (res.ok) {
      const data = (await res.json()) as { user_id?: string };
      if (data.user_id) return data.user_id;
    }
    errors.push(`whoami failed (${res.status})`);
  }

  throw new Error(
    errors.length > 0
      ? `identity verification failed: ${errors.join("; ")}`
      : `A ${VERIFY_MODE === "openid" ? "openid_token" : "matrix_token"} is required`
  );
}

function mintLiveKitToken(userId: string, room: string): string {
  const name = userId.replace(/^@/, "").split(":")[0] ?? userId;
  return jwt.sign(
    {
      iss: LK_API_KEY,
      sub: userId,
      name,
      /* LiveKit JWT: everything lives inside the video grant, including
         the room name (LiveKit protocol VideoGrant struct) */
      video: {
        roomJoin: true,
        room,
        canPublish: true,
        canSubscribe: true,
      },
    },
    LK_API_SECRET!,
    { expiresIn: TOKEN_TTL_S }
  );
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }
  if (req.method !== "POST" || !req.url) {
    send(res, 404, { errcode: "M_NOT_FOUND", error: "unknown endpoint" });
    return;
  }
  /* Grungus's endpoint, plus element-call's legacy lk-jwt-service paths
     (it appends /sfu/get for publishers and /get_token for subscribers to
     the livekit_service_url from the foci) */
  const isJoin = req.url === "/grungus/livekit/join";
  const isSfuGet = req.url.endsWith("/sfu/get");
  const isGetToken = req.url.endsWith("/get_token");
  if (!isJoin && !isSfuGet && !isGetToken) {
    send(res, 404, { errcode: "M_NOT_FOUND", error: "unknown endpoint" });
    return;
  }
  const chunks: Buffer[] = [];
  let received = 0;
  let tooLarge = false;
  req.setTimeout(15_000, () => { req.destroy(); });
  req.on("error", () => { /* disconnected clients cannot receive a response */ });
  req.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) {
      if (!tooLarge) send(res, 413, { error: "Request body exceeds 16 KiB" });
      tooLarge = true;
      chunks.length = 0;
      return;
    }
    if (!tooLarge) chunks.push(chunk);
  });
  req.on("end", () => {
    if (tooLarge) return;
    void (async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
          string,
          unknown
        >;
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          send(res, 400, { error: "Expected a JSON object" }); return;
        }
        /* Authorize the actual Matrix room, never a caller-selected SFU name. */
        const roomId = typeof body.room_id === "string" ? body.room_id : null;
        if (!roomId) { send(res, 400, { error: "Matrix room_id is required" }); return; }
        const userId = await verifyMatrixIdentity(body);
        await authorizeRoom(HS_URL, process.env.HS_AUTH_TOKEN, userId, roomId);
        const safeRoom = liveKitRoomName(roomId);
        const token = mintLiveKitToken(userId, safeRoom);
        console.log(`[lk-auth] ${userId} → room "${safeRoom}" (${isJoin ? "join" : "sfu/get"})`);
        /* element-call's legacy path reads {url, jwt}; Grungus reads {url, token} */
        send(res, 200, { token, jwt: token, url: LK_URL, room: safeRoom });
      } catch (err) {
        send(res, err instanceof SyntaxError ? 400 : 403, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
});

server.headersTimeout = 15_000;
server.requestTimeout = 15_000;

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[lk-auth] up on http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port} | mode=${VERIFY_MODE} | livekit=${LK_URL} | homeserver=${HS_URL}`
  );
});
