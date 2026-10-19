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
 * Device trust and recovery:
 *   - SAS/QR verification and cross-signing are provided by the verification
 *     and cross-signing services. Outbound keys are shared with all joined
 *     member devices, including unverified devices.
 *   - Backup/restore, own-device and verified-device forwarding, and outbound
 *     session rotation on membership changes are supported here.
 *   - Identity/session pickles use the injected CryptoStore (safeStorage-backed
 *     vault in Electron, localStorage in browser dev mode, memory in tests).
 */

import * as OlmNs from "@matrix-org/olm";
import { SecretStorage, tryDecodeRecoveryKey } from "./ssss.ts";

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
  /** Import a forwarded (exported) megolm session key. */
  import_session(sessionKey: string): string;
  decrypt(ciphertext: string): { plaintext: string; message_index: number };
  session_id(): string;
  /** Earliest chain index this session can decrypt from. */
  first_known_index(): number;
  /** Export the session at a chain index (for forwarding to other devices). */
  export_session(messageIndex: number): string;
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
  PkEncryption: new () => OlmPkEncryptionApi;
  PkDecryption: new () => OlmPkDecryptionApi;
  PkSigning: new () => OlmPkSigningApi;
  Utility: new () => OlmUtilityApi;
}

export interface OlmPkSigningApi {
  generate_seed(): Uint8Array;
  init_with_seed(seed: Uint8Array): string;
  sign(message: string): string;
  free(): void;
}

export interface OlmUtilityApi {
  ed25519_verify(key: string, message: string, signature: string): void;
  free(): void;
}

export interface OlmPkEncryptionApi {
  set_recipient_key(key: string): void;
  encrypt(plaintext: string): { ciphertext: string; mac: string; ephemeral: string };
  free(): void;
}

export interface OlmPkDecryptionApi {
  /** Derive a keypair from raw private-key bytes; returns the public key. */
  init_with_private_key(key: Uint8Array): string;
  generate_key(): string;
  get_private_key(): Uint8Array;
  decrypt(ephemeralKey: string, mac: string, ciphertext: string): string;
  pickle(key: string): string;
  unpickle(key: string, pickle: string): void;
  free(): void;
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
    isDirect?: boolean;
    directUserId?: string | null;
    members: Map<string, { userId: string; membership: string }>;
  } | null;
  /** account data by event type (secret storage / recovery restore) */
  getAccountData(type: string): Record<string, unknown> | null;
  setAccountData(type: string, content: Record<string, unknown>): Promise<void>;
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
  /** set when the session was discarded (membership rotation) — next send creates a fresh one */
  discarded?: boolean;
}

const ONE_TIME_KEY_TARGET = 50;
const ONE_TIME_KEY_LOW_WATER = 25;
const MEGOLM_ROTATE_MESSAGES = 100;
const ALGORITHM_OLM = "m.olm.v1.curve25519-aes-sha2";
const ALGORITHM_MEGOLM = "m.megolm.v1.aes-sha2";
const STORE_ACCOUNT = "device:account";
const STORE_DEVICE_ID = "device:id";
const BACKUP_ALGORITHM = "m.megolm_backup.v1.curve25519-aes-sha2";
const BACKUP_DEFAULT_ITERATIONS = 500_000;

/**
 * Thrown when the local crypto store was lost while the session stayed
 * logged in: the server still holds device keys for our device id, but
 * we just generated a FRESH olm identity. Uploading cannot fix this —
 * the server keeps handing out the OLD account's one-time keys, every
 * self-share dies with OLM.BAD_MESSAGE_KEY_ID, and the sender's own
 * messages turn UTD (observed live). The only correct recovery is a
 * fresh login, which mints a new device id.
 */
export class CryptoIdentityResetError extends Error {
  constructor(deviceId: string) {
    super(
      `This device's encryption keys no longer match the server ` +
        `(local crypto data was reset while the session stayed logged in). ` +
        `Logging out — please log in again to create a fresh device. ` +
        `[device ${deviceId}]`
    );
    this.name = "CryptoIdentityResetError";
  }
}

/** Backup version info as stored by the homeserver. */
export interface KeyBackupVersion {
  version: string;
  algorithm: string;
  auth_data: {
    public_key?: string;
    private_key_salt?: string;
    private_key_iterations?: number;
    private_key_bits?: number;
    passphrase?: { algorithm?: string; iterations?: number; salt?: string; bits?: number };
  };
  count?: number;
  etag?: string;
}

/** unpadded/url-safe-tolerant base64 → bytes */
function b64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(normalized);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** PBKDF2-HMAC-SHA-512 → 256-bit curve25519 private key (js-sdk compatible). */
async function deriveBackupKey(
  passphrase: string,
  salt: string,
  iterations: number,
  bits = 256
): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle;
  const enc = new TextEncoder();
  const key = await subtle.importKey("raw", enc.encode(passphrase), { name: "PBKDF2" }, false, [
    "deriveBits",
  ]);
  const derived = await subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: enc.encode(salt),
      iterations,
      hash: "SHA-512",
    },
    key,
    bits
  );
  return new Uint8Array(derived);
}

