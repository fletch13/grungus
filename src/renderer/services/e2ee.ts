/*
 * Grungus — E2EE (Olm/Megolm) via libolm (WASM), typed.
 *
 * The cryptography itself is handled by libolm (audited C, compiled to
 * WASM) — this module wires the Matrix protocol plumbing around it:
 *   - device identity (curve25519/ed25519) + key upload
 *   - one-time-key replenishment from sync counts
 *   - device key queries (/keys/query) and claims (/keys/claim)
 *   - olm sessions (prekey messages over /sendToDevice)
 *   - megolm outbound group sessions per room, with m.room_key sharing
 *     to every member device
 *   - decryption of m.room.encrypted room events and to-device payloads
 *
 * Known v1 limits (deliberate, documented in the README):
 *   - trust-on-first-use: device keys are not verified (no SAS UI);
 *     there is no cross-signing, no key backup, no key forwarding, and
 *     no room-key rotation on membership change.
 *   - identity/session pickles are stored via the injected CryptoStore
 *     (OS-keychain-encrypted file in Electron, localStorage in browser
 *     dev mode, memory in tests).
 */

import * as OlmNs from "@matrix-org/olm";

/* ------------------------ typed libolm API surface ----------------------- */

interface OlmAccountApi {
  create(): void;
  identity_keys(): string;
  sign(message: string | Uint8Array): string;
  one_time_keys(): string;
  mark_keys_as_published(): void;
  max_number_of_one_time_keys(): number;
  generate_one_time_keys(count: number): void;
  remove_one_time_keys(session: OlmSessionApi): void;
  pickle(key: string): string;
  unpickle(key: string, pickle: string): void;
  free(): void;
}

interface OlmSessionApi {
  create_outbound(account: OlmAccountApi, theirIdentityKey: string, theirOneTimeKey: string): void;
  create_inbound(account: OlmAccountApi, oneTimeKeyMessage: string): void;
  /** { type: 0 (prekey) | 1 (normal), body } — carry the type verbatim. */
  encrypt(plaintext: string): { type: number; body: string };
  decrypt(messageType: number, ciphertext: string): string;
  /** True when a prekey message belongs to this session. */
  matches_inbound(oneTimeKeyMessage: string): boolean;
  session_id(): string;
  pickle(key: string): string;
  unpickle(key: string, pickle: string): void;
  free(): void;
}

export interface OlmOutboundGroupSessionApi {
  create(): void;
  session_id(): string;
  session_key(): string;
  message_index(): number;
  encrypt(plaintext: string): string;
  pickle(key: string): string;
  unpickle(key: string, pickle: string): void;
  free(): void;
}

export interface OlmInboundGroupSessionApi {
  create(sessionKey: string): void;
  decrypt(ciphertext: string): { plaintext: string; message_index: number };
  session_id(): string;
  pickle(key: string): string;
  unpickle(key: string, pickle: string): void;
  free(): void;
}

export interface OlmSasApi {
  get_pubkey(): string;
  set_their_key(key: string): void;
  generate_bytes(info: string, length: number): Uint8Array;
  calculate_mac(input: string, info: string): string;
  free(): void;
}

export interface OlmApi {
  init(): Promise<void>;
  Account: new () => OlmAccountApi;
  Session: new () => OlmSessionApi;
  OutboundGroupSession: new () => OlmOutboundGroupSessionApi;
  InboundGroupSession: new () => OlmInboundGroupSessionApi;
  SAS: new () => OlmSasApi;
}

/**
 * Node ESM puts the emscripten wrapper under `.default`; the esbuild
 * browser bundle exposes it directly on the namespace. `.default` exists
 * in both — resolve once.
 */
function resolveOlm(): OlmApi {
  const candidate = (OlmNs as unknown as { default?: unknown }).default;
  if (candidate && typeof candidate === "object") {
    return candidate as OlmApi;
  }
  return OlmNs as unknown as OlmApi;
}

