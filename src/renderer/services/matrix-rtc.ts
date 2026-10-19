/** MatrixRTC membership formats and media-key event transports. */
import type { Room, RtcMembership, MatrixEvent, ToDeviceEvent, MediaKeysEvent } from "./matrix-types.ts";

export function rebuildRtcMemberships(room: Room): void {
  const now = Date.now();
  const out: RtcMembership[] = [];
  for (const [stateKey, content] of room.callMembers) {
    /* legacy format: per-user with m.calls[] */
    const calls = content["m.calls"] as
      | { "m.call_id"?: string; "m.devices"?: unknown[] }[]
      | undefined;
    if (Array.isArray(calls)) {
      for (const call of calls) {
        const devices = (call["m.devices"] ?? []) as Record<string, unknown>[];
        for (const device of devices) {
          const deviceId = typeof device.device_id === "string" ? device.device_id : "";
          if (!deviceId) continue;
          const expiresTs =
            typeof device.expires_ts === "number" ? device.expires_ts : Infinity;
          const foci = device.foci_active as { focus?: string; livekit_service_url?: string }[] | undefined;
          const focusUrl = foci?.find((f) => f.focus === "livekit")?.livekit_service_url ?? null;
          if (expiresTs !== Infinity && expiresTs <= now) continue;
          out.push({
            sender: stateKey,
            deviceId,
            callId: typeof call["m.call_id"] === "string" ? call["m.call_id"] : "",
            expiresTs,
            focusUrl,
          });
        }
      }
      continue;
    }
    /* MSC4143 session format: per-device, flattened fields */
    const deviceId = typeof content.device_id === "string" ? content.device_id : "";
    if (!deviceId || content.application !== "m.call") continue;
    const createdTs =
      typeof content.created_ts === "number" ? content.created_ts : now;
    const expires = typeof content.expires === "number" ? content.expires : Infinity;
    const expiresTs = expires === Infinity ? Infinity : createdTs + expires;
    if (expiresTs !== Infinity && expiresTs <= now) continue;
    /* focus_active ships in two shapes: the original { active_focus:
       { focus, livekit_service_url } } and the current flattened
       { type: "livekit", livekit_service_url } (what element-call's
       parser requires) — read both */
    const focusActive = content.focus_active as
      | {
          active_focus?: { focus?: string; livekit_service_url?: string };
          type?: string;
          livekit_service_url?: string;
        }
      | undefined;
    const focusUrl =
      focusActive?.active_focus?.focus === "livekit"
        ? (focusActive.active_focus.livekit_service_url ?? null)
        : focusActive?.type === "livekit"
          ? (focusActive.livekit_service_url ?? null)
          : null;
    /* the sender: the state key is `[_]${userId}_${deviceId}_m.call`, and
       user ids may themselves contain underscores — match against the
       room's member list first, fall back to a prefix split */
    const keyBody = stateKey.startsWith("_") ? stateKey.slice(1) : stateKey;
    let sender: string | null = null;
    for (const memberUserId of room.members.keys()) {
      if (keyBody.startsWith(`${memberUserId}_`)) {
        sender = memberUserId;
        break;
      }
    }
    if (!sender) {
      sender = keyBody.includes("_") ? keyBody.slice(0, keyBody.indexOf("_")) : keyBody;
    }
    out.push({
      sender,
      deviceId,
      callId: typeof content.call_id === "string" ? content.call_id : "",
      expiresTs,
      focusUrl,
    });
  }
  room.rtcMemberships = out;
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
