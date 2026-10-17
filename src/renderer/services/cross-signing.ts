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
 * Private key distribution to other own devices (SSSS secret storage
 * / key requests) is NOT implemented yet — the bootstrapping device
 * keeps the private seeds in its crypto store; other own devices can
 * verify trust chains but cannot sign until SSSS ships.
 *
 * Element interop: the key objects and signatures use the spec's
 * canonical JSON + Ed25519 (verified accepted by conduwuit's server-
 * side checks); Element on Synapse would see our published keys via
 * /keys/query on servers that distribute them.
 */

import type { E2eeCrypto } from "./e2ee.ts";
import type { MatrixClient } from "./matrix-client.ts";

export const CS_MASTER = "m.cross_signing.master";
export const CS_SELF_SIGNING = "m.cross_signing.self_signing";
export const CS_USER_SIGNING = "m.cross_signing.user_signing";

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
   * the SSK. authPassword satisfies the homeserver's UIA (m.login
   * password) when required — used once, never stored.
   */
  async bootstrap(authPassword?: string): Promise<{
    masterPub: string;
    uiaRequired: boolean;
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
      { master: keys.master, self_signing: keys.self_signing, user_signing: keys.user_signing },
      authPassword
    );

    /* account data copies (own-device distribution on servers that do
       not serve cross-signing keys via /keys/query) */
    await this.client.setAccountData(CS_MASTER, keys.master!);
    await this.client.setAccountData(CS_SELF_SIGNING, keys.self_signing!);
    await this.client.setAccountData(CS_USER_SIGNING, keys.user_signing!);

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
    return { masterPub, uiaRequired: false };
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

  /** Load own cross-signing key objects from account data (sync). */
  async loadKeys(): Promise<void> {
    if (this._loaded) return;
    const master = this.client.getAccountData(CS_MASTER) as CrossSigningKey | null;
    const ssk = this.client.getAccountData(CS_SELF_SIGNING) as CrossSigningKey | null;
    const usk = this.client.getAccountData(CS_USER_SIGNING) as CrossSigningKey | null;
    if (master && ssk && usk) {
      this._keyInfo = { master, self_signing: ssk, user_signing: usk };
      this._loaded = true;
    }
  }

  /** Public master key of this account (null when not bootstrapped). */
  async masterPub(): Promise<string | null> {
    await this.loadKeys();
    return this._keyInfo.master ? pubFromKeyInfo(this._keyInfo.master) : null;
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
      pk.init_with_seed(seed);
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