/* ------------------------------ wire shapes ------------------------------ */

/** Minimal host surface the crypto layer needs from the client. */
export interface CryptoHost {
  readonly baseUrl: string;
  accessToken: string | null;
  userId: string | null;
  deviceId: string | null;
  api<T>(method: string, path: string, opts?: ApiCallOptions): Promise<T>;
  getRoom(roomId: string): {
    id: string;
    members: Map<string, { userId: string; membership: string }>;
  } | null;
}

export interface ApiCallOptions {
  body?: unknown;
  auth?: boolean;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

export interface CryptoStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

/** In-memory store — used by tests and as a last-resort default. */
export class MemoryCryptoStore implements CryptoStore {
  private _data = new Map<string, string>();
  get(key: string): Promise<string | null> {
    return Promise.resolve(this._data.get(key) ?? null);
  }
  put(key: string, value: string): Promise<void> {
    this._data.set(key, value);
    return Promise.resolve();
  }
}

interface DeviceInfo {
  deviceId: string;
  curve25519: string;
  ed25519: string;
}

interface OutboundRoomRecord {
  sessionPickle: string;
  shared: boolean;
  messageCount: number;
}

const ONE_TIME_KEY_TARGET = 50;
const ONE_TIME_KEY_LOW_WATER = 25;
const MEGOLM_ROTATE_MESSAGES = 100;
const ALGORITHM_OLM = "m.olm.v1.curve25519-aes-sha2";
const ALGORITHM_MEGOLM = "m.megolm.v1.aes-sha2";
const STORE_ACCOUNT = "device:account";
const STORE_DEVICE_ID = "device:id";

/** Canonical JSON (sorted keys, no whitespace) — required for signatures. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJson).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(record)
      .sort()
      .map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key]))
      .join(",") +
    "}"
  );
}

export class E2eeCrypto {
  readonly host: CryptoHost;
  private readonly _store: CryptoStore;
  private readonly _pickleKey: string;
  private _olm: OlmApi | null = null;
  private _account: OlmAccountApi | null = null;
  private _deviceId: string;
  private _curve25519 = "";
  private _ed25519 = "";
  /** senderKey -> olm sessions (most recent first). */
  private readonly _olmSessions = new Map<string, OlmSessionApi[]>();
  /** userId -> devices (invalidated on device_lists.changed). */
  private readonly _deviceCache = new Map<string, DeviceInfo[]>();
  /** roomId -> outbound group session record. */
  private readonly _outbound = new Map<string, OutboundRoomRecord>();
  /** `${senderKey}|${sessionId}` -> inbound group session. */
  private readonly _inbound = new Map<
    string,
    { session: OlmInboundGroupSessionApi; roomId: string }
  >();
  private _txnCounter = 0;

  constructor(options: {
    host: CryptoHost;
    store?: CryptoStore;
    pickleKey?: string;
  }) {
    this.host = options.host;
    this._store = options.store ?? new MemoryCryptoStore();
    this._pickleKey = options.pickleKey ?? "grungus-e2ee";
    this._deviceId = this.host.deviceId ?? "";
  }

  get identityCurve25519(): string {
    return this._curve25519;
  }

  /* -------------------------------- init -------------------------------- */

  /** Load olm WASM, restore/create the device identity, upload keys. */
  async init(): Promise<void> {
    this._olm = resolveOlm();
    await this._olm.init();

    const storedDeviceId = await this._store.get(STORE_DEVICE_ID);
    this._deviceId = this.host.deviceId ?? storedDeviceId ?? this._deviceId;
    if (!this._deviceId) {
      this._deviceId = "GRUNGUS_" + Math.random().toString(16).slice(2, 10);
      await this._store.put(STORE_DEVICE_ID, this._deviceId);
    }

    const accountPickle = await this._store.get(STORE_ACCOUNT);
    const account = new this._olm.Account();
    if (accountPickle) {
      account.unpickle(this._pickleKey, accountPickle);
    } else {
      account.create();
      await this._store.put(STORE_ACCOUNT, account.pickle(this._pickleKey));
    }
    this._account = account;

    const keys = JSON.parse(account.identity_keys()) as {
      curve25519: string;
      ed25519: string;
    };
    this._curve25519 = keys.curve25519;
    this._ed25519 = keys.ed25519;

    /* restore persisted outbound sessions (pickles only; unpickle lazily) */
    await this._uploadKeys();
  }