function randomSalt(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

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
  private _deviceKeysUploaded = false;
  private _pendingPersistence: Promise<void> = Promise.resolve();
  private _stateKey(): string { return `sessions:${this.host.userId}:${this._deviceId}`; }

  /** Serialize snapshots so concurrent sync/recovery writes cannot roll keys back. */
  private _persistSessions(): Promise<void> {
    if (!this._account) return Promise.resolve();
    const value = JSON.stringify({
      identity: this._curve25519,
      account: this._account.pickle(this._pickleKey),
      olm: [...this._olmSessions].map(([sender, sessions]) => [sender, sessions.map(session => session.pickle(this._pickleKey))]),
      inbound: [...this._inbound].map(([key, entry]) => [key, entry.roomId, entry.session.pickle(this._pickleKey)]),
    });
    this._pendingPersistence = this._pendingPersistence.catch(() => {}).then(() => this._store.put(this._stateKey(), value));
    void this._pendingPersistence.catch(error => console.error("[e2ee] failed to persist received keys:", error));
    return this._pendingPersistence;
  }
  async flush(): Promise<void> { await this._pendingPersistence; }

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
  /** room-key requests already sent (dedup per session). */
  private readonly _requestedKeys = new Set<string>();
  private _txnCounter = 0;

  /**
   * Client hook: a new inbound group session landed (forwarded room key).
   * The client uses it to retry decrypting tracked "unable to decrypt"
   * events.
   */
  onInboundSessionAdded: ((roomId: string) => void) | null = null;

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
    if (this.host.deviceId && storedDeviceId && storedDeviceId !== this.host.deviceId) {
      /* the pickled account belongs to a DIFFERENT device (e.g. a stale
         client-generated id, or another session's device): the olm account
         is useless with this token — start a fresh device identity */
      console.warn(
        `[e2ee] stored device ${storedDeviceId} does not match the login device ${this.host.deviceId} — resetting the crypto identity`
      );
      this._deviceId = this.host.deviceId;
      await this._store.put(STORE_DEVICE_ID, this._deviceId);
      await this._store.put(STORE_ACCOUNT, ""); /* force a fresh account below */
    }
    if (!this._deviceId) {
      this._deviceId = "GRUNGUS_" + Math.random().toString(16).slice(2, 10);
      await this._store.put(STORE_DEVICE_ID, this._deviceId);
    }

    const savedState = await this._store.get(this._stateKey());
    const state = savedState ? JSON.parse(savedState) as { identity: string; account: string; olm: [string, string[]][]; inbound: [string, string, string][] } : null;
    const accountPickle = state?.account ?? await this._store.get(STORE_ACCOUNT);
    const account = new this._olm.Account();
    if (accountPickle) {
      account.unpickle(this._pickleKey, accountPickle);
    } else {
      account.create();
      /*
       * SPLIT-BRAIN GUARD: a fresh identity under a device id the server
       * already knows means the crypto store was wiped while the session
       * stayed logged in (settings "reset", cleared browser storage…).
       * The server keeps the OLD account's identity + one-time keys for
       * that device id, so this fresh account can never receive olm
       * messages for it (self-shares fail with OLM.BAD_MESSAGE_KEY_ID
       * and the sender's own messages show UTD). Refuse to continue;
       * the app logs the user out so the next login mints a fresh
       * device id. A genuine first login passes: no keys published yet.
       */
      if (this.host.userId && this.host.deviceId) {
        try {
          const known = await this.host.api<{
            device_keys?: Record<string, Record<string, unknown>>;
          }>("POST", "/_matrix/client/v3/keys/query", {
            body: { device_keys: { [this.host.userId]: [] } },
          });
          const published = known.device_keys?.[this.host.userId]?.[this.host.deviceId] as
            | { keys?: Record<string, unknown> }
            | undefined;
          /* only a device that actually PUBLISHED keys counts — servers
             don't list keyless devices in keys/query, and an empty
             object must not trip the guard */
          if (published && published.keys && Object.keys(published.keys).length > 0) {
            account.free();
            throw new CryptoIdentityResetError(this.host.deviceId);
          }
        } catch (err) {
          if (err instanceof CryptoIdentityResetError) throw err;
          /* keys/query unreachable (offline?) — proceed; a later send
             will surface any mismatch through its own error path */
        }
      }
      await this._store.put(STORE_ACCOUNT, account.pickle(this._pickleKey));
    }
    this._account = account;

    const keys = JSON.parse(account.identity_keys()) as {
      curve25519: string;
      ed25519: string;
    };
    this._curve25519 = keys.curve25519;
    this._ed25519 = keys.ed25519;

    if (state && state.identity === this._curve25519) {
      for (const [sender, pickles] of state.olm) {
        this._olmSessions.set(sender, pickles.map(pickle => {
          const session = new this._olm!.Session(); session.unpickle(this._pickleKey, pickle); return session;
        }));
      }
      for (const [key, roomId, pickle] of state.inbound) {
        const session = new this._olm.InboundGroupSession(); session.unpickle(this._pickleKey, pickle);
        this._inbound.set(key, { roomId, session });
      }
    }
    await this._store.put(STORE_DEVICE_ID, this._deviceId);
    /* A key top-up must not replace the published device's cross-signatures. */
    if (accountPickle) {
      const published = (await this.getRawDeviceKeys(this.host.userId!))[this._deviceId];
      if (published) {
        if (published.keys[`ed25519:${this._deviceId}`] !== this._ed25519 || published.keys[`curve25519:${this._deviceId}`] !== this._curve25519) {
          throw new CryptoIdentityResetError(this._deviceId);
        }
        this._deviceKeysUploaded = true;
      }
    }
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

    const body: Record<string, unknown> = this._deviceKeysUploaded ? {} : { device_keys: deviceKeys };

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

    this._deviceKeysUploaded = true;
    account.mark_keys_as_published();
    await this._store.put(STORE_ACCOUNT, account.pickle(this._pickleKey));
    await this._persistSessions();

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
    (sender: string, type: string, content: Record<string, unknown>, senderKey?: string) => void
  >();

  addPayloadListener(
    cb: (sender: string, type: string, content: Record<string, unknown>, senderKey?: string) => void
  ): () => boolean {
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

  /** This device's Curve25519 identity key (unpadded base64). */
  get curve25519Key(): string {
    return this._curve25519;
  }

  /** The olm module (for cross-signing PkSigning/Utility access). */
  get olmModule(): OlmApi | null {
    return this._olm;
  }

  /** The crypto store (cross-signing private seeds live here). */
  get store(): CryptoStore {
    return this._store;
  }

  /** Sign a message with this device's Ed25519 key (olm account sign). */
  signWithDevice(message: string): string {
    if (!this._account) throw new Error("olm account not initialised");
    return this._account.sign(message);
  }

  /**
   * Raw device-key entries for a user as published by /keys/query —
   * includes the signatures map (SSK device signatures for the
   * cross-signing trust chain).
   */
  async getRawDeviceKeys(
    userId: string
  ): Promise<Record<string, { algorithms: string[]; keys: Record<string, string>; signatures?: Record<string, Record<string, string>> }>> {
    /* re-query (bypasses the parsed cache) */
    const res = await this.host.api<{
      device_keys?: Record<
        string,
        Record<string, { algorithms?: string[]; keys?: Record<string, string>; signatures?: Record<string, Record<string, string>> } | undefined>
      >;
    }>("POST", "/_matrix/client/v3/keys/query", {
      body: { device_keys: { [userId]: [] } },
    });
    const entries = res.device_keys?.[userId] ?? {};
    const out: Record<string, { algorithms: string[]; keys: Record<string, string>; signatures?: Record<string, Record<string, string>> }> = {};
    for (const [deviceId, entryOpt] of Object.entries(entries)) {
      const entry = entryOpt ?? { algorithms: [], keys: {} };
      const keys = entry.keys ?? {};
      /* cross-signing pseudo-entries (ed25519-only) are not devices */
      if (!keys[`curve25519:${deviceId}`]) continue;
      out[deviceId] = {
        algorithms: entry.algorithms ?? [],
        keys,
        signatures: entry.signatures,
      };
    }
    return out;
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
    return devices.find((d) => d.deviceId === deviceId)?.ed25519 ?? null;
  }

  /** A device's Curve25519 identity key from the server directory. */
  async getDeviceCurve25519(userId: string, deviceId: string): Promise<string | null> {
    const devices = await this.getUserDevices(userId);
    return devices.find((d) => d.deviceId === deviceId)?.curve25519 ?? null;
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
   * A PLAINTEXT verification event arrived (Element's rust stack sends
   * m.key.verification.request/ready/done/cancel unencrypted — only the
   * key/MAC exchange rides olm). Route it to the payload listeners; the
   * verification manager filters what it understands.
   */
  handlePlainToDevice(sender: string, type: string, content: Record<string, unknown>): void {
    for (const listener of [...this._payloadListeners]) {
      try {
        listener(sender, type, content, undefined);
      } catch (err) {
        console.error("[e2ee] payload listener failed:", err);
      }
    }
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
    const device = await this.findDevice(targetUserId, targetDeviceId);
    if (!device) throw new Error(`unknown device ${targetUserId}/${targetDeviceId}`);
    const session = await this.getOrCreateOlmSession(device, targetUserId);
    if (!session) throw new Error(`no olm session to ${targetUserId}/${targetDeviceId}`);

    /* the olm v1 PDU per the spec: rust parsers (element's stack)
       REQUIRE sender/recipient/keys fields — libolm only handles the
       envelope, the plaintext payload is ours to shape */
    const payload = JSON.stringify({
      type,
      content,
      sender: this.host.userId,
      sender_device: this.deviceId,
      keys: { ed25519: this._ed25519 },
      recipient: targetUserId,
      recipient_keys: { ed25519: device.ed25519 },
    });
    const encrypted = session.encrypt(payload);
    await this._persistSessions();
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
    return this._queryDevices(userId);
  }

  /**
   * Find one device of a user, re-querying the directory once when the id
   * is not in our cache (the device may have come online after we cached).
   */
  private async findDevice(userId: string, deviceId: string): Promise<DeviceInfo | null> {
    const list = await this.getUserDevices(userId);
    const found = list.find((device) => device.deviceId === deviceId) ?? null;
    if (found) return found;
    this._deviceCache.delete(userId);
    const refreshed = await this._queryDevices(userId);
    return refreshed.find((device) => device.deviceId === deviceId) ?? null;
  }

  private async _queryDevices(userId: string): Promise<DeviceInfo[]> {
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
    void this._persistSessions();
  }

  /* ------------------------------ megolm send ----------------------------- */

  /**
   * Ensure the room's outbound group session exists and its key is shared
   * with every member device, then encrypt one plaintext payload.
   */
  async encryptRoomMessage(
    roomId: string,
    content: Record<string, unknown>,
    type = "m.room.message"
  ): Promise<{
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
      type,
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
    if (existing && !existing.discarded) return existing;
    const stored = await this._store.get(this._storeKeyOutbound(roomId));
    if (!existing && stored) {
      const record = JSON.parse(stored) as OutboundRoomRecord;
      if (!record.discarded) {
        this._outbound.set(roomId, record);
        return record;
      }
      /* tombstone from a rotation — fall through and create fresh */
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

  /**
   * Discard the room's outbound megolm session (key rotation). Called by
   * the client when membership changes in an encrypted room, so messages
   * sent afterwards use a fresh session that joining members can read
   * (and leaving members cannot). No-op when no session exists yet.
   */
  async discardOutboundSession(roomId: string): Promise<void> {
    if (!this._outbound.has(roomId)) {
      /* not loaded yet — tombstone the persisted record if any */
      const stored = await this._store.get(this._storeKeyOutbound(roomId));
      if (!stored) return;
    }
    this._outbound.delete(roomId);
    const tombstone: OutboundRoomRecord = {
      sessionPickle: "",
      shared: false,
      messageCount: 0,
      discarded: true,
    };
    await this._store.put(this._storeKeyOutbound(roomId), JSON.stringify(tombstone));
  }

  /** Share the megolm session key with every joined member's devices. */
  private async _shareRoomKey(roomId: string, ogs: OlmOutboundGroupSessionApi): Promise<void> {
    const room = this.host.getRoom(roomId);
    if (!room) return;

    /* session_key must be captured at the CURRENT ratchet index; receivers
       create inbound sessions at that index. */
    const sessionKey = ogs.session_key();

    const memberIds = new Set<string>();
    for (const member of room.members.values()) {
      const invitedDmPeer = room.isDirect && room.directUserId === member.userId && member.membership === "invite";
      if (member.membership === "join" || invitedDmPeer) memberIds.add(member.userId);
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
          /* the olm v1 PDU per the spec — rust (element's stack) requires
             sender/keys/recipient/recipient_keys in the decrypted payload;
             a bare {type, content} is rejected and the room key silently
             dropped, leaving every grungus message UTD on element. Each
             device gets its own payload: recipient fields are per-device. */
          const payload = JSON.stringify({
            type: "m.room_key",
            content: {
              algorithm: ALGORITHM_MEGOLM,
              room_id: roomId,
              session_id: ogs.session_id(),
              session_key: sessionKey,
            },
            sender: this.host.userId,
            sender_device: this.deviceId,
            keys: { ed25519: this._ed25519 },
            recipient: userId,
            recipient_keys: { ed25519: device.ed25519 },
          });
          const encrypted = session.encrypt(payload);
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
      await this._persistSessions();
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
      if (event.type === "m.room.encrypted" && event.content) {
        this._handleOlmEvent(event);
      } else if (event.type === "m.room_key_request" && event.content) {
        this._handleKeyRequest(event);
      }
    }
  }

  /** A backup created on this device (private key in memory). */
  /** Test/debug: list inbound sessions without exposing internals. */
  debugInboundSessions(): Array<{ senderKey: string; sessionId: string; roomId: string }> {
    const out: Array<{ senderKey: string; sessionId: string; roomId: string }> = [];
    for (const [key, entry] of this._inbound) {
      const [senderKey, sessionId] = key.split("|");
      out.push({ senderKey: senderKey ?? "", sessionId: sessionId ?? "", roomId: entry.roomId });
    }
    return out;
  }

  /** Test/debug: export an inbound session at its earliest index. */
  debugExportSession(senderKey: string, sessionId: string): string | null {
    const entry = this._inbound.get(`${senderKey}|${sessionId}`);
    if (!entry) return null;
    return entry.session.export_session(entry.session.first_known_index());
  }

  get hasActiveBackup(): boolean {
    return this._backup !== null;
  }

  /* --------------------------- key forwarding ----------------------------- */

  /**
   * Ask devices that may hold a megolm session for its key (m.room_key_request,
   * plaintext to-device — the request itself carries nothing secret). Targets:
   * the original sender's devices and our other own devices. Deduped per
   * (senderKey, sessionId).
   */
  async requestRoomKey(
    roomId: string,
    senderUserId: string | null,
    senderKey: string | null,
    sessionId: string
  ): Promise<void> {
    const dedupeKey = `${senderKey}|${sessionId}`;
    if (this._requestedKeys.has(dedupeKey)) return;
    this._requestedKeys.add(dedupeKey);

    const requestId = `req-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const content = {
      action: "request",
      request_id: requestId,
      requesting_device_id: this._deviceId,
      body: {
        algorithm: ALGORITHM_MEGOLM,
        room_id: roomId,
        ...(senderKey ? { sender_key: senderKey } : {}),
        session_id: sessionId,
      },
    };

    const messages: Record<string, Record<string, unknown>> = {};
    const addTarget = async (userId: string): Promise<void> => {
      const devices = await this.getUserDevices(userId);
      for (const device of devices) {
        if (userId === this.host.userId && device.deviceId === this._deviceId) continue;
        messages[userId] = messages[userId] ?? {};
        messages[userId]![device.deviceId] = content;
      }
    };
    if (senderUserId) await addTarget(senderUserId);
    if (this.host.userId) await addTarget(this.host.userId);

    if (Object.keys(messages).length === 0) return;
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    await this.host.api(
      "PUT",
      `/_matrix/client/v3/sendToDevice/m.room_key_request/${encodeURIComponent(txnId)}`,
      { body: { messages } }
    );
  }

  /**
   * We hold a session another device asks for. Policy (Element-like):
   * forward to our own user's devices, and to devices whose Ed25519 key
   * we have verified via SAS. Never forward to strangers.
   */
  private _handleKeyRequest(event: MatrixWireEvent): void {
    const content = event.content as {
      action?: string;
      requesting_device_id?: string;
      body?: {
        algorithm?: string;
        room_id?: string;
        sender_key?: string;
        session_id?: string;
      };
    };
    if (content.action !== "request" || !content.requesting_device_id) return;
    const body = content.body ?? {};
    if (body.algorithm !== ALGORITHM_MEGOLM || !body.room_id || !body.session_id) return;

    const requester = event.sender;
    const requestDevice = content.requesting_device_id;

    void (async () => {
      try {
        const ownUser = requester === this.host.userId;
        if (!ownUser) {
          const [verified, published] = await Promise.all([
            this.getVerifiedKey(requester, requestDevice),
            this.getDeviceEd25519(requester, requestDevice),
          ]);
          if (!verified || !published || verified !== published) {
            console.warn(
              `[e2ee] declining room-key request from unverified device ${requester}/${requestDevice}`
            );
            return;
          }
        }

        const matches = [...this._inbound.entries()].filter(([key, entry]) =>
          key.endsWith(`|${body.session_id}`) && entry.roomId === body.room_id && (!body.sender_key || key === `${body.sender_key}|${body.session_id}`));
        if (matches.length !== 1) return;
        const [storedKey, entry] = matches[0]!;
        const senderKey = storedKey.split("|")[0]!;

        /* export at the earliest index we can provide — the requester
           gets as much history as this device has */
        const exported = entry.session.export_session(
          entry.session.first_known_index()
        );
        await this.sendToDeviceEncrypted(requester, requestDevice, "m.forwarded_room_key", {
          algorithm: ALGORITHM_MEGOLM,
          room_id: entry.roomId,
          sender_key: senderKey,
          session_id: body.session_id,
          session_key: exported,
        });
      } catch (err) {
        console.error("[e2ee] failed to forward room key:", err);
      }
    })();
  }

  /** Ingest a forwarded megolm session (m.forwarded_room_key via olm). */
  private _ingestForwardedRoomKey(content: Record<string, unknown>): void {
    const roomId = typeof content.room_id === "string" ? content.room_id : null;
    const senderKey = typeof content.sender_key === "string" ? content.sender_key : null;
    const sessionId = typeof content.session_id === "string" ? content.session_id : null;
    const sessionKey = typeof content.session_key === "string" ? content.session_key : null;
    if (!roomId || !senderKey || !sessionId || !sessionKey) return;

    const key = `${senderKey}|${sessionId}`;

    const olm = this._olm!;
    const igs = new olm.InboundGroupSession();
    try {
      igs.import_session(sessionKey);
    } catch (err) {
      console.error("[e2ee] bad forwarded room key:", err);
      return;
    }
    if (igs.session_id() !== sessionId) {
      console.error("[e2ee] forwarded session id mismatch — discarding");
      return;
    }
    if (!this._acceptInbound(key, igs, roomId)) return;
    void this._backupInboundSession(senderKey, sessionId, roomId);
    this.onInboundSessionAdded?.(roomId);
  }

  /* --------------------------- key backup (MSC) --------------------------- */

  /** The server's current backup version, or null when none exists. */
  async getKeyBackupVersion(): Promise<KeyBackupVersion | null> {
    try {
      const res = await this.host.api<KeyBackupVersion>(
        "GET",
        "/_matrix/client/v3/room_keys/version"
      );
      return res && res.version ? res : null;
    } catch {
      return null;
    }
  }

  /** Explicit reset only: fail closed on lookup errors and clear obsolete backup material. */
  async deleteCurrentKeyBackup(): Promise<void> {
    let version: KeyBackupVersion | null;
    try {
      version = await this.host.api<KeyBackupVersion>("GET", "/_matrix/client/v3/room_keys/version");
    } catch (error) {
      if ((error as { errcode?: string }).errcode !== "M_NOT_FOUND") throw error;
      version = null;
    }
    if (version && !version.version) throw new Error("Homeserver returned an invalid backup version");
    if (version?.version) {
      await this.host.api("DELETE", `/_matrix/client/v3/room_keys/version/${encodeURIComponent(version.version)}`);
    }
    this._backup?.pk.free();
    this._backup?.privateKey.fill(0);
    this._backup = null;
    this._backedUpSessions.clear();
    await this.host.api("PUT", `/_matrix/client/v3/user/${encodeURIComponent(this.host.userId!)}/account_data/m.megolm_backup.v1`, { body: {} });
  }

  /**
   * Create a server-side key backup secured by a passphrase. The private
   * key never leaves this device: the passphrase derives a curve25519 key
   * (PBKDF2-HMAC-SHA-512), the server only ever sees the public key.
   */
  async createKeyBackup(passphrase: string): Promise<string> {
    if (passphrase.length < 8) {
      throw new Error("Passphrase must be at least 8 characters");
    }
    const salt = randomSalt();
    const iterations = BACKUP_DEFAULT_ITERATIONS;
    const privateKey = await deriveBackupKey(passphrase, salt, iterations);
    const olm = this._olm!;
    const pk = new olm.PkDecryption();
    const publicKey = pk.init_with_private_key(privateKey);

    /* write both KDF shapes (js-sdk legacy + spec passphrase object) so
       Element can restore a Grungus backup and vice versa */
    const authData = {
      public_key: publicKey,
      private_key_salt: salt,
      private_key_iterations: iterations,
      private_key_bits: 256,
      passphrase: { algorithm: "m.pbkdf2", iterations, salt, bits: 256 },
    };
    const res = await this.host.api<{ version?: string }>(
      "POST",
      "/_matrix/client/v3/room_keys/version",
      { body: { algorithm: BACKUP_ALGORITHM, auth_data: authData, count: 0 } }
    );
    if (!res.version) throw new Error("Homeserver returned no backup version");
    this._backup = { version: res.version, publicKey, privateKey, pk };
    /* back up everything we already hold */
    for (const [key, entry] of [...this._inbound.entries()]) {
      const [senderKey, sessionId] = key.split("|");
      void this._backupInboundSession(
        senderKey ?? "",
        sessionId ?? "",
        entry.roomId
      );
    }
    return res.version;
  }

  /** SSSS secret holding the backup's private key (element-call-era). */
  private static readonly MEGOLM_BACKUP_SECRET = "m.megolm_backup.v1";

  /**
   * Restore with a recovery passphrase OR recovery key (base58 security
   * key) — the unified entry the restore UI uses. Modern Element clients
   * keep the backup's private key in secret storage: the passphrase (or
   * security key) unlocks SSSS, the m.megolm_backup.v1 secret holds the
   * backup key. Older backups (and Grungus's own) derive the backup key
   * straight from the passphrase — tried as a fallback.
   */
  async restoreWithRecovery(input: string): Promise<number> {
    /* 1. the SSSS route (element-call-era): passphrase or recovery key
          → secret-storage key → decrypt the m.megolm_backup.v1 secret */
    /* SecretStorage wants a MatrixClient; the host carries exactly the
       account-data surface it uses (getAccountData/setAccountData) */
    const storage = new SecretStorage(
      this.host as unknown as import("./matrix-client.ts").MatrixClient
    );
    let unlocked = false;
    const asRecoveryKey = tryDecodeRecoveryKey(input);
    if (asRecoveryKey) {
      unlocked = (await storage.deriveFromRecoveryKey(input)) !== null;
    }
    if (!unlocked && !asRecoveryKey) {
      unlocked = (await storage.deriveFromPassphrase(input)) !== null;
    }
    if (unlocked) {
      const secretB64 = await storage.getSecret(E2eeCrypto.MEGOLM_BACKUP_SECRET);
      if (secretB64) {
        const privateKey = b64ToBytes(secretB64);
        let info: KeyBackupVersion | null = null;
        try {
          info = await this.getKeyBackupVersion();
        } catch {
          info = null;
        }
        if (info && info.algorithm === BACKUP_ALGORITHM && info.auth_data?.public_key) {
          return await this._restoreBackup(info, privateKey);
        }
      }
      /* unlocked SSSS but no backup secret / no backup: fall through to
         the direct route — Grungus's own backups may coexist with SSSS */
    }
    /* 2. the direct route: the passphrase IS the backup-key KDF input */
    return this.restoreKeyBackup(input);
  }

  /**
   * Restore the server-side backup with a passphrase. Every stored megolm
   * session is decrypted, imported at its chain index, and reported through
   * onInboundSessionAdded so the client can retry undecrypted events.
   * An explicit `version` overrides "latest" (some servers keep a stale
   * latest after creating additional versions).
   */
  async restoreKeyBackup(passphrase: string, version?: string): Promise<number> {
    let info: KeyBackupVersion | null;
    if (version) {
      info = await this.host.api<KeyBackupVersion>(
        "GET",
        `/_matrix/client/v3/room_keys/version/${encodeURIComponent(version)}`
      );
      if (!info || !info.version) info = null;
    } else {
      info = await this.getKeyBackupVersion();
    }
    if (!info || info.algorithm !== BACKUP_ALGORITHM) {
      throw new Error("No compatible key backup on the server");
    }
    const auth = info.auth_data ?? {};
    const kdf = auth.passphrase;
    const salt = kdf?.salt ?? auth.private_key_salt;
    const iterations =
      kdf?.iterations ?? auth.private_key_iterations ?? BACKUP_DEFAULT_ITERATIONS;
    const bits = kdf?.bits ?? auth.private_key_bits ?? 256;
    if (!salt || !auth.public_key) {
      throw new Error("This backup was not created with a passphrase");
    }
    const privateKey = await deriveBackupKey(passphrase, salt, iterations, bits);
    return await this._restoreBackup(info, privateKey);
  }

  /**
   * Restore a backup whose private key we already hold (passphrase-
   * derived, or unlocked from secret storage). Validates the public key
   * against the backup's auth_data, then imports every session.
   */
  private async _restoreBackup(
    info: KeyBackupVersion,
    privateKey: Uint8Array
  ): Promise<number> {
    const olm = this._olm!;
    const pk = new olm.PkDecryption();
    const publicKey = pk.init_with_private_key(privateKey);
    const auth = info.auth_data ?? {};
    if (publicKey !== auth.public_key) {
      pk.free();
      throw new Error("Wrong recovery key or passphrase — it does not match this backup");
    }

    const roomsResponse = await this.host.api<{
      rooms?: Record<
        string,
        {
          sessions?: Record<
            string,
            {
              first_message_index?: number;
              forwarded_count?: number;
              session_data?: { ciphertext?: string; mac?: string; ephemeral?: string };
            }
          >;
        }
      >;
    }>("GET", "/_matrix/client/v3/room_keys/keys", {
      query: { version: info.version },
    });

    let imported = 0;
    const touchedRooms = new Set<string>();
    for (const [roomId, roomEntry] of Object.entries(roomsResponse.rooms ?? {})) {
      for (const [sessionId, session] of Object.entries(roomEntry.sessions ?? {})) {
        const envelope = session.session_data;
        if (!envelope?.ciphertext || !envelope.mac || !envelope.ephemeral) continue;
        let plaintext: string;
        try {
          plaintext = pk.decrypt(envelope.ephemeral, envelope.mac, envelope.ciphertext);
        } catch {
          continue; /* corrupt entry — skip */
        }
        const data = JSON.parse(plaintext) as {
          room_id?: string;
          session_id?: string;
          session_key?: string;
          sender_key?: string;
        };
        /*
         * rust/Element backups do NOT repeat room_id/session_id inside
         * the encrypted payload — the backup path (rooms/{roomId}/
         * sessions/{sessionId}) is the source of truth (js-sdk's rust
         * restore does the same). Grungus's OWN backups embed the ids as
         * well; when present they must agree with the path.
         */
        if (data.room_id !== undefined && data.room_id !== roomId) continue;
        if (data.session_id !== undefined && data.session_id !== sessionId) continue;
        if (!data.session_key || !data.sender_key) continue;
        const key = `${data.sender_key}|${sessionId}`;
        const igs = new olm.InboundGroupSession();
        try {
          igs.import_session(data.session_key);
        } catch {
          continue;
        }
        if (igs.session_id() !== sessionId) continue;
        if (!this._acceptInbound(key, igs, roomId, false)) continue;
        imported += 1;
        touchedRooms.add(roomId);
      }
    }
    for (const roomId of touchedRooms) {
      this.onInboundSessionAdded?.(roomId);
    }
    await this._persistSessions();
    return imported;
  }

  /** Backup state once created (private key held in memory only). */
  private _backup: {
    version: string;
    publicKey: string;
    privateKey: Uint8Array;
    pk: OlmPkDecryptionApi;
  } | null = null;
  /** session keys already backed up (dedup) */
  private readonly _backedUpSessions = new Set<string>();

  /** Encrypt one inbound session and PUT it into the server backup. */
  private async _backupInboundSession(
    senderKey: string,
    sessionId: string,
    roomId: string
  ): Promise<void> {
    if (!this._backup) return;
    const key = `${senderKey}|${sessionId}`;
    if (this._backedUpSessions.has(key)) return;
    const entry = this._inbound.get(key);
    if (!entry) return;

    try {
      const olm = this._olm!;
      const exported = entry.session.export_session(entry.session.first_known_index());
      const payload = JSON.stringify({
        algorithm: ALGORITHM_MEGOLM,
        room_id: roomId,
        session_id: sessionId,
        session_key: exported,
        sender_key: senderKey,
        forwarding_curve25519_key_chain: [],
      });
      const enc = new olm.PkEncryption();
      enc.set_recipient_key(this._backup.publicKey);
      const envelope = enc.encrypt(payload);
      await this.host.api(
        "PUT",
        `/_matrix/client/v3/room_keys/keys/${encodeURIComponent(roomId)}/${encodeURIComponent(sessionId)}`,
        {
          query: { version: this._backup.version },
          body: {
            first_message_index: entry.session.first_known_index(),
            forwarded_count: 0,
            is_verified: false,
            session_data: envelope,
          },
        }
      );
      this._backedUpSessions.add(key);
    } catch (err) {
      console.error("[e2ee] key backup PUT failed:", err);
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
    } else if (payload.type === "m.forwarded_room_key") {
      this._ingestForwardedRoomKey(payload.content);
    } else {
      /* other olm-protected payloads (call signaling, SAS verification) */
      for (const listener of [...this._payloadListeners]) {
        try {
          listener(event.sender, payload.type, payload.content, senderKey);
        } catch (err) {
          console.error("[e2ee] payload listener failed:", err);
        }
      }
    }
  }

  private _acceptInbound(key: string, session: OlmInboundGroupSessionApi, roomId: string, persist = true): boolean {
    const existing = this._inbound.get(key);
    if (existing && (existing.roomId !== roomId || existing.session.first_known_index() <= session.first_known_index())) {
      session.free();
      return false;
    }
    existing?.session.free();
    this._inbound.set(key, { session, roomId });
    this._backedUpSessions.delete(key);
    if (persist) void this._persistSessions();
    return true;
  }

  /** A verified/recovered session can retry requests previously declined before trust was established. */
  retryRoomKeyRequests(): void { this._requestedKeys.clear(); }

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
    if (igs.session_id() !== sessionId) { igs.free(); return; }
    /* indexed by the sender's curve25519 key — that is what m.room.encrypted
       events carry in content.sender_key, and what decryptRoomEvent uses */
    if (!this._acceptInbound(`${senderCurve25519}|${sessionId}`, igs, roomId)) return;
    void this._backupInboundSession(senderCurve25519, sessionId, roomId);
    this.onInboundSessionAdded?.(roomId);
  }

  private _decryptWithOlm(senderKey: string, type: number, body: string): string | null {
    const olm = this._olm!;
    /* existing sessions first */
    const sessions = this._olmSessions.get(senderKey) ?? [];
    for (const session of sessions) {
      try {
        if (type === 0 && !session.matches_inbound(body)) continue;
        const plaintext = session.decrypt(type, body);
        void this._persistSessions();
        return plaintext;
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
  decryptRoomEvent(event: MatrixWireEvent, roomId?: string): { type: string; content: Record<string, unknown> } | null {
    const content = event.content as {
      algorithm?: string;
      sender_key?: string;
      session_id?: string;
      ciphertext?: string;
    };
    if (
      content.algorithm !== ALGORITHM_MEGOLM ||
      !content.session_id ||
      !content.ciphertext
    ) {
      return null;
    }
    const matches = [...this._inbound.entries()].filter(([key, entry]) =>
      key.endsWith(`|${content.session_id}`) && (!content.sender_key || key === `${content.sender_key}|${content.session_id}`) && (!roomId || entry.roomId === roomId));
    const entry = matches.length === 1 ? matches[0]![1] : null;
    if (!entry) return null; /* room key not shared with this device */
    try {
      const result = entry.session.decrypt(content.ciphertext);
      const payload = JSON.parse(result.plaintext) as {
        type?: string;
        room_id?: string;
        content?: Record<string, unknown>;
      };
      if (payload.room_id !== entry.roomId) return null;
      if (!payload.type || !payload.content) return null;
      return { type: payload.type, content: payload.content };
    } catch {
      return null; /* ratcheted past, wrong session, or corrupted */
    }
  }

  private _storeKeyOutbound(roomId: string): string {
    return `og:${this.host.userId}:${this._deviceId}:${roomId}`;
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
