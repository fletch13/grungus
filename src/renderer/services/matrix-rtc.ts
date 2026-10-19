/** MatrixRTC membership formats and media-key event transports. */
import type { Room, RtcMembership, MatrixEvent, ToDeviceEvent, MediaKeysEvent } from "./matrix-types.ts";

function focusUrl(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const focus = value as Record<string, unknown>;
  return (focus.type === "livekit" || focus.focus === "livekit") && typeof focus.livekit_service_url === "string" ? focus.livekit_service_url : null;
}

export function rebuildRtcMemberships(room: Room): void {
  const now = Date.now();
  const sessions: { membership: RtcMembership; created: number; oldest: boolean; preferred: string | null }[] = [];
  for (const [stateKey, content] of room.callMembers) {
    const calls = content["m.calls"];
    if (Array.isArray(calls)) {
      for (const call of calls as { "m.call_id"?: string; "m.devices"?: Record<string, unknown>[] }[]) {
        for (const device of call["m.devices"] ?? []) {
          if (typeof device.device_id !== "string") continue;
          const expiresTs = typeof device.expires_ts === "number" ? device.expires_ts : Infinity;
          if (expiresTs <= now) continue;
          const foci = Array.isArray(device.foci_active) ? device.foci_active : [];
          sessions.push({ membership: { sender: stateKey, deviceId: device.device_id, callId: call["m.call_id"] ?? "", expiresTs, focusUrl: foci.map(focusUrl).find(Boolean) ?? null }, created: typeof device.created_ts === "number" ? device.created_ts : 0, oldest: false, preferred: null });
        }
      }
      continue;
    }
    if (content.application !== "m.call" || typeof content.device_id !== "string" || !content.device_id) continue;
    if (content.scope && content.scope !== "m.room") continue;
    if (content.call_id && content.call_id !== "ROOM") continue;
    const created = typeof content.created_ts === "number" ? content.created_ts : 0;
    const expires = typeof content.expires === "number" ? content.expires : Infinity;
    const expiresTs = expires === Infinity ? Infinity : created + expires;
    if (expiresTs <= now) continue;
    const active = content.focus_active as Record<string, unknown> | undefined;
    const preferred = (Array.isArray(content.foci_preferred) ? content.foci_preferred : []).map(focusUrl).find(Boolean) ?? null;
    const keyBody = stateKey.startsWith("_") ? stateKey.slice(1) : stateKey;
    const suffix = `_${content.device_id}_m.call`;
    const sender = [...room.members.keys()].sort((a, b) => b.length - a.length).find(userId => keyBody.startsWith(`${userId}_`))
      ?? (keyBody.endsWith(suffix) ? keyBody.slice(0, -suffix.length) : keyBody);
    sessions.push({ membership: {
      sender, deviceId: content.device_id, callId: typeof content.call_id === "string" ? content.call_id : "", expiresTs,
      focusUrl: focusUrl(active) ?? focusUrl(active?.active_focus) ?? preferred,
    }, created, oldest: active?.focus_selection === "oldest_membership", preferred });
  }
  sessions.sort((a, b) => a.created - b.created || a.membership.sender.localeCompare(b.membership.sender));
  const oldestFocus = sessions[0]?.preferred ?? sessions[0]?.membership.focusUrl ?? null;
  room.rtcMemberships = sessions.map(session => ({ ...session.membership, focusUrl: session.oldest ? oldestFocus : session.membership.focusUrl }));
}

export class MatrixRtc {
  private listeners = new Set<(keys: MediaKeysEvent) => void>();
  onKeys(cb: (keys: MediaKeysEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emitKeys(keys: MediaKeysEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(keys);
      } catch (err) {
        console.error("[grungus] media-key listener failed:", err);
      }
    }
  }

  handleRoomKeys(roomId: string, ev: MatrixEvent): void {
    if (ev.type !== "io.element.call.encryption_keys") return;
    const content = (ev.content ?? {}) as {
      keys?: unknown;
      device_id?: unknown;
      call_id?: unknown;
    };
    if (content.call_id !== "") return; /* only room-scoped calls */
    if (!Array.isArray(content.keys)) return;
    const keys: Array<{ index: number; key: string }> = [];
    for (const raw of content.keys) {
      const entry = raw as { index?: unknown; key?: unknown } | null;
      if (
        !entry ||
        typeof entry.index !== "number" ||
        typeof entry.key !== "string"
      ) {
        continue;
      }
      keys.push({ index: entry.index, key: entry.key });
    }
    if (keys.length === 0 || !ev.sender) return;
    this.emitKeys({
      roomId,
      sender: ev.sender,
      deviceId: typeof content.device_id === "string" ? content.device_id : null,
      keys,
    });
  }

  handleToDeviceKeys(ev: ToDeviceEvent): void {
    const content = (ev.content ?? {}) as {
      room_id?: unknown;
      member_id?: unknown;
      media_key?: { index?: unknown; key?: unknown } | null;
      format?: unknown;
    };
    const mediaKey = content.media_key;
    if (
      !ev.sender ||
      !mediaKey ||
      typeof mediaKey.index !== "number" ||
      typeof mediaKey.key !== "string" ||
      (content.format !== undefined && content.format !== 0)
    ) {
      return;
    }
    this.emitKeys({
      roomId: typeof content.room_id === "string" ? content.room_id : null,
      sender: ev.sender,
      deviceId: null,
      keys: [{ index: mediaKey.index, key: mediaKey.key }],
    });
  }
}