  /* --------------------------- key upload/claim -------------------------- */

  private _sign(payload: Record<string, unknown>): string {
    return this._account!.sign(canonicalJson(payload));
  }

  private _signaturesFor(payload: Record<string, unknown>): {
    [userId: string]: { [keyId: string]: string };
  } {
    const userId = this.host.userId!;
    return {
      [userId]: {
        [`ed25519:${this._deviceId}`]: this._sign(payload),
      },
    };
  }

  /** Upload device keys and top up one-time keys. */
  private async _uploadKeys(generateCount?: number): Promise<void> {
    const account = this._account!;
    const userId = this.host.userId!;

    const deviceKeys: Record<string, unknown> = {
      user_id: userId,
      device_id: this._deviceId,
      algorithms: [ALGORITHM_OLM, ALGORITHM_MEGOLM],
      keys: {
        [`curve25519:${this._deviceId}`]: this._curve25519,
        [`ed25519:${this._deviceId}`]: this._ed25519,
      },
    };
    deviceKeys.signatures = this._signaturesFor({ ...deviceKeys });

    const body: Record<string, unknown> = { device_keys: deviceKeys };

    if (generateCount && generateCount > 0) {
      account.generate_one_time_keys(generateCount);
      const raw = JSON.parse(account.one_time_keys()) as Record<
        string,
        Record<string, string>
      >;
      const oneTimeKeys: Record<string, unknown> = {};
      for (const [_namespace, keysById] of Object.entries(raw)) {
        for (const [keyId, keyValue] of Object.entries(keysById)) {
          const signedKey: Record<string, unknown> = { key: keyValue };
          signedKey.signatures = this._signaturesFor({ ...signedKey });
          /* the account reports the raw "curve25519" namespace; on the wire,
             signed one-time keys are "signed_curve25519:<id>" (colon!) */
          oneTimeKeys[`signed_curve25519:${keyId}`] = signedKey;
        }
      }
      body.one_time_keys = oneTimeKeys;
    }

    const res = await this.host.api<{
      one_time_key_counts?: Record<string, number>;
    }>("POST", "/_matrix/client/v3/keys/upload", { body });

    account.mark_keys_as_published();
    await this._store.put(STORE_ACCOUNT, account.pickle(this._pickleKey));

    const remaining = res.one_time_key_counts?.["signed_curve25519"] ?? 0;
    if (remaining < ONE_TIME_KEY_LOW_WATER) {
      /* replenish inline so init() leaves the device with a full OTK set */
      await this._replenish(remaining);
    }
  }

  private async _replenish(remaining: number): Promise<void> {
    const wanted = ONE_TIME_KEY_TARGET - remaining;
    if (wanted <= 0) return;
    await this._uploadKeys(wanted);
  }

  /** sync hook: device_one_time_keys_count. */
  async onOneTimeKeyCounts(counts: Record<string, number> | undefined): Promise<void> {
    if (!counts) return;
    const remaining = counts["signed_curve25519"];
    if (remaining != null && remaining < ONE_TIME_KEY_LOW_WATER) {
      await this._replenish(remaining);
    }
  }

  /** sync hook: device_lists.changed — drop cache so we re-query. */
  onDeviceListChange(userIds: string[]): void {
    for (const userId of userIds) this._deviceCache.delete(userId);
    /* re-share room keys on the next send so new devices can read */
    for (const record of this._outbound.values()) {
      record.shared = false;
    }
  }

