/*
 * Grungus — server-side secret storage (SSSS, spec "Secret storage").
 *
 * Secrets (cross-signing private seeds, etc.) are encrypted with a
 * secret-storage key and parked in account data; a new device can
 * recover them with the recovery passphrase — or receive them live
 * from a verified own device via m.secret.request/m.secret.send
 * (the secret-sharing side lives in cross-signing.ts).
 *
 * Formats follow matrix-js-sdk v33 exactly:
 *   - key description: account data m.secret_storage.key.{keyId}
 *     { name, algorithm: "m.secret_storage.v1.aes-hmac-sha2",
 *       passphrase: { algorithm: "m.pbkdf2", iterations, salt, bits },
 *       iv, mac } — iv/mac are the "key check": encryptAES(32 zero
 *       bytes, key, name="")
 *   - default key pointer: m.secret_storage.default_key { key }
 *   - a stored secret: account data { name } =
 *     { encrypted: { [keyId]: { iv, ciphertext, mac } } }
 *   - encryption: AES-CTR (counter = 16-byte iv, 64-bit length) with
 *     keys split by HKDF-SHA256(zeroSalt(8), info = the secret's name,
 *     512 bits): first 32 bytes = AES key, last 32 = HMAC-SHA256 key;
 *     mac = HMAC(hmacKey, ciphertext)
 *   - passphrase derivation: PBKDF2-HMAC-SHA-512, 256 bits (the same
 *     js-sdk deriveKey used for room key backups)
 */

import type { MatrixClient } from "./matrix-client.ts";

export const SSSS_ALGORITHM = "m.secret_storage.v1.aes-hmac-sha2";
export const SSSS_KEY_PREFIX = "m.secret_storage.key.";
export const SSSS_DEFAULT_KEY = "m.secret_storage.default_key";
export const SSSS_DEFAULT_ITERATIONS = 500_000;

/** 32 zero bytes — the key-check plaintext (js-sdk ZERO_STR). */
const ZERO_STR = "\0".repeat(32);
/** 8 zero bytes — the HKDF salt (js-sdk zeroSalt). */
const ZERO_SALT = new Uint8Array(8);

export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
  mac: string;
}

export interface PassphraseInfo {
  algorithm: "m.pbkdf2";
  iterations: number;
  salt: string;
  bits?: number;
}

export interface SecretStorageKeyDescription {
  name?: string;
  algorithm: string;
  passphrase?: PassphraseInfo;
  iv: string;
  mac: string;
  [extra: string]: unknown;
}

/* --------------------------- base64 helpers ---------------------------- */

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(normalized);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function trimTrailingEquals(input: string): string {
  let i = input.length;
  while (i >= 1 && input.charCodeAt(i - 1) === 0x3d) i--;
  return i < input.length ? input.substring(0, i) : input;
}

/* ------------------------------ crypto core ---------------------------- */

/** PBKDF2-HMAC-SHA-512 → bits (js-sdk deriveKey — same as key backup). */
export async function deriveSecretKey(
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
    { name: "PBKDF2", salt: enc.encode(salt), iterations, hash: "SHA-512" },
    key,
    bits
  );
  return new Uint8Array(derived);
}

/** HKDF-SHA256 split into [aesKey, hmacKey] (js-sdk deriveKeys). */
async function deriveAesHmacKeys(
  key: Uint8Array,
  name: string
): Promise<[CryptoKey, CryptoKey]> {
  const subtle = globalThis.crypto.subtle;
  const enc = new TextEncoder();
  const hkdfKey = await subtle.importKey("raw", key as BufferSource, { name: "HKDF" }, false, [
    "deriveBits",
  ]);
  const keyBits = await subtle.deriveBits(
    {
      name: "HKDF",
      salt: ZERO_SALT as BufferSource,
      info: enc.encode(name) as BufferSource,
      hash: "SHA-256",
    },
    hkdfKey,
    512
  );
  const bits = new Uint8Array(keyBits);
  const aesKey = await subtle.importKey(
    "raw",
    bits.slice(0, 32) as BufferSource,
    { name: "AES-CTR" },
    false,
    ["encrypt", "decrypt"]
  );
  const hmacKey = await subtle.importKey(
    "raw",
    bits.slice(32) as BufferSource,
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign", "verify"]
  );
  return [aesKey, hmacKey];
}

/** AES-CTR + HMAC-SHA256 envelope (js-sdk encryptAES). */
export async function encryptSecret(
  plaintext: string,
  key: Uint8Array,
  name: string,
  ivStr?: string
): Promise<EncryptedPayload> {
  let iv: Uint8Array;
  if (ivStr) {
    iv = b64ToBytes(ivStr);
  } else {
    const rand = new Uint8Array(16);
    crypto.getRandomValues(rand);
    rand[8] = (rand[8] ?? 0) & 0x7f; /* stay under the 64-bit counter boundary */
    iv = rand;
  }
  const [aesKey, hmacKey] = await deriveAesHmacKeys(key, name);
  const encoded = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: iv as BufferSource, length: 64 },
    aesKey,
    encoded as BufferSource
  );
  const mac = await crypto.subtle.sign({ name: "HMAC" }, hmacKey, ciphertext);
  return {
    iv: bytesToB64(iv),
    ciphertext: bytesToB64(new Uint8Array(ciphertext)),
    mac: bytesToB64(new Uint8Array(mac)),
  };
}

