/** Incoming timeline conversion, deferred decryption, and echo reconciliation. */
import type { E2eeCrypto } from "./e2ee.ts";
import type { EncryptedFile } from "./attachments.ts";
import type { Room, MatrixEvent, TimelineItem, RoomUpdate } from "./matrix-types.ts";
import { displayNameFor } from "./matrix-rooms.ts";
import { mxidLocalpart } from "./matrix-identifiers.ts";
export interface TimelineHost {
  readonly userId: string | null;
  readonly crypto: E2eeCrypto | null;
  readonly onCallEvent: ((roomId: string, event: MatrixEvent) => void) | null;
  getRoom(roomId: string): Room | null;
  handleMediaKeys(roomId: string, event: MatrixEvent): void;
  notify(update: RoomUpdate): void;
  notifyRooms(): void;
}
export class MatrixTimeline {
  private host: TimelineHost;
  private _undecrypted = new Map<string, Map<string, MatrixEvent>>();
  private _historicalUndecrypted = new Set<string>();
  constructor(host: TimelineHost) { this.host = host; }
  clear(roomId: string): void {
    for (const id of this._undecrypted.get(roomId)?.keys() ?? []) this._historicalUndecrypted.delete(id);
    this._undecrypted.delete(roomId);
  }

  prune(room: Room): void {
    const ids = new Set(room.timeline.map(item => item.id));
    const pending = this._undecrypted.get(room.id);
    if (pending) for (const id of pending.keys()) if (!ids.has(id)) {
      pending.delete(id);
      this._historicalUndecrypted.delete(id);
    }
  }

  private _maybeCallEvent(roomId: string, ev: MatrixEvent): void {
    if (this.host.onCallEvent) {
      try {
        this.host.onCallEvent(roomId, ev);
      } catch (err) {
        console.error("[grungus] call event handler failed:", err);
      }
    }
  }

  toItem(room: Room, ev: MatrixEvent, historical = false): TimelineItem | null {
    if (!ev || !ev.type) return null;
    const ts = ev.origin_server_ts ?? Date.now();
    const senderName = displayNameFor(room, ev.sender ?? null, this.host.userId);
    const content = ev.content ?? {};

    /* Element's media-key events are call machinery, not timeline items */
    if (ev.type === "io.element.call.encryption_keys") {
      if (!historical) this.host.handleMediaKeys(room.id, ev);
      return null;
    }

    /* Preserve visible call activity while keeping signaling routed to the call controller. */
    if (["org.matrix.msc4075.call.notify", "org.matrix.msc4075.rtc.notification", "m.rtc.notification", "org.matrix.msc3401.call"].includes(ev.type)) {
      const ended = content["m.terminated"] === true;
      return { kind: "system", id: ev.event_id ?? null, ts, text: `${senderName}: ${ended ? "Call ended" : "Call started"}`, callActivity: ended ? "ended" : "started", matrixRtc: true };
    }
    if (["m.call.member", "org.matrix.msc3401.call.member"].includes(ev.type)) {
      const active = content.application === "m.call" && typeof content.device_id === "string"
        || Array.isArray(content["m.calls"]) && (content["m.calls"] as { "m.devices"?: unknown[] }[]).some(call => call["m.devices"]?.length);
      return { kind: "system", id: ev.event_id ?? null, ts, text: `${senderName} ${active ? "joined" : "left"} the call`, callActivity: active ? "joined" : "left", matrixRtc: content.application === "m.call" };
    }
    if (ev.type.startsWith("m.call.")) {
      if (!historical) this._maybeCallEvent(room.id, ev);
      if (ev.type === "m.call.invite" || ev.type === "m.call.hangup") {
        const ended = ev.type === "m.call.hangup";
        return { kind: "system", id: ev.event_id ?? null, ts, text: `${senderName}: ${ended ? "Call ended" : "Call started"}`, callActivity: ended ? "ended" : "started" };
      }
      return null;
    }
    if (ev.type === "m.room.message" || ev.type === "m.sticker") {
      const isSticker = ev.type === "m.sticker";
      const msgtype = isSticker
        ? "m.sticker"
        : typeof content.msgtype === "string"
          ? content.msgtype
          : "m.text";
      const body = typeof content.body === "string" ? content.body : "";
      const file = content.file && typeof content.file === "object" ? content.file as EncryptedFile : undefined;
      const url = file ? (typeof file.url === "string" ? file.url : null) : typeof content.url === "string" ? content.url : null;

      const rawInfo = content.info;
      const info =
        rawInfo && typeof rawInfo === "object"
          ? (rawInfo as { mimetype?: unknown; w?: unknown; h?: unknown; size?: unknown })
          : {};

      const otherAttachment =
        msgtype === "m.file" || msgtype === "m.audio" || msgtype === "m.video";
      const text = otherAttachment ? `[attachment] ${body}` : body;

      const media =
        url && (isSticker || msgtype === "m.image")
          ? {
              mxc: url,
              file,
              mimetype: typeof info.mimetype === "string" ? info.mimetype : null,
              width: typeof info.w === "number" ? info.w : null,
              height: typeof info.h === "number" ? info.h : null,
              size: typeof info.size === "number" ? info.size : null,
              name: body || null,
            }
          : null;

      return {
        kind: "message",
        id: ev.event_id ?? null,
        sender: ev.sender ?? "",
        senderName,
        ts,
        msgtype,
        body: text,
        media,
      };
    }

    if (ev.type === "m.room.member" && typeof ev.state_key === "string") {
      const membership =
        typeof content.membership === "string" ? content.membership : "join";
      const prev = ev.unsigned?.prev_content?.membership;
      const targetName =
        ev.state_key === ev.sender
          ? senderName
          : typeof content.displayname === "string"
            ? content.displayname
            : mxidLocalpart(ev.state_key);
      let text: string;
      if (membership === "join") text = `${targetName} joined the room`;
      else if (membership === "leave")
        text =
          prev === "invite"
            ? `${targetName} declined the invite`
            : `${targetName} left the room`;
      else if (membership === "invite") text = `${senderName} invited ${targetName}`;
      else if (membership === "ban") text = `${senderName} banned ${targetName}`;
      else text = `${targetName}'s membership is now ${membership}`;
      return { kind: "system", id: ev.event_id ?? null, ts, text };
    }

    if (ev.type === "m.room.name" && typeof content.name === "string") {
      return {
        kind: "system",
        id: ev.event_id ?? null,
        ts,
        text: `${senderName} changed the room name to "${content.name}"`,
      };
    }

    if (ev.type === "m.room.topic" && typeof content.topic === "string") {
      return {
        kind: "system",
        id: ev.event_id ?? null,
        ts,
        text: `${senderName} changed the room topic`,
      };
    }

    return null;
  }