  /**
   * Handlers for olm-decrypted to-device payloads that are NOT room keys
   * (MSC3401 call signaling, SAS verification). Register via
   * addPayloadListener; returns an unsubscribe function.
   */
  private readonly _payloadListeners = new Set<
    (sender: string, type: string, content: Record<string, unknown>) => void
  >();

  addPayloadListener(
    cb: (sender: string, type: string, content: Record<string, unknown>) => void
  ): () => void {
    this._payloadListeners.add(cb);
    return () => this._payloadListeners.delete(cb);
  }

  /* SAS verification surface (see services/sas.ts) */

  get deviceId(): string {
    return this._deviceId;
  }

  get ed25519Key(): string {
    return this._ed25519;
  }

  createSas(): OlmSasApi {
    return new this._olm!.SAS();
  }

  /** Public device directory (for starting verifications). */
  async getDevicesOf(userId: string): Promise<DeviceInfo[]> {
    return this.getUserDevices(userId);
  }

  /** The Ed25519 key the server has published for a device. */
  async getDeviceEd25519(userId: string, deviceId: string): Promise<string | null> {
    const devices = await this.getUserDevices(userId);
    return devices.find((device) => device.deviceId === deviceId)?.ed25519 ?? null;
  }

  /** Record a SAS-verified device key (trust replaces TOFU for the pair). */
  async markDeviceVerified(
    userId: string,
    deviceId: string,
    ed25519: string
  ): Promise<void> {
    await this._store.put(`verified:${userId}:${deviceId}`, ed25519);
  }

  /** The verified Ed25519 key for a device, or null when unverified. */
  async getVerifiedKey(userId: string, deviceId: string): Promise<string | null> {
    return this._store.get(`verified:${userId}:${deviceId}`);
  }

  /**
   * Send an olm-encrypted to-device message of an arbitrary type to one
   * device (MSC3401 call signaling in encrypted rooms uses this).
   */
  async sendToDeviceEncrypted(
    targetUserId: string,
    targetDeviceId: string,
    type: string,
    content: Record<string, unknown>
  ): Promise<void> {
    const devices = await this.getUserDevices(targetUserId);
    const device = devices.find((d) => d.deviceId === targetDeviceId);
    if (!device) throw new Error(`unknown device ${targetUserId}/${targetDeviceId}`);
    const session = await this.getOrCreateOlmSession(device, targetUserId);
    if (!session) throw new Error(`no olm session to ${targetUserId}/${targetDeviceId}`);

    const payload = JSON.stringify({ type, content, sender: this.host.userId });
    const encrypted = session.encrypt(payload);
    const messages: Record<string, Record<string, unknown>> = {
      [targetUserId]: {
        [targetDeviceId]: {
          algorithm: ALGORITHM_OLM,
          sender_key: this._curve25519,
          ciphertext: {
            [device.curve25519]: {
              type: encrypted.type,
              body: encrypted.body,
            },
          },
          recipient_keys: { [`ed25519:${device.deviceId}`]: device.ed25519 },
        },
      },
    };
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    await this.host.api(
      "PUT",
      `/_matrix/client/v3/sendToDevice/m.room.encrypted/${encodeURIComponent(txnId)}`,
      { body: { messages } }
    );
  }

  /* --------------------------- device discovery --------------------------- */

  private async getUserDevices(userId: string): Promise<DeviceInfo[]> {
    const cached = this._deviceCache.get(userId);
    if (cached) return cached;
    const res = await this.host.api<{
      device_keys?: Record<string, Record<string, { keys?: Record<string, string> }>>;
    }>("POST", "/_matrix/client/v3/keys/query", {
      body: { device_keys: { [userId]: [] } },
    });
    const devices: DeviceInfo[] = [];
    const deviceMap = res.device_keys?.[userId] ?? {};
    for (const [deviceId, info] of Object.entries(deviceMap)) {
      const keys = info.keys ?? {};
      const curve = keys[`curve25519:${deviceId}`];
      const ed = keys[`ed25519:${deviceId}`];
      if (!curve || !ed) continue;
      devices.push({ deviceId, curve25519: curve, ed25519: ed });
    }
    this._deviceCache.set(userId, devices);
    return devices;
  }