/** Verify MAC then AES-CTR decrypt (js-sdk decryptAES). */
export async function decryptSecret(
  data: EncryptedPayload,
  key: Uint8Array,
  name: string
): Promise<string> {
  const [aesKey, hmacKey] = await deriveAesHmacKeys(key, name);
  const ciphertext = b64ToBytes(data.ciphertext);
  const ok = await crypto.subtle.verify(
    { name: "HMAC" },
    hmacKey,
    b64ToBytes(data.mac) as BufferSource,
    ciphertext as BufferSource
  );
  if (!ok) throw new Error(`Error decrypting secret ${name}: bad MAC`);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-CTR", counter: b64ToBytes(data.iv) as BufferSource, length: 64 },
    aesKey,
    ciphertext as BufferSource
  );
  return new TextDecoder().decode(new Uint8Array(plaintext));
}

/** The key check: encrypt 32 zero bytes with an empty name (js-sdk). */
export async function calculateKeyCheck(key: Uint8Array, iv?: string): Promise<EncryptedPayload> {
  return encryptSecret(ZERO_STR, key, "", iv);
}

/* ------------------------------ storage ------------------------------- */

export class SecretStorage {
  private readonly client: MatrixClient;
  /** the private key, present after createKey or deriveFromPassphrase */
  private _key: Uint8Array | null = null;
  private _keyId: string | null = null;

  constructor(client: MatrixClient) {
    this.client = client;
  }

  get keyId(): string | null {
    return this._keyId;
  }

  /** The default storage key id from account data (or null). */
  async defaultKeyId(): Promise<string | null> {
    const acct = this.client.getAccountData(SSSS_DEFAULT_KEY) as { key?: string } | null;
    return acct?.key ?? null;
  }

  /**
   * Create a new secret-storage key from a recovery passphrase and
   * publish its description + set it as the default. This device then
   * holds the private key for storing secrets.
   */
  async createKey(passphrase: string, name = "Grungus recovery key"): Promise<string> {
    const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
    const key = await deriveSecretKey(passphrase, salt, SSSS_DEFAULT_ITERATIONS);
    const check = await calculateKeyCheck(key);
    let keyId = "";
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    do {
      keyId = "";
      const rand = crypto.getRandomValues(new Uint32Array(32));
      for (let i = 0; i < 32; i++) keyId += chars[rand[i]! % chars.length];
    } while (this.client.getAccountData(SSSS_KEY_PREFIX + keyId) !== null);
    const description: SecretStorageKeyDescription = {
      name,
      algorithm: SSSS_ALGORITHM,
      passphrase: {
        algorithm: "m.pbkdf2",
        iterations: SSSS_DEFAULT_ITERATIONS,
        salt,
        bits: 256,
      },
      iv: check.iv,
      mac: check.mac,
    };
    await this.client.setAccountData(SSSS_KEY_PREFIX + keyId, description);
    await this.client.setAccountData(SSSS_DEFAULT_KEY, { key: keyId });
    this._key = key;
    this._keyId = keyId;
    return keyId;
  }

  /**
   * Derive the key from the recovery passphrase and check it against
   * the published key check. Returns the key id on success, null when
   * the passphrase is wrong.
   */
  async deriveFromPassphrase(passphrase: string): Promise<string | null> {
    const keyId = await this.defaultKeyId();
    if (!keyId) return null;
    const desc = this.client.getAccountData(SSSS_KEY_PREFIX + keyId) as
      | SecretStorageKeyDescription
      | null;
    if (!desc?.passphrase) return null;
    const key = await deriveSecretKey(
      passphrase,
      desc.passphrase.salt,
      desc.passphrase.iterations,
      desc.passphrase.bits ?? 256
    );
    const check = await calculateKeyCheck(key, desc.iv);
    if (trimTrailingEquals(desc.mac) !== trimTrailingEquals(check.mac)) return null;
    this._key = key;
    this._keyId = keyId;
    return keyId;
  }

  /** True when this device holds the private storage key. */
  get hasKey(): boolean {
    return this._key !== null;
  }

  /** Encrypt and store a secret under the given account data name. */
  async storeSecret(name: string, secret: string): Promise<void> {
    if (!this._key || !this._keyId) throw new Error("no secret storage key");
    const payload = await encryptSecret(secret, this._key, name);
    await this.client.setAccountData(name, { encrypted: { [this._keyId]: payload } });
  }

  /** Fetch and decrypt a stored secret (null when absent). */
  async getSecret(name: string): Promise<string | null> {
    if (!this._key || !this._keyId) throw new Error("no secret storage key");
    const info = this.client.getAccountData(name) as
      | { encrypted?: Record<string, EncryptedPayload> }
      | null;
    const payload = info?.encrypted?.[this._keyId];
    if (!payload) return null;
    return decryptSecret(payload, this._key, name);
  }

  /** Whether a secret is stored (regardless of having the key). */
  isStored(name: string): boolean {
    const info = this.client.getAccountData(name) as
      | { encrypted?: Record<string, unknown> }
      | null;
    return (info?.encrypted && Object.keys(info.encrypted).length > 0) ?? false;
  }
}
