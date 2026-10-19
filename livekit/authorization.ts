import { createHash } from "node:crypto";

export function liveKitRoomName(matrixRoomId: string): string {
  return `matrix-${createHash("sha256").update(matrixRoomId).digest("hex")}`;
}

/** The service account must be joined to the room; missing configuration fails closed. */
export async function authorizeRoom(homeserver: string, serviceToken: string | undefined, userId: string, roomId: string): Promise<void> {
  if (!serviceToken) throw new Error("Room authorization is not configured (HS_AUTH_TOKEN)");
  if (!/^![^:]+:.+$/.test(roomId)) throw new Error("A Matrix room_id is required");
  const response = await fetch(`${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || (await response.json() as { membership?: string }).membership !== "join") throw new Error("User is not a current member of this room");
}
