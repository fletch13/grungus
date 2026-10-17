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
 *   { room: string, openid_token?: string, matrix_token?: string }
 * → { token, url, room }
 *
 * Run: node livekit/auth-service.ts
 * Env: LK_URL, LK_API_KEY, LK_API_SECRET, HS_URL, VERIFY_MODE, PORT
 */
import http from "node:http";
import jwt from "jsonwebtoken";

const LK_URL = process.env.LK_URL ?? "http://127.0.0.1:7880";
const LK_API_KEY = process.env.LK_API_KEY ?? "devkey";
const LK_API_SECRET = process.env.LK_API_SECRET ?? "secret";
const HS_URL = process.env.HS_URL ?? "http://127.0.0.1:8008";
const VERIFY_MODE = process.env.VERIFY_MODE === "whoami" ? "whoami" : "openid";
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

  /* try the standard OpenID path first (works when federation is enabled) */
  const openidToken = typeof body.openid_token === "string" ? body.openid_token : null;
  if (openidToken) {
    try {
      const res = await fetch(
        `${HS_URL}/_matrix/federation/v1/openid_userinfo?access_token=${encodeURIComponent(openidToken)}`
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

  /* fall back to whoami verification (for homeservers with federation
     disabled; the client sends its session token) */
  const matrixToken = typeof body.matrix_token === "string" ? body.matrix_token : null;
  if (matrixToken) {
    const res = await fetch(`${HS_URL}/_matrix/client/v3/account/whoami`, {
      headers: { Authorization: `Bearer ${matrixToken}` },
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
      : "no openid_token or matrix_token provided"
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
    LK_API_SECRET,
    { expiresIn: TOKEN_TTL_S }
  );
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, {});
    return;
  }
  if (req.method !== "POST" || req.url !== "/grungus/livekit/join") {
    send(res, 404, { errcode: "M_NOT_FOUND", error: "unknown endpoint" });
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
          string,
          unknown
        >;
        /* "room" (Grungus) or "room_id" (Element Call's lk-jwt-service
           convention — the MatrixRTC LiveKit room IS the matrix room) */
        const room =
          typeof body.room === "string"
            ? body.room
            : typeof body.room_id === "string"
              ? body.room_id
              : null;
        /* Matrix room ids contain characters the strict room check
           would reject — sanitize for the LiveKit room name while
           keeping every matrix room distinct */
        const safeRoom = room?.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120) ?? null;
        if (!safeRoom || !/^[\w-]{1,120}$/.test(safeRoom)) {
          send(res, 400, { error: "invalid room name" });
          return;
        }
        const userId = await verifyMatrixIdentity(body);
        const token = mintLiveKitToken(userId, safeRoom);
        console.log(`[lk-auth] ${userId} → room "${safeRoom}"`);
        send(res, 200, { token, url: LK_URL, room: safeRoom });
      } catch (err) {
        send(res, 403, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `[lk-auth] up on http://127.0.0.1:${PORT} | mode=${VERIFY_MODE} | livekit=${LK_URL} | homeserver=${HS_URL}`
  );
});
