/*
 * Grungus — cross-signing (m.cross_signing.*).
 *
 * The Matrix trust hierarchy: a master key (MSK) signs a
 * self-signing key (SSK) and a user-signing key (USK); the SSK signs
 * the user's own device keys; the USK signs OTHER users' master keys.
 * Verify one new device and every device that trusts your MSK trusts
 * it too — no pairwise ceremony per device.
 *
 * Key objects (canonical form, per spec / matrix-js-sdk):
 *   { user_id, usage: ["master"], keys: { "ed25519:<pub>": "<pub>" },
 *     signatures: { <userId>: { "ed25519:<signerPub>": <sig> } } }
 *
 * Publication on the homeserver:
 *   - POST /keys/device_signing/upload { master, self_signing,
 *     user_signing } (UIA-protected on Synapse/conduwuit — the account
 *     password is prompted once)
 *   - the master key is signed by the BOOTSTRAP DEVICE's Ed25519 key
 *     (so devices that trust the bootstrapping device chain-trust the
 *     MSK) — uploaded together with the keys
 *   - device signatures (SSK over device) go via
 *     POST /keys/signatures/upload and appear on the device entries
 *     in /keys/query
 *   - the three key objects are ALSO published as account data
 *     (m.cross_signing.master/self_signing/user_signing) — on servers
 *     that do not distribute cross-signing keys via /keys/query
 *     (conduwuit), own devices fetch them from sync account data
 *
 * Private signing seeds can be recovered from SSSS using a recovery key
 * or passphrase, or requested from an already verified own device.
 *
 * Element interop: the key objects and signatures use the spec's
 * canonical JSON + Ed25519 (verified accepted by conduwuit's server-
 * side checks); Element on Synapse would see our published keys via
 * /keys/query on servers that distribute them.
 */

import type { E2eeCrypto } from "./e2ee.ts";
import type { MatrixClient } from "./matrix-client.ts";
import { SecretStorage, tryDecodeRecoveryKey } from "./ssss.ts";

export const CS_MASTER = "m.cross_signing.master";
export const CS_SELF_SIGNING = "m.cross_signing.self_signing";
export const CS_USER_SIGNING = "m.cross_signing.user_signing";

/**
 * Public key objects under these namespaced account data types (NOT the
 * spec's m.cross_signing.* names — those hold the ENCRYPTED PRIVATE
 * seeds in SSSS, per the spec and Element; the public keys are normally
 * distributed via /keys/query, which this conduwuit build does not
 * serve, so Grungus parks public copies here for own devices).
 */
export const CS_PUBLIC_MASTER = "com.grungus.cross_signing.master";
export const CS_PUBLIC_SELF_SIGNING = "com.grungus.cross_signing.self_signing";
export const CS_PUBLIC_USER_SIGNING = "com.grungus.cross_signing.user_signing";

export interface CrossSigningKey {
  user_id: string;
  usage: string[];
  keys: Record<string, string>;
  signatures?: Record<string, Record<string, string>>;
  [extra: string]: unknown;
}

/** A signed device-key object (what the SSK signs). */
export interface DeviceKeyObject {
  user_id: string;
  device_id: string;
  algorithms: string[];
  keys: Record<string, string>;
  signatures?: Record<string, Record<string, string>>;
}