  /** Claim one-time keys for the given devices. */
  private async claimOneTimeKeys(
    targets: { userId: string; deviceId: string }[]
  ): Promise<Map<string, Map<string, string>>> {
    /* Map<userId, Map<deviceId, otkValue>> */
    const claimBody: Record<string, Record<string, string>> = {};
    for (const target of targets) {
      claimBody[target.userId] = claimBody[target.userId] ?? {};
      claimBody[target.userId]![target.deviceId] = "signed_curve25519";
    }
    const res = await this.host.api<{
      one_time_keys?: Record<
        string,
        Record<string, Record<string, { key?: string }>>
      >;
    }>("POST", "/_matrix/client/v3/keys/claim", {
      body: { one_time_keys: claimBody },
    });
    const out = new Map<string, Map<string, string>>();
    for (const [userId, deviceMap] of Object.entries(res.one_time_keys ?? {})) {
      for (const [deviceId, keyMap] of Object.entries(deviceMap)) {
        for (const keyObject of Object.values(keyMap)) {
          if (!keyObject.key) continue;
          if (!out.has(userId)) out.set(userId, new Map());
          out.get(userId)!.set(deviceId, keyObject.key);
          break; /* one OTK per device */
        }
      }
    }
    return out;
  }

  /* ----------------------------- olm sessions ----------------------------- */

  private async getOrCreateOlmSession(device: DeviceInfo, userId: string): Promise<OlmSessionApi | null> {
    const olm = this._olm!;
    const existing = this._olmSessions.get(device.curve25519);
    if (existing && existing.length > 0) return existing[0]!;

    const claimed = await this.claimOneTimeKeys([
      { userId, deviceId: device.deviceId },
    ]);
    const otk = claimed.get(userId)?.get(device.deviceId);
    if (!otk) return null; /* device has no OTKs (e.g. offline); skip */

    const session = new olm.Session();
    session.create_outbound(this._account!, device.curve25519, otk);
    this._rememberOlmSession(device.curve25519, session);
    return session;
  }

  private _rememberOlmSession(senderKey: string, session: OlmSessionApi): void {
    const list = this._olmSessions.get(senderKey) ?? [];
    list.unshift(session);
    this._olmSessions.set(senderKey, list);
  }

  /* ------------------------------ megolm send ----------------------------- */

  /**
   * Ensure the room's outbound group session exists and its key is shared
   * with every member device, then encrypt one plaintext payload.
   */
  async encryptRoomMessage(roomId: string, content: Record<string, unknown>): Promise<{
    algorithm: string;
    sender_key: string;
    ciphertext: string;
    session_id: string;
    device_id: string;
  }> {
    const olm = this._olm!;
    const record = await this._ensureOutboundSession(roomId);
    const ogs = new olm.OutboundGroupSession();
    ogs.unpickle(this._pickleKey, record.sessionPickle);

    if (!record.shared || record.messageCount >= MEGOLM_ROTATE_MESSAGES) {
      await this._shareRoomKey(roomId, ogs);
      record.shared = true;
    }

    const payload = JSON.stringify({
      type: "m.room.message",
      content,
      room_id: roomId,
    });
    const ciphertext = ogs.encrypt(payload);
    record.messageCount += 1;
    record.sessionPickle = ogs.pickle(this._pickleKey);
    await this._store.put(this._storeKeyOutbound(roomId), JSON.stringify(record));

    return {
      algorithm: ALGORITHM_MEGOLM,
      sender_key: this._curve25519,
      ciphertext,
      session_id: ogs.session_id(),
      device_id: this._deviceId,
    };
  }

