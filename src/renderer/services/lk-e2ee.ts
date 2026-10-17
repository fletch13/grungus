/*
 * Grungus — LiveKit-path E2EE media, Element-compatible.
 *
 * Element's group-call clients (Element Call / matrix-js-sdk & the rust
 * mobile SDK) encrypt media through livekit-client's own E2EE stack:
 * RoomOptions.e2ee = { keyProvider, worker } with per-participant keys.
 * The keys are distributed over Matrix:
 *
 *   - Element web/js-sdk: room events of type io.element.call.encryption_keys
 *     with content { keys: [{ index, key }], device_id, call_id: "" }
 *     (Megolm-wrapped inside encrypted rooms, so the homeserver can't read
 *     them — Grungus mirrors that via MatrixClient.sendRoomEvent).
 *   - Element mobile/rust: to-device org.matrix.msc4143.rtc.encryption_key
 *     events with a single { index, key } (parsed in matrix-client).
 *
 * Using livekit's own worker (draft-omara-sframe-00 AES-GCM frame format)
 * + Element's exact key transport makes Grungus↔Element encrypted calls
 * work BY CONSTRUCTION — both sides run the same frame cryptor and the
 * same key material derivation (raw 16-byte key imported as HKDF material).
 *
 * The livekit-client import is dynamic (runtime-only) so Node tests can
 * import this module's pure helpers without pulling browser code.
 */
import type { BaseKeyProvider } from "livekit-client";
import type { MatrixClient } from "./matrix-client.ts";

/** The room-event type Element's js-sdk both sends and receives. */
export const ELEMENT_ENCRYPTION_KEYS_TYPE = "io.element.call.encryption_keys";

/* ------------------------------ pure helpers ----------------------------- */

/** URL-safe unpadded base64 — the exact encoding the js-sdk uses for keys. */
export function encodeKeyMaterial(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Tolerant decode: accepts url-safe/standard base64, padded or not. */
export function decodeKeyMaterial(text: string): Uint8Array {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Event content in the js-sdk's exact shape (secureRandomBase64Url keys). */
export function buildEncryptionKeysEvent(
  keys: Array<{ index: number; key: string }>,
  deviceId: string
): Record<string, unknown> {
  return {
    keys: keys.map(({ index, key }) => ({ index, key })),
    device_id: deviceId,
    call_id: "",
  };
}

/**
 * To-device content in the current js-sdk's exact shape (ToDeviceKeyTransport):
 * a single media_key plus the deprecated `keys`/`member` fields older
 * receivers still read.
 */
export function buildEncryptionKeysToDeviceEvent(
  roomId: string,
  memberId: string,
  deviceId: string,
  index: number,
  key: string
): Record<string, unknown> {
  const mediaKey = { index, key };
  return {
    room_id: roomId,
    member_id: memberId,
    media_key: mediaKey,
    /* deprecated but sent for backwards compatibility */
    keys: mediaKey,
    member: {
      claimed_device_id: deviceId,
      /* deprecated but sent for backwards compatibility */
      id: memberId,
    },
  };
}

/** Parse a to-device io.element.call.encryption_keys payload. */
export function parseEncryptionKeysToDeviceEvent(
  content: Record<string, unknown>
): { index: number; key: string } | null {
  const mediaKey = content.media_key as
    | { index?: unknown; key?: unknown }
    | undefined;
  const fallback = (content.keys ?? null) as
    | { index?: unknown; key?: unknown }
    | null;
  const source = mediaKey && typeof mediaKey === "object" ? mediaKey : fallback;
  if (
    !source ||
    typeof source.index !== "number" ||
    typeof source.key !== "string" ||
    source.key === ""
  ) {
    return null;
  }
  return { index: source.index, key: source.key };
}

/**
 * Rotation bookkeeping: one sender key per index, indexes only ever grow.
 * Element's receivers keep every (index, key) they see, so frames sent
 * under an older index keep decrypting during a rotation window.
 */
export class KeyRotation {
  private _keys = new Map<number, string>();
  private _index = 0;

  get index(): number {
    return this._index;
  }

  /** All keys issued so far, oldest first (for the resend event). */
  all(): Array<{ index: number; key: string }> {
    return [...this._keys.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, key]) => ({ index, key }));
  }

  /** Issue a fresh key (16 random bytes) at the next index. */
  next(): { index: number; key: string; bytes: Uint8Array } {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const key = encodeKeyMaterial(bytes);
    this._keys.set(this._index, key);
    const index = this._index;
    this._index += 1;
    return { index, key, bytes };
  }
}

/* --------------------------- runtime E2EE wiring -------------------------- */

/** Shape livekit-client expects for RoomOptions.e2ee. */
export interface LkE2eeOptions {
  keyProvider: BaseKeyProvider;
  worker: Worker;
}

/** The minimal provider surface this class drives (livekit's method is
 *  protected on the base class — we subclass, exactly like Element's
 *  MatrixKeyProvider does, and expose it through this structural type). */
export interface GrungusKeyProviderLike {
  onSetEncryptionKey(
    key: CryptoKey,
    participantIdentity?: string,
    keyIndex?: number
  ): void;
}

