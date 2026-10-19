/** Outgoing messages, encryption decisions, local echoes, and transaction IDs. */
import { encryptAttachment } from "./attachments.ts";
import type { E2eeCrypto } from "./e2ee.ts";
import type { ApiOptions, Room, RoomUpdate, MessageItem, MediaMessage } from "./matrix-types.ts";
const CLIENT_PREFIX = "/_matrix/client/v3";
export interface MessagingHost {
  readonly userId: string | null;
  readonly crypto: E2eeCrypto | null;
  api<T>(method: string, path: string, options?: ApiOptions): Promise<T>;
  getRoom(roomId: string): Room | null;
  encryptionForRoom(roomId: string): boolean | undefined;
  uploadMedia(name: string, mimeType: string, bytes: Uint8Array): Promise<string>;
  notify(update: RoomUpdate): void;
  notifyRooms(): void;
}
export class MatrixMessaging {
  private host: MessagingHost;
  private _txnCounter = 0;
  readonly acknowledged = new Map<string, string>();
  constructor(host: MessagingHost) { this.host = host; }
  async sendMessage(roomId: string, body: string): Promise<string | null> {
    const text = String(body ?? "");
    if (!text.trim()) throw new Error("Empty message");
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    const room = this.host.getRoom(roomId);
    /* encryption decision must hold even when the first sync has not landed:
       fall back to the flag createRoom/joinRoom recorded */
    const encrypted = this.host.encryptionForRoom(roomId);
    if (!room && encrypted === undefined) {
      /* unknown room: we cannot know whether it is encrypted — sending
         anyway could leak plaintext. Fail closed; the sync will land the
         room state momentarily. */
      throw new Error("Cannot send: room state not loaded yet (still syncing)");
    }
    const echo: MessageItem = {
      kind: "message",
      id: `pending-${txnId}`,
      txnId,
      pending: true,
      sender: this.host.userId ?? "",
      senderName: "You",
      ts: Date.now(),
      msgtype: "m.text",
      body: text,
      media: null,
    };
    if (room) {
      room.timeline.push(echo);
      room.lastActivityTs = echo.ts;
      this.host.notify({ room, newEvents: [echo] });
      this.host.notifyRooms();
    }
    if (encrypted && !this.host.crypto) {
      /* fail closed: never send plaintext into an encrypted room */
      throw new Error("Cannot send: E2EE is unavailable in this encrypted room");
    }
    const sendType = encrypted ? "m.room.encrypted" : "m.room.message";
    let content: Record<string, unknown>;
    try {
      content = encrypted
        ? await this.host.crypto!.encryptRoomMessage(roomId, {
            msgtype: "m.text",
            body: text,
          })
        : { msgtype: "m.text", body: text };
      const res = await this.host.api<{ event_id?: string }>(
        "PUT",
        `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/send/${sendType}/${encodeURIComponent(txnId)}`,
        { body: content }
      );
      if (res?.event_id) {
        echo.eventId = res.event_id;
        this.acknowledged.set(res.event_id, txnId);
        return res.event_id;
      }
      return null;
    } catch (err) {
      echo.pending = false;
      echo.failed = true;
      if (room) {
        this.host.notify({
          room,
          newEvents: [{ kind: "echo-failed", txnId }],
        });
      }
      throw err;
    }
  }