  private async _ensureOutboundSession(roomId: string): Promise<OutboundRoomRecord> {
    const existing = this._outbound.get(roomId);
    if (existing) return existing;
    const stored = await this._store.get(this._storeKeyOutbound(roomId));
    if (stored) {
      const record = JSON.parse(stored) as OutboundRoomRecord;
      this._outbound.set(roomId, record);
      return record;
    }
    const record: OutboundRoomRecord = {
      sessionPickle: "",
      shared: false,
      messageCount: 0,
    };
    const ogs = new this._olm!.OutboundGroupSession();
    ogs.create();
    record.sessionPickle = ogs.pickle(this._pickleKey);
    this._outbound.set(roomId, record);
    await this._store.put(this._storeKeyOutbound(roomId), JSON.stringify(record));
    return record;
  }

  /** Share the megolm session key with every joined member's devices. */
  private async _shareRoomKey(roomId: string, ogs: OlmOutboundGroupSessionApi): Promise<void> {
    const room = this.host.getRoom(roomId);
    if (!room) return;

    /* session_key must be captured at the CURRENT ratchet index; receivers
       create inbound sessions at that index. */
    const sessionKey = ogs.session_key();
    const roomKeyPayload = {
      type: "m.room_key",
      content: {
        algorithm: ALGORITHM_MEGOLM,
        room_id: roomId,
        session_id: ogs.session_id(),
        session_key: sessionKey,
      },
    };
    const plaintext = JSON.stringify(roomKeyPayload);

    const memberIds = new Set<string>();
    for (const member of room.members.values()) {
      if (member.membership === "join") memberIds.add(member.userId);
    }
    memberIds.add(this.host.userId!);

    const messages: Record<string, Record<string, unknown>> = {};
    let sharedWithAny = false;

    for (const userId of memberIds) {
      const devices = await this.getUserDevices(userId);
      for (const device of devices) {
        /* sharing includes ALL own devices (current one too) so the
           sender can read their own messages and other own devices stay
           in sync — mirroring Element's behavior */
        try {
          const session = await this.getOrCreateOlmSession(device, userId);
          if (!session) continue;
          const encrypted = session.encrypt(plaintext);
          messages[userId] = messages[userId] ?? {};
          messages[userId]![device.deviceId] = {
            algorithm: ALGORITHM_OLM,
            sender_key: this._curve25519,
            ciphertext: {
              [device.curve25519]: {
                type: encrypted.type,
                body: encrypted.body,
              },
            },
            recipient_keys: { [`ed25519:${device.deviceId}`]: device.ed25519 },
            payload_kind: "ciphertext",
          };
          sharedWithAny = true;
        } catch (err) {
          console.error(`[e2ee] failed to share room key with ${userId}/${device.deviceId}:`, err);
        }
      }
    }

    if (sharedWithAny) {
      const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
      await this.host.api(
        "PUT",
        `/_matrix/client/v3/sendToDevice/m.room.encrypted/${encodeURIComponent(txnId)}`,
        { body: { messages } }
      );
    }
  }

  /* ------------------------------ megolm recv ----------------------------- */

  /** sync hook: to_device events. */
  onToDeviceEvents(events: MatrixWireEvent[]): void {
    for (const event of events) {
      if (event.type !== "m.room.encrypted" || !event.content) continue;
      this._handleOlmEvent(event);
    }
  }