export interface LkE2eeInit {
  client: MatrixClient;
  roomId: string;
  /** our livekit participant identity = our Matrix user id */
  identity: string;
  deviceId: string | null;
  /** same-origin worker script (bundled into dist/ by the build) */
  workerUrl?: string;
}

/**
 * Owns the LiveKit E2EE key provider + worker and the Matrix-side key
 * distribution for one call. Created per encrypted-room call, torn down
 * on leave.
 */
export class LkE2ee {
  readonly keyProvider: BaseKeyProvider;
  readonly worker: Worker;
  private _client: MatrixClient;
  private _roomId: string;
  private _identity: string;
  private _deviceId: string | null;
  private _rotation = new KeyRotation();
  private _unsubscribe: (() => void) | null = null;
  private _removePayloadListener: (() => void) | null = null;
  private _roomUpdateHandler: ((update: { room: { id: string } }) => void) | null = null;
  private _prevMemberIds = new Set<string>();
  private _lastSend = 0;
  private _resendTimer: ReturnType<typeof setInterval> | null = null;
  /* crypto-key cache per (sender|index) — re-importing on every resend
     would churn the worker; skip keys we already fed it */
  private _appliedKeys = new Set<string>();

  private constructor(
    keyProvider: BaseKeyProvider,
    worker: Worker,
    init: LkE2eeInit
  ) {
    this.keyProvider = keyProvider;
    this.worker = worker;
    this._client = init.client;
    this._roomId = init.roomId;
    this._identity = init.identity;
    this._deviceId = init.deviceId;
  }

  /** Build the provider (livekit BaseKeyProvider subclass) + worker. */
  static async create(init: LkE2eeInit): Promise<LkE2ee> {
    /* dynamic import: keeps this module Node-importable for tests */
    const lk = await import("livekit-client");
    /* Element's MatrixKeyProvider, mirrored: BaseKeyProvider subclass with
       per-participant keys and their exact option set */
    const keyProvider = new (class extends lk.BaseKeyProvider {
      constructor() {
        super({
          sharedKey: false,
          ratchetWindowSize: 10,
          keyringSize: 256,
        });
      }
    })()
    const workerUrl =
      init.workerUrl ??
      new URL("livekit-client.e2ee.worker.js", document.baseURI).href;
    const worker = new Worker(workerUrl);
    const e2ee = new LkE2ee(keyProvider, worker, init);

    /* our own sender key — set under our identity so livekit's local
       cryptor encrypts with it, and our own key echoes decrypt */
    await e2ee._issueKey();
    return e2ee;
  }

  get options(): LkE2eeOptions {
    return { keyProvider: this.keyProvider, worker: this.worker };
  }

  /** True when the local participant's identity matches ours. */
  isSelf(sender: string): boolean {
    return sender === this._identity;
  }

  /**
   * Wire Matrix-side key flow: receive other participants' keys, watch
   * call membership for joins (resend) and leaves (rotate), and arm a
   * periodic resend so late joiners converge.
   */
  start(): void {
    this._unsubscribe = this._client.onMediaKeys((event) => {
      if (event.roomId && event.roomId !== this._roomId) return;
      if (this.isSelf(event.sender)) return; /* our own key echo */
      void this._applyRemoteKeys(event.sender, event.keys);
    });
    /* keys from current Element clients arrive olm-encrypted as to-device
       io.element.call.encryption_keys — the crypto layer decrypts the
       envelope and hands the payload to listeners */
    const crypto = this._client.crypto;
    if (crypto) {
      this._removePayloadListener = crypto.addPayloadListener(
        (sender, type, content) => {
          if (type !== ELEMENT_ENCRYPTION_KEYS_TYPE) return;
          if (this.isSelf(sender)) return;
          const roomId = typeof content.room_id === "string" ? content.room_id : this._roomId;
          if (roomId !== this._roomId) return;
          const parsed = parseEncryptionKeysToDeviceEvent(content);
          if (!parsed) return;
          void this._applyRemoteKeys(sender, [parsed]);
        }
      );
    }
    /* membership-driven resend/rotation */
    this._roomUpdateHandler = (update) => {
      if (update.room.id !== this._roomId) return;
      const room = this._client.getRoom(this._roomId);
      const members = room?.rtcMemberships ?? [];
      const senders = new Set(members.map((m) => m.sender));
      const left = [...this._prevMemberIds].some(
        (id) => !senders.has(id) && id !== this._identity
      );
      const joined = [...senders].some((id) => !this._prevMemberIds.has(id));
      if (this._prevMemberIds.size > 0) {
        if (left) {
          /* someone left: rotate so they can't decrypt what follows */
          void this._issueKey();
        } else if (joined) {
          this.sendKeys();
        }
      }
      this._prevMemberIds = senders;
    };
    this._client.on("room", this._roomUpdateHandler);
    /* seed the membership snapshot from current state */
    const room = this._client.getRoom(this._roomId);
    this._prevMemberIds = new Set(
      (room?.rtcMemberships ?? []).map((m) => m.sender)
    );
    /* periodic resend (throttled) — covers late joiners and missed events */
    this._resendTimer = setInterval(() => this.sendKeys(), 60_000);
    this.sendKeys();
  }