/** Canonical JSON for signatures (Matrix appendix: sorted keys, no
 *  insignificant whitespace — the same form anotherjson produces and
 *  homeserver signature checks accept). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const obj = value as Record<string, unknown>;
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") +
      "}"
    );
  }
  return "null";
}

export function pubFromKeyInfo(key: CrossSigningKey): string {
  return Object.values(key.keys)[0] ?? "";
}

interface PkSigningApi {
  generate_seed(): Uint8Array;
  init_with_seed(seed: Uint8Array): string;
  sign(message: string): string;
  free(): void;
}

interface UtilityApi {
  ed25519_verify(key: string, message: string, signature: string): void;
  free(): void;
}

export class CrossSigning {
  private readonly crypto: E2eeCrypto;
  private readonly client: MatrixClient;
  /** public key objects by type, once fetched/created */
  private _keyInfo: Record<string, CrossSigningKey> = {};
  private _loaded = false;

  constructor(crypto: E2eeCrypto, client: MatrixClient) {
    this.crypto = crypto;
    this.client = client;
  }

  /* ------------------------------ creation ------------------------------ */

  /**
   * Bootstrap cross-signing for this account: generate the three
   * Ed25519 keypairs, sign SSK + USK with the MSK, sign the MSK with
   * the device key, publish everything, and sign our own device with
   * the SSK. authPassword satisfies the homeserver's UIA; when a
   * recoveryPassphrase is given, the private seeds are ALSO stored as
   * SSSS secrets (spec m.cross_signing.* account data, encrypted with a
   * new m.secret_storage.v1.aes-hmac-sha2 key) so any device can
   * recover them with the recovery passphrase.
   */
  async bootstrap(
    authPassword?: string,
    recoveryPassphrase?: string
  ): Promise<{
    masterPub: string;
    uiaRequired: boolean;
    ssssKeyId: string | null;
  }> {
    const olm = this.crypto.olmModule;
    if (!olm) throw new Error("crypto not initialised");
    const userId = this.client.userId ?? "";

    const privates: Record<string, Uint8Array> = {};
    const keys: Record<string, CrossSigningKey> = {};
    const signings: Record<string, PkSigningApi> = {};
    for (const type of ["master", "self_signing", "user_signing"]) {
      const pk: PkSigningApi = new olm.PkSigning();
      privates[type] = pk.generate_seed();
      const pub = pk.init_with_seed(privates[type]);
      keys[type] = {
        user_id: userId,
        usage: [type],
        keys: { ["ed25519:" + pub]: pub },
      };
      signings[type] = pk;
    }
    const masterPub = pubFromKeyInfo(keys.master!);

    const signObject = (obj: CrossSigningKey, pk: PkSigningApi, pub: string): void => {
      const sig = pk.sign(canonicalJson(obj));
      obj.signatures = obj.signatures ?? {};
      obj.signatures[userId] = obj.signatures[userId] ?? {};
      obj.signatures[userId]!["ed25519:" + pub] = sig;
    };

    /* MSK signs the SSK and USK */
    signObject(keys.self_signing!, signings.master!, masterPub);
    signObject(keys.user_signing!, signings.master!, masterPub);
    /* the bootstrapping DEVICE signs the MSK (chain: trust the device,
       trust the MSK it published) */
    this._signWithDevice(keys.master!);

    /* publish the keys (UIA-aware) */
    await this.client.uploadDeviceSigningKeys(
      { master_key: keys.master, self_signing_key: keys.self_signing, user_signing_key: keys.user_signing },
      authPassword
    );

    /* account data copies of the PUBLIC key objects (namespaced — the
       spec's m.cross_signing.* names hold the encrypted private seeds;
       own devices fetch public copies from here since this homeserver
       does not serve cross-signing keys via /keys/query) */
    await this.client.setAccountData(CS_PUBLIC_MASTER, keys.master!);
    await this.client.setAccountData(CS_PUBLIC_SELF_SIGNING, keys.self_signing!);
    await this.client.setAccountData(CS_PUBLIC_USER_SIGNING, keys.user_signing!);

    /* SSSS: store the private seeds encrypted with a new storage key
       derived from the recovery passphrase (Element-compatible
       account data at the spec's m.cross_signing.* names) */
    let ssssKeyId: string | null = null;
    if (recoveryPassphrase) {
      const ssss = new SecretStorage(this.client);
      ssssKeyId = await ssss.createKey(recoveryPassphrase);
      const b64 = (bytes: Uint8Array): string => {
        let bin = "";
        for (const b of bytes) bin += String.fromCharCode(b);
        return btoa(bin);
      };
      await ssss.storeSecret(CS_MASTER, b64(privates.master!));
      await ssss.storeSecret(CS_SELF_SIGNING, b64(privates.self_signing!));
      await ssss.storeSecret(CS_USER_SIGNING, b64(privates.user_signing!));
    }

    /* store the private seeds (this device can sign) */
    const b64 = (bytes: Uint8Array): string => {
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    };
    await this.crypto.store.put("cs:master", b64(privates.master!));
    await this.crypto.store.put("cs:self_signing", b64(privates.self_signing!));
    await this.crypto.store.put("cs:user_signing", b64(privates.user_signing!));

    /* sign our own device with the SSK */
    await this.signDevice(this.crypto.deviceId);

    this._keyInfo = keys;
    this._loaded = true;

    for (const pk of Object.values(signings)) pk.free();
    return { masterPub, uiaRequired: false, ssssKeyId };
  }

  /** Sign a message with this device's Ed25519 key (olm account). */
  private _signWithDevice(obj: CrossSigningKey): void {
    const sig = this.crypto.signWithDevice(canonicalJson(obj));
    const deviceEd = this.crypto.ed25519Key;
    const userId = this.client.userId ?? "";
    obj.signatures = obj.signatures ?? {};
    obj.signatures[userId] = obj.signatures[userId] ?? {};
    obj.signatures[userId]!["ed25519:" + this.crypto.deviceId] = sig;
    void deviceEd;
  }

  /* ------------------------------- access ------------------------------- */

  /** True once this account has cross-signing keys (fetched or made). */
  async isBootstrapped(): Promise<boolean> {
    await this.loadKeys();
    return this._keyInfo.master !== undefined;
  }

  /** Load standard server cross-signing keys, with legacy Grungus account-data fallback. */
  async loadKeys(): Promise<void> {
    if (this._loaded) return;
    const userId = this.client.userId;
    if (!userId) return;
    const response = await this.client.api<{
      master_keys?: Record<string, CrossSigningKey>;
      self_signing_keys?: Record<string, CrossSigningKey>;
      user_signing_keys?: Record<string, CrossSigningKey>;
    }>("POST", "/_matrix/client/v3/keys/query", { body: { device_keys: { [userId]: [] } } });
    const master = response.master_keys?.[userId] ?? this.client.getAccountData(CS_PUBLIC_MASTER) as CrossSigningKey | null;
    const ssk = response.self_signing_keys?.[userId] ?? this.client.getAccountData(CS_PUBLIC_SELF_SIGNING) as CrossSigningKey | null;
    const usk = response.user_signing_keys?.[userId] ?? this.client.getAccountData(CS_PUBLIC_USER_SIGNING) as CrossSigningKey | null;
    if (master && ssk && usk) {
      this._keyInfo = { master, self_signing: ssk, user_signing: usk };
      this._loaded = true;
    }
  }

  /**
   * Recover the private seeds from SSSS with the recovery passphrase
   * (the spec's m.cross_signing.* encrypted secrets). After this, THIS
   * device can sign — no other device needed.
   */
  async recoverWithPassphrase(passphrase: string): Promise<boolean> {
    return this.recoverWithRecovery(passphrase);
  }

  /** Unlock SSSS, validate the private seeds against server keys, and self-sign this device. */
  async recoverWithRecovery(input: string): Promise<boolean> {
    const ssss = new SecretStorage(this.client);
    const keyId = tryDecodeRecoveryKey(input)
      ? await ssss.deriveFromRecoveryKey(input)
      : await ssss.deriveFromPassphrase(input);
    if (!keyId) return false;
    const secrets = await Promise.all([CS_MASTER, CS_SELF_SIGNING, CS_USER_SIGNING].map(name => ssss.getSecret(name)));
    if (secrets.some(secret => !secret)) return false;
    this._loaded = false;
    await this.loadKeys();
    const olm = this.crypto.olmModule;
    if (!olm) throw new Error("Crypto is not initialized");
    const types = ["master", "self_signing", "user_signing"];
    for (const [index, type] of types.entries()) {
      const info = this._keyInfo[type];
      const seed = Uint8Array.from(atob(secrets[index]!), char => char.charCodeAt(0));
      const pk: PkSigningApi = new olm.PkSigning();
      try {
        if (!info || info.user_id !== this.client.userId || !info.usage.includes(type) || pk.init_with_seed(seed) !== pubFromKeyInfo(info)) {
          throw new Error("Recovered cross-signing keys do not match this account's current identity");
        }
      } finally { pk.free(); seed.fill(0); }
    }
    for (const [index, type] of types.entries()) await this.crypto.store.put(`cs:${type}`, secrets[index]!);
    if (!(await this.signDevice(this.crypto.deviceId))) throw new Error("Could not cross-sign this device");
    return true;
  }

  /* --------------------------- secret sharing -------------------------- */

  /**
   * NEW device: ask a verified own device for the cross-signing
   * private seeds (m.secret.request, olm-encrypted). The seeds arrive
   * via m.secret.send and land in our store — this device can sign.
   */
  async requestCrossSigningKeys(
    peerUserId: string,
    peerDeviceId: string
  ): Promise<void> {
    for (const type of [CS_MASTER, CS_SELF_SIGNING, CS_USER_SIGNING]) {
      const requestId = `sreq-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
      const keyType = type === CS_MASTER
        ? "master"
        : type === CS_SELF_SIGNING
          ? "self_signing"
          : "user_signing";
      this._pendingSecretRequests.set(requestId, keyType);
      await this.crypto.sendToDeviceEncrypted(
        peerUserId,
        peerDeviceId,
        "m.secret.request",
        {
          name: type,
          device_id: this.crypto.deviceId,
          request_id: requestId,
        }
      );
    }
  }

  /** request_id -> key type, for routing incoming m.secret.send. */
  private readonly _pendingSecretRequests = new Map<string, string>();

  /**
   * OLD device: an m.secret.request arrived from another device of
   * ours. Secrets go ONLY to devices we have verified (locally or via
   * the cross-signing chain) — never to strangers. Returns true when
   * the request was handled.
   */
  async handleSecretRequest(
    requesterUserId: string,
    requesterDeviceId: string,
    requestId: string,
    secretName: string
  ): Promise<boolean> {
    const ownUserId = this.client.userId ?? "";
    if (requesterUserId !== ownUserId) return false; /* own devices only */
    if (requesterDeviceId === this.crypto.deviceId) return false;
    if (![CS_MASTER, CS_SELF_SIGNING, CS_USER_SIGNING].includes(secretName)) return false;
    const type = secretName === CS_MASTER
      ? "master"
      : secretName === CS_SELF_SIGNING
        ? "self_signing"
        : "user_signing";
    const seed = await this._seed(type);
    if (!seed) return false; /* we do not hold the private keys */
    const verified = await this.isOwnDeviceTrusted(requesterDeviceId);
    if (!verified) {
      console.warn("[grungus] secret request from an unverified own device — refusing");
      return true;
    }
    let bin = "";
    for (const b of seed) bin += String.fromCharCode(b);
    await this.crypto.sendToDeviceEncrypted(
      requesterUserId,
      requesterDeviceId,
      "m.secret.send",
      {
        request_id: requestId,
        secret: btoa(bin),
      }
    );
    return true;
  }

  /**
   * NEW device: an m.secret.send arrived — store the seed. Returns the
   * key type when it was one of ours.
   */
  async handleSecretSend(requestId: string, secretB64: string): Promise<string | null> {
    const pending = this._pendingSecretRequests.get(requestId);
    if (!pending) return null;
    this._pendingSecretRequests.delete(requestId);
    await this.crypto.store.put(`cs:${pending}`, secretB64);
    return pending;
  }

  /** Public master key of this account (null when not bootstrapped). */
  async masterPub(): Promise<string | null> {
    await this.loadKeys();
    return this._keyInfo.master ? pubFromKeyInfo(this._keyInfo.master) : null;
  }

  /**
   * Another user's public master key — servers distribute these via
   * /keys/query (as ed25519-only pseudo-device entries). Returns null
   * when the server does not serve them (this conduwuit build) or the
   * user has no cross-signing.
   */
  async getRemoteMasterPub(userId: string): Promise<string | null> {
    if (userId === (this.client.userId ?? "")) return this.masterPub();
    const raw = await this.crypto.getRawDeviceKeys(userId);
    /* the MSK pseudo-entry has only an ed25519 key keyed by its own
       pub — getRawDeviceKeys filters those out, so query directly */
    const res = await this.client.api<{
      master_keys?: Record<string, CrossSigningKey>;
      device_keys?: Record<string, Record<string, { keys?: Record<string, string> } | undefined>>;
    }>("POST", "/_matrix/client/v3/keys/query", {
      body: { device_keys: { [userId]: [] } },
    });
    if (res.master_keys?.[userId]) return pubFromKeyInfo(res.master_keys[userId]);
    const entries = res.device_keys?.[userId] ?? {};
    for (const [id, entry] of Object.entries(entries)) {
      const keys = entry?.keys ?? {};
      const ed = keys[`ed25519:${id}`];
      /* ed25519-only entry whose key id equals the pub key itself */
      if (ed && ed === id && !keys[`curve25519:${id}`]) return ed;
    }
    void raw;
    return null;
  }

  /** Get the stored private seed for a key type (this device bootstrapped). */
  private async _seed(type: string): Promise<Uint8Array | null> {
    const b64 = await this.crypto.store.get(`cs:${type}`);
    if (typeof b64 !== "string") return null;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** True when THIS device holds the private signing keys. */
  async canSign(): Promise<boolean> {
    return (await this._seed("self_signing")) !== null;
  }

  /* ------------------------------ signing ------------------------------- */

  /**
   * Sign one of OUR OWN devices with the self-signing key and upload
   * the signature (POST /keys/signatures/upload). Every device that
   * trusts our master key will now trust the signed device.
   */
  async signDevice(deviceId: string): Promise<boolean> {
    const userId = this.client.userId ?? "";
    const seed = await this._seed("self_signing");
    await this.loadKeys();
    const sskInfo = this._keyInfo.self_signing;
    if (!seed || !sskInfo) return false;
    const sskPub = pubFromKeyInfo(sskInfo);

    /* fetch the device's published key object */
    const raw = await this.crypto.getRawDeviceKeys(userId);
    const entry = raw[deviceId];
    if (!entry) return false;
    const deviceObj: DeviceKeyObject = {
      user_id: userId,
      device_id: deviceId,
      algorithms: entry.algorithms,
      keys: entry.keys,
    };

    const olm = this.crypto.olmModule;
    if (!olm) return false;
    const pk: PkSigningApi = new olm.PkSigning();
    try {
      if (pk.init_with_seed(seed) !== sskPub) throw new Error("Stored signing key does not match the current account identity; recover this session again");
      const sig = pk.sign(canonicalJson(deviceObj));
      deviceObj.signatures = {
        [userId]: {
          ["ed25519:" + deviceId]:
            entry.signatures?.[userId]?.["ed25519:" + deviceId] ?? "",
          ["ed25519:" + sskPub]: sig,
        },
      };
      await this.client.uploadKeySignatures({ [userId]: { [deviceId]: deviceObj } });
      return true;
    } finally {
      pk.free();
    }
  }

  /**
   * Sign another user's master key (given as a pub key string) with our
   * user-signing key and upload — the cross-user verification step.
   */
  async signUserMasterKeyPub(otherUserId: string, otherMasterPub: string): Promise<boolean> {
    return this.signUserMasterKey(otherUserId, {
      user_id: otherUserId,
      usage: ["master"],
      keys: { ["ed25519:" + otherMasterPub]: otherMasterPub },
    });
  }

  /**
   * Sign another user's master key with our user-signing key (the
   * user-to-user verification step). Their devices become trusted for
   * us once the signature is published.
   */
  async signUserMasterKey(
    otherUserId: string,
    otherMaster: CrossSigningKey
  ): Promise<boolean> {
    const userId = this.client.userId ?? "";
    const seed = await this._seed("user_signing");
    await this.loadKeys();
    const uskInfo = this._keyInfo.user_signing;
    if (!seed || !uskInfo) return false;
    const uskPub = pubFromKeyInfo(uskInfo);

    const olm = this.crypto.olmModule;
    if (!olm) return false;
    const pk: PkSigningApi = new olm.PkSigning();
    try {
      pk.init_with_seed(seed);
      const obj: CrossSigningKey = {
        user_id: otherUserId,
        usage: otherMaster.usage,
        keys: otherMaster.keys,
      };
      const sig = pk.sign(canonicalJson(obj));
      obj.signatures = { [userId]: { ["ed25519:" + uskPub]: sig } };
      const keyId = pubFromKeyInfo(otherMaster);
      await this.client.uploadKeySignatures({
        [otherUserId]: { [keyId]: obj },
      });
      return true;
    } finally {
      pk.free();
    }
  }

  /* ------------------------------ trust --------------------------------- */

  /**
   * Full trust-chain check for one of OUR OWN devices:
   *   1. locally verified (SAS/QR) → trusted
   *   2. a locally-verified device signed the MSK, the MSK signed the
   *      SSK, and the SSK signed this device's key → trusted
   * Returns false when any link fails.
   */
  async isOwnDeviceTrusted(deviceId: string): Promise<boolean> {
    const userId = this.client.userId ?? "";
    if (deviceId === this.crypto.deviceId) return true; /* ourselves */
    const local = await this.crypto.getVerifiedKey(userId, deviceId);
    if (local) return true;

    await this.loadKeys();
    const master = this._keyInfo.master;
    const ssk = this._keyInfo.self_signing;
    if (!master || !ssk) return false;

    const olm = this.crypto.olmModule;
    if (!olm) return false;
    const util: UtilityApi = new olm.Utility();
    try {
      const masterPub = pubFromKeyInfo(master);

      /* link 1: the MSK is signed by a device we verified locally */
      let mskTrusted = false;
      const sigs = master.signatures?.[userId] ?? {};
      for (const [keyId, sig] of Object.entries(sigs)) {
        const signingDevice = keyId.startsWith("ed25519:")
          ? keyId.slice("ed25519:".length)
          : "";
        if (!signingDevice) continue;
        const verified = await this.crypto.getVerifiedKey(userId, signingDevice);
        if (!verified) continue;
        try {
          const mskNoSigs: CrossSigningKey = {
            user_id: master.user_id,
            usage: master.usage,
            keys: master.keys,
          };
          util.ed25519_verify(verified, canonicalJson(mskNoSigs), sig);
          mskTrusted = true;
          break;
        } catch {
          /* bad signature — try the next signer */
        }
      }
      if (!mskTrusted) return false;

      /* link 2: the SSK is signed by the MSK */
      try {
        const sskNoSigs: CrossSigningKey = {
          user_id: ssk.user_id,
          usage: ssk.usage,
          keys: ssk.keys,
        };
        const sskSig = ssk.signatures?.[userId]?.["ed25519:" + masterPub];
        if (!sskSig) return false;
        util.ed25519_verify(masterPub, canonicalJson(sskNoSigs), sskSig);
      } catch {
        return false;
      }

      /* link 3: the device's key is signed by the SSK */
      const sskPub = pubFromKeyInfo(ssk);
      const raw = await this.crypto.getRawDeviceKeys(userId);
      const entry = raw[deviceId];
      if (!entry) return false;
      const deviceSig = entry.signatures?.[userId]?.["ed25519:" + sskPub];
      if (!deviceSig) return false;
      const deviceNoSigs = {
        user_id: userId,
        device_id: deviceId,
        algorithms: entry.algorithms,
        keys: entry.keys,
      };
      try {
        util.ed25519_verify(sskPub, canonicalJson(deviceNoSigs), deviceSig);
        return true;
      } catch {
        return false;
      }
    } finally {
      util.free();
    }
  }

  /**
   * All of our own device ids that pass the trust chain (locally
   * verified or SSK-signed). Used by the room-key forwarding policy.
   */
  async trustedOwnDevices(): Promise<string[]> {
    const userId = this.client.userId ?? "";
    const raw = await this.crypto.getRawDeviceKeys(userId);
    const result: string[] = [];
    for (const deviceId of Object.keys(raw)) {
      if (await this.isOwnDeviceTrusted(deviceId)) result.push(deviceId);
    }
    return result;
  }
}