  private _handleOlmEvent(event: MatrixWireEvent): void {
    const content = event.content as {
      sender_key?: string;
      ciphertext?: Record<string, { type: number; body: string }>;
    };
    const senderKey = content.sender_key;
    const ciphertextMap = content.ciphertext;
    if (!senderKey || !ciphertextMap) return;

    const forUs = ciphertextMap[this._curve25519] ?? Object.values(ciphertextMap)[0];
    if (!forUs) return;

    const plaintext = this._decryptWithOlm(senderKey, forUs.type, forUs.body);
    if (!plaintext) return;

    let payload: { type?: string; content?: Record<string, unknown> };
    try {
      payload = JSON.parse(plaintext);
    } catch {
      return;
    }
    if (!payload.type || !payload.content) return;

    if (payload.type === "m.room_key") {
      this._ingestRoomKey(senderKey, payload.content);
    } else {
      /* other olm-protected payloads (call signaling, SAS verification) */
      for (const listener of [...this._payloadListeners]) {
        try {
          listener(event.sender, payload.type, payload.content);
        } catch (err) {
          console.error("[e2ee] payload listener failed:", err);
        }
      }
    }
  }

  private _ingestRoomKey(senderCurve25519: string, roomKey: Record<string, unknown>): void {
    const roomId = typeof roomKey.room_id === "string" ? roomKey.room_id : null;
    const sessionId = typeof roomKey.session_id === "string" ? roomKey.session_id : null;
    const sessionKey = typeof roomKey.session_key === "string" ? roomKey.session_key : null;
    if (!roomId || !sessionId || !sessionKey) return;

    const olm = this._olm!;
    const igs = new olm.InboundGroupSession();
    try {
      igs.create(sessionKey);
    } catch (err) {
      console.error("[e2ee] bad inbound session key:", err);
      return;
    }
    /* indexed by the sender's curve25519 key — that is what m.room.encrypted
       events carry in content.sender_key, and what decryptRoomEvent uses */
    this._inbound.set(`${senderCurve25519}|${sessionId}`, {
      session: igs,
      roomId,
    });
  }

  private _decryptWithOlm(senderKey: string, type: number, body: string): string | null {
    const olm = this._olm!;
    /* existing sessions first */
    const sessions = this._olmSessions.get(senderKey) ?? [];
    for (const session of sessions) {
      try {
        if (type === 0 && !session.matches_inbound(body)) continue;
        return session.decrypt(type, body);
      } catch {
        /* wrong session — keep trying */
      }
    }
    if (type !== 0) return null; /* normal message without a session: undecryptable */

    /* prekey message for a session we do not have yet — create one. The
       account matches the message against its one-time keys internally. */
    const session = new olm.Session();
    try {
      session.create_inbound(this._account!, body);
      const plaintext = session.decrypt(type, body);
      this._account!.remove_one_time_keys(session);
      this._rememberOlmSession(senderKey, session);
      return plaintext;
    } catch (err) {
      console.error("[e2ee] inbound olm session failed:", err);
      return null;
    }
  }

  /**
   * Decrypt an m.room.encrypted room event. Returns the inner event
   * {type, content} or null when it cannot be decrypted.
   */
  decryptRoomEvent(event: MatrixWireEvent): { type: string; content: Record<string, unknown> } | null {
    const content = event.content as {
      algorithm?: string;
      sender_key?: string;
      session_id?: string;
      ciphertext?: string;
    };
    if (
      content.algorithm !== ALGORITHM_MEGOLM ||
      !content.sender_key ||
      !content.session_id ||
      !content.ciphertext
    ) {
      return null;
    }
    const entry = this._inbound.get(`${content.sender_key}|${content.session_id}`);
    if (!entry) return null; /* room key not shared with this device */
    try {
      const result = entry.session.decrypt(content.ciphertext);
      const payload = JSON.parse(result.plaintext) as {
        type?: string;
        content?: Record<string, unknown>;
      };
      if (!payload.type || !payload.content) return null;
      return { type: payload.type, content: payload.content };
    } catch {
      return null; /* ratcheted past, wrong session, or corrupted */
    }
  }

  private _storeKeyOutbound(roomId: string): string {
    return `og:${roomId}`;
  }
}

/* minimal event shape used on the to-device path (avoids a client import) */
export interface MatrixWireEvent {
  type: string;
  sender: string;
  content: unknown;
  event_id?: string;
  origin_server_ts?: number;
}