  decryptItem(room: Room, ev: MatrixEvent, historical = false): TimelineItem | null {
    if (!this.host.crypto) return null;
    const decrypted = this.host.crypto.decryptRoomEvent(ev, room.id);
    if (!decrypted) {
      this._trackUndecrypted(room, ev);
      if (historical && ev.event_id) this._historicalUndecrypted.add(ev.event_id);
      return {
        kind: "system",
        id: ev.event_id ?? null,
        ts: ev.origin_server_ts ?? Date.now(),
        text: "🔒 Unable to decrypt this message (requesting the key from other devices…)",
      };
    }
    const inner: MatrixEvent = {
      ...ev,
      type: decrypted.type,
      content: decrypted.content,
    };
    return this.toItem(room, inner, historical);
  }

  private _trackUndecrypted(room: Room, ev: MatrixEvent): void {
    const content = ev.content as { sender_key?: unknown; session_id?: unknown };
    const senderKey = typeof content.sender_key === "string" ? content.sender_key : null;
    const sessionId = typeof content.session_id === "string" ? content.session_id : null;
    const eventId = ev.event_id ?? null;
    if (!sessionId || !eventId) return;
    if (this.host.crypto) {
      void this.host.crypto
        .requestRoomKey(room.id, ev.sender ?? null, senderKey, sessionId)
        .catch((err) => console.error("[grungus] room key request failed:", err));
    }
    let perRoom = this._undecrypted.get(room.id);
    if (!perRoom) {
      perRoom = new Map();
      this._undecrypted.set(room.id, perRoom);
    }
    perRoom.set(eventId, ev);
    while (perRoom.size > 1000) {
      const oldest = perRoom.keys().next().value!;
      perRoom.delete(oldest);
      this._historicalUndecrypted.delete(oldest);
    }
  }

  retryUndecrypted(roomId: string): void {
    const room = this.host.getRoom(roomId);
    const pending = this._undecrypted.get(roomId);
    if (!room || !pending || pending.size === 0) return;
    let changed = false;
    for (const [eventId, ev] of [...pending.entries()]) {
      const decrypted = this.host.crypto ? this.host.crypto.decryptRoomEvent(ev, room.id) : null;
      if (!decrypted) { this._trackUndecrypted(room, ev); continue; }
      pending.delete(eventId);
      changed = true;
      const inner: MatrixEvent = {
        ...ev,
        type: decrypted.type,
        content: decrypted.content,
      };
      const item = this.toItem(room, inner, this._historicalUndecrypted.has(eventId));
      this._historicalUndecrypted.delete(eventId);
      if (!item) continue;
      const idx = room.timeline.findIndex(
        (entry) => entry.kind === "system" && entry.id === eventId
      );
      if (idx >= 0) room.timeline[idx] = item;

      const ts = ev.origin_server_ts ?? Date.now();
      if (ts > room.lastActivityTs) room.lastActivityTs = ts;
    }
    if (changed) {
      this.host.notify({ room, newEvents: [], redraw: true });
      this.host.notifyRooms();
    }
  }

  removeEcho(room: Room, txnId: string): boolean {
    for (let i = 0; i < room.timeline.length; i++) {
      const entry = room.timeline[i];
      if (entry && entry.kind === "message" && entry.txnId === txnId) {
        room.timeline.splice(i, 1);
        return true;
      }
    }
    return false;
  }
}
