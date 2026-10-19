import { isVideoRoom } from "./room-kind.ts";
import type { MatrixClient, Room } from "./matrix-client.ts";

function livekitService(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (entry.type !== "livekit" || typeof entry.livekit_service_url !== "string") return null;
  try {
    const url = new URL(entry.livekit_service_url);
    return !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ? url.href.replace(/\/$/, "") : null;
  } catch { return null; }
}

/** Existing room members choose the backend; empty rooms use homeserver discovery. */
export async function discoverCallService(client: MatrixClient, room: Room): Promise<string | null> {
  const active = room.rtcMemberships.find(member => member.expiresTs > Date.now() && member.focusUrl)?.focusUrl;
  if (active) return livekitService({ type: "livekit", livekit_service_url: active });
  if (room.rtcMemberships.some(member => member.expiresTs > Date.now())) throw new Error("The active call does not advertise a supported LiveKit backend. Grungus cannot join it using a separate call transport.");
  for (const path of ["/_matrix/client/v1/rtc/transports", "/_matrix/client/unstable/org.matrix.msc4143/rtc/transports"]) {
    try {
      const data = await client.api<{ rtc_transports?: unknown[] }>("GET", path, { timeoutMs: 8000 });
      const service = data.rtc_transports?.map(livekitService).find(Boolean);
      if (service) return service;
    } catch { /* Older homeservers advertise transports in client discovery instead. */ }
  }
  const serverName = client.userId?.slice(client.userId.indexOf(":") + 1);
  const origins = new Set<string>();
  if (serverName) {
    try { const url = new URL(`https://${serverName}`); if (url.host === serverName && !url.username && !url.password) origins.add(url.origin); } catch { /* invalid server name */ }
  }
  origins.add(new URL(client.baseUrl).origin);
  for (const origin of origins) {
    try {
      const response = await fetch(`${origin}/.well-known/matrix/client`, { signal: AbortSignal.timeout(8000), credentials: "omit" });
      if (!response.ok) continue;
      const data = await response.json() as Record<string, unknown>;
      for (const key of ["org.matrix.msc4143.rtc_foci", "m.rtc_foci"]) {
        const values = data[key];
        if (Array.isArray(values)) { const service = values.map(livekitService).find(Boolean); if (service) return service; }
      }
    } catch { /* Try the next discovery origin. */ }
  }
  return null;
}

/** Element's legacy and session token endpoints have different request schemas. */
export async function requestCallToken(client: MatrixClient, roomId: string, service: string): Promise<{ token: string; url: string }> {
  const openid = await client.requestOpenIdToken();
  const memberId = `${client.userId}:${client.deviceId}`;
  const root = service.replace(/\/$/, "");
  const requests = [
    { path: "/sfu/get", body: { room: roomId, openid_token: openid, device_id: client.deviceId } },
    { path: "/get_token", body: { room_id: roomId, slot_id: "m.call#ROOM", openid_token: openid, member: { id: memberId, claimed_user_id: client.userId, claimed_device_id: client.deviceId } } },
  ];
  let message = "Call authorization failed";
  for (const request of requests) {
    const response = await fetch(`${root}${request.path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(12000), credentials: "omit", redirect: "error",
    });
    const data = await response.json().catch(() => ({})) as { jwt?: string; token?: string; url?: string; error?: string };
    const token = data.jwt ?? data.token;
    if (response.ok && token && data.url) {
      const url = new URL(data.url);
      if (!["ws:", "wss:", "https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Call backend returned an invalid media URL");
      return { token, url: data.url };
    }
    message = `Call authorization failed (${response.status})${data.error ? `: ${data.error}` : ""}`;
    if (![404, 405].includes(response.status)) throw new Error(message);
  }
  throw new Error(message);
}

/** Keep legacy DMs and mesh calls separate from Element's MatrixRTC transport. */
export async function selectCallBackend(client: MatrixClient, room: Room): Promise<{ kind: "livekit" | "mesh" | "p2p"; service?: string }> {
  if (room.livekitService || isVideoRoom(room) || room.rtcMemberships.some(member => member.focusUrl)
    || [...room.callMembers.values()].some(content => content.application === "m.call")
    || room.timeline.some(item => item.kind === "system" && item.matrixRtc)) return { kind: "livekit" };
  if (room.isDirect) return { kind: "p2p" };
  if (room.rtcMemberships.some(member => member.expiresTs > Date.now())) return { kind: "mesh" };
  const service = await discoverCallService(client, room);
  return service ? { kind: "livekit", service } : { kind: "mesh" };
}