  stop(): void {
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
    if (this._removePayloadListener) {
      this._removePayloadListener();
      this._removePayloadListener = null;
    }
    if (this._roomUpdateHandler) {
      this._client.off("room", this._roomUpdateHandler);
      this._roomUpdateHandler = null;
    }
    if (this._resendTimer) {
      clearInterval(this._resendTimer);
      this._resendTimer = null;
    }
  }

  /**
   * Send our key set as an io.element.call.encryption_keys room event
   * (Megolm-wrapped by the client in encrypted rooms). Throttled like
   * Element's UPDATE_ENCRYPTION_KEY_THROTTLE (3s).
   */
  sendKeys(): void {
    const now = Date.now();
    if (now - this._lastSend < 3_000) return;
    this._lastSend = now;
    const keys = this._rotation.all();
    if (keys.length === 0) return;
    void this._client
      .sendRoomEvent(
        this._roomId,
        ELEMENT_ENCRYPTION_KEYS_TYPE,
        buildEncryptionKeysEvent(keys, this._deviceId ?? "")
      )
      .catch((err) => console.warn("[lk-e2ee] key event send failed:", err));
    /* current element-call (and the rust SDKs) distribute keys as
       olm-encrypted to-device io.element.call.encryption_keys — send the
       same keys that way too, one event per key like their sender does */
    void this._sendKeysToDevice(keys).catch((err) =>
      console.warn("[lk-e2ee] to-device key send failed:", err)
    );
  }

  /**
   * The to-device transport current Element clients use: olm-encrypted
   * io.element.call.encryption_keys to every call member's device, with
   * the js-sdk's content shape (media_key + the deprecated keys/member
   * fields for older receivers). Their receiver silently drops keys that
   * arrive unencrypted, so this MUST ride the olm channel.
   */
  private async _sendKeysToDevice(
    keys: Array<{ index: number; key: string }>
  ): Promise<void> {
    const crypto = this._client.crypto;
    if (!crypto) return;
    const room = this._client.getRoom(this._roomId);
    const memberships = room?.rtcMemberships ?? [];
    /* resolve recipient devices: per-device memberships name the device;
       legacy merged memberships don't, so fall back to the user's device
       directory */
    const targets = new Map<string, Set<string>>();
    for (const membership of memberships) {
      if (!membership.sender || this.isSelf(membership.sender)) continue;
      const devices = targets.get(membership.sender) ?? new Set<string>();
      if (membership.deviceId) {
        devices.add(membership.deviceId);
      } else {
        try {
          for (const device of await crypto.getDevicesOf(membership.sender)) {
            devices.add(device.deviceId);
          }
        } catch {
          /* device directory unavailable — the room-event transport
             still covers this member */
        }
      }
      targets.set(membership.sender, devices);
    }
    for (const [userId, devices] of targets) {
      for (const deviceId of devices) {
        for (const { index, key } of keys) {
          try {
            await crypto.sendToDeviceEncrypted(
              userId,
              deviceId,
              ELEMENT_ENCRYPTION_KEYS_TYPE,
              buildEncryptionKeysToDeviceEvent(
                this._roomId,
                this._identity,
                this._deviceId ?? "",
                index,
                key
              )
            );
          } catch (err) {
            console.warn(
              `[lk-e2ee] key to ${userId}/${deviceId} failed:`,
              err instanceof Error ? err.message : err
            );
          }
        }
      }
    }
  }

  /** Generate + install a fresh sender key at the next index and ship it. */
  private async _issueKey(): Promise<void> {
    const { bytes, index } = this._rotation.next();
    const material = await crypto.subtle.importKey(
      "raw",
      bytes as BufferSource,
      "HKDF",
      false,
      ["deriveBits", "deriveKey"]
    );
    const provider = this.keyProvider as unknown as GrungusKeyProviderLike;
    provider.onSetEncryptionKey(material, this._identity, index);
    this._appliedKeys.add(`${this._identity}|${index}`);
    this.sendKeys();
  }

  /** Feed a participant's keys into the livekit key ring. */
  private async _applyRemoteKeys(
    sender: string,
    keys: Array<{ index: number; key: string }>
  ): Promise<void> {
    const provider = this.keyProvider as unknown as GrungusKeyProviderLike;
    for (const { index, key } of keys) {
      const cacheId = `${sender}|${index}`;
      if (this._appliedKeys.has(cacheId)) continue;
      let bytes: Uint8Array;
      try {
        bytes = decodeKeyMaterial(key);
      } catch {
        continue; /* malformed key — Element receivers skip these too */
      }
      const material = await crypto.subtle.importKey(
        "raw",
        bytes as BufferSource,
        "HKDF",
        false,
        ["deriveBits", "deriveKey"]
      );
      provider.onSetEncryptionKey(material, sender, index);
      this._appliedKeys.add(cacheId);
    }
  }
}