  async sendRoomEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>
  ): Promise<string | null> {
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    const room = this.host.getRoom(roomId);
    const encrypted = this.host.encryptionForRoom(roomId);
    if (!room && encrypted === undefined) {
      throw new Error("Cannot send: room state not loaded yet (still syncing)");
    }
    if (encrypted && !this.host.crypto) {
      throw new Error("Cannot send: E2EE is unavailable in this encrypted room");
    }
    const payload = encrypted
      ? await this.host.crypto!.encryptRoomMessage(roomId, content, type)
      : content;
    const res = await this.host.api<{ event_id?: string }>(
      "PUT",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(
        encrypted ? "m.room.encrypted" : type
      )}/${encodeURIComponent(txnId)}`,
      { body: payload }
    );
    return res?.event_id ?? null;
  }

  async sendStateEvent(
    roomId: string,
    type: string,
    stateKey: string,
    content: Record<string, unknown>
  ): Promise<string | null> {
    const res = await this.host.api<{ event_id?: string }>(
      "PUT",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
      { body: content }
    );
    return res?.event_id ?? null;
  }

  async sendToDevice(
    targetUserId: string,
    targetDeviceId: string,
    type: string,
    content: Record<string, unknown>
  ): Promise<void> {
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    await this.host.api(
      "PUT",
      `/_matrix/client/v3/sendToDevice/${encodeURIComponent(type)}/${encodeURIComponent(txnId)}`,
      {
        body: { messages: { [targetUserId]: { [targetDeviceId]: content } } },
      }
    );
  }

  async uploadAndSendMedia(roomId: string, name: string, mimeType: string, bytes: Uint8Array, dimensions: { width?: number; height?: number } = {}): Promise<string | null> {
    const encrypted = this.host.encryptionForRoom(roomId);
    if (encrypted === undefined) throw new Error("Cannot send: room state not loaded yet (still syncing)");
    if (encrypted && !this.host.crypto) throw new Error("Cannot send: E2EE is unavailable in this encrypted room");
    const attachment = encrypted ? await encryptAttachment(bytes) : null;
    const mxc = await this.host.uploadMedia(attachment ? "attachment" : name, attachment ? "application/octet-stream" : mimeType, attachment?.bytes ?? bytes);
    if (attachment) attachment.file.url = mxc;
    return this.sendMedia(roomId, { mxc, name, mimeType, size: bytes.length, file: attachment?.file, ...dimensions });
  }

  async sendMedia(
    roomId: string,
media: MediaMessage
  ): Promise<string | null> {
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    const room = this.host.getRoom(roomId);
    const encrypted = this.host.encryptionForRoom(roomId);
    if (!room && encrypted === undefined) {
      /* fail closed: an unknown room may be encrypted */
      throw new Error("Cannot send: room state not loaded yet (still syncing)");
    }
    if (encrypted && !media.file) throw new Error("Encrypted rooms require encrypted attachments");
    if (!encrypted && media.file) throw new Error("Cannot send attachment keys to an unencrypted room");
    const info: Record<string, unknown> = { mimetype: media.mimeType };
    if (media.width != null) info.w = media.width;
    if (media.height != null) info.h = media.height;
    if (media.size != null) info.size = media.size;
    const content: Record<string, unknown> = {
      msgtype: "m.image",
      body: media.name,
      ...(media.file ? { file: media.file } : { url: media.mxc }),
      info,
    };

    if (encrypted && !this.host.crypto) {
      throw new Error("Cannot send: E2EE is unavailable in this encrypted room");
    }

    const echo: MessageItem = {
      kind: "message",
      id: `pending-${txnId}`,
      txnId,
      pending: true,
      sender: this.host.userId ?? "",
      senderName: "You",
      ts: Date.now(),
      msgtype: "m.image",
      body: media.name,
      media: {
        mxc: media.mxc,
        file: media.file,
        mimetype: media.mimeType,
        width: media.width ?? null,
        height: media.height ?? null,
        size: media.size ?? null,
        name: media.name,
      },
    };
    if (room) {
      room.timeline.push(echo);
      room.lastActivityTs = echo.ts;
      this.host.notify({ room, newEvents: [echo] });
      this.host.notifyRooms();
    }
    try {
      const sendEncrypted = encrypted && this.host.crypto !== null;
      const sendType = sendEncrypted ? "m.room.encrypted" : "m.room.message";
      const payload: Record<string, unknown> = sendEncrypted
        ? await this.host.crypto!.encryptRoomMessage(roomId, content)
        : content;
      const res = await this.host.api<{ event_id?: string }>(
        "PUT",
        `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/send/${sendType}/${encodeURIComponent(txnId)}`,
        { body: payload }
      );
      if (res?.event_id) {
        echo.eventId = res.event_id;
        this.acknowledged.set(res.event_id, txnId);
        return res.event_id;
      }
      return null;
    } catch (err) {
      echo.pending = false;
      echo.failed = true;
      if (room) {
        this.host.notify({ room, newEvents: [{ kind: "echo-failed", txnId }] });
      }
      throw err;
    }
  }

  async editMessage(roomId: string, eventId: string, newBody: string): Promise<string | null> {
    return this.sendRoomEvent(roomId, "m.room.message", {
      msgtype: "m.text",
      body: `* ${newBody}`,
      "m.new_content": { msgtype: "m.text", body: newBody },
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
    });
  }

  async sendReaction(roomId: string, targetEventId: string, emoji: string): Promise<string | null> {
    return this.sendRoomEvent(roomId, "m.reaction", {
      "m.relates_to": { rel_type: "m.annotation", event_id: targetEventId, key: emoji },
    });
  }

  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<void> {
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    await this.host.api(
      "PUT",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`,
      { body: reason ? { reason } : {} }
    );
  }

  async replyMessage(
    roomId: string,
    parentEventId: string,
    parentSender: string,
    parentBody: string,
    body: string
  ): Promise<string | null> {
    return this.sendRoomEvent(roomId, "m.room.message", {
      msgtype: "m.text",
      body: `> <${parentSender}> ${parentBody}\n\n${body}`,
      "m.relates_to": { "m.in_reply_to": { event_id: parentEventId } },
    });
  }

  async setTyping(
    roomId: string,
    typing: boolean,
    timeoutMs = 30_000
  ): Promise<void> {
    const userId = this.host.userId ?? "";
    if (!userId) return;
    await this.host.api(
      "PUT",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`,
      { body: { typing, timeout: timeoutMs } }
    );
  }
}
