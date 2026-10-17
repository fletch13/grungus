/*
 * Grungus — QR code device verification (MSC3906 binary format).
 *
 * One device SHOWS a QR code, the other SCANS it. The QR carries the
 * shower's Ed25519 + Curve25519 device keys and an 11-byte random
 * shared secret; the scanner echoes the secret via m.reciprocate.v1
 * over the olm-encrypted to-device channel — proving it physically
 * saw this exact code. Both sides then mark each other's devices
 * trusted (the same trust store SAS verification uses).
 *
 * QR payload — MSC3906 v2 binary layout:
 *   "MATRIX"  6 ASCII bytes (no length prefix)
 *   0x02      code version
 *   0x03      mode — Grungus device-key verification (see note)
 *   u16 BE len + utf-8 transactionId
 *   32 bytes  shower's Ed25519 device key (raw)
 *   32 bytes  shower's Curve25519 device key (raw)
 *   11 bytes  shared secret (raw)
 *
 * Mode note: Element's modes 0x00-0x02 carry CROSS-SIGNING master
 * keys, which Grungus does not implement yet; 0x03 is a Grungus
 * extension carrying both device keys directly. Element will reject
 * mode 0x03 as unknown — QR interop with Element waits for
 * cross-signing support.
 *
 * Threat model (documented honestly):
 * - The secret echo proves physical presence (a non-server attacker
 *   cannot forge a scan of a code they never saw).
 * - The scanner requires the shower's m.key.verification.done to
 *   arrive over the olm channel authenticated by the SAME curve25519
 *   key the QR carried — defeating QR substitution by anyone who is
 *   not the shower device.
 * - The reciprocate start carries a MAC (Grungus extension) of the
 *   scanner's Ed25519 key keyed by the shared secret, so the shower
 *   verifies the scanner's device key against the server-published
 *   one without an emoji comparison.
 * - A fully malicious homeserver swapping device keys is only
 *   defeated by cross-signing (not yet implemented) — the same
 *   residual risk SAS has without out-of-band emoji comparison.
 */

import type { E2eeCrypto } from "./e2ee.ts";
import type { CrossSigning } from "./cross-signing.ts";

export const QR_PREFIX = "MATRIX";
export const QR_VERSION = 0x02;
/** Element mode: verifying ANOTHER user (firstKey = my MSK, secondKey = their MSK). */
export const QR_MODE_VERIFY_OTHER_USER = 0x00;
/** Element mode: self-verification, WE TRUST our master key (firstKey = my MSK, secondKey = peer device key). */
export const QR_MODE_VERIFY_SELF_TRUSTED = 0x01;
/** Element mode: self-verification, we do NOT trust our master key (firstKey = my device key, secondKey = my MSK). */
export const QR_MODE_VERIFY_SELF_UNTRUSTED = 0x02;
/** Grungus legacy mode: device-key verification without cross-signing. */
export const QR_MODE_DEVICE = 0x03;
/** Shared secret length in bytes (as in matrix-js-sdk: 11 bytes). */
export const QR_SECRET_BYTES = 11;

export interface QrPayload {
  version: number;
  mode: number;
  transactionId: string;
  /** first key per mode (unpadded base64): MSK (0x00/0x01) or device ed25519 (0x02/0x03) */
  firstKeyB64: string;
  /** second key per mode: their MSK (0x00), peer device key (0x01), my MSK (0x02), my curve25519 (0x03) */
  secondKeyB64: string;
  /** shared secret, unpadded base64 */
  secretB64: string;
}

/* --------------------------- base64 helpers ---------------------------- */

function b64ToBytes(b64: string): Uint8Array {
  const normalized = b64.replace(/=+$/, "");
  const bin = atob(normalized.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToUnpaddedB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "");
}

/* ------------------------- payload build / parse ----------------------- */

/**
 * Build the binary QR payload. Keys are given as unpadded base64
 * strings and embedded as RAW decoded bytes, mirroring
 * matrix-js-sdk's QRCodeData.generateBuffer. The mode selects the
 * key semantics (Element modes 0x00-0x02 or the Grungus 0x03 fallback).
 */
export function buildQrPayload(options: {
  transactionId: string;
  mode: number;
  firstKeyB64: string;
  secondKeyB64: string;
  secretBytes: Uint8Array;
}): Uint8Array {
  const txnBytes = new TextEncoder().encode(options.transactionId);
  const first = b64ToBytes(options.firstKeyB64);
  const second = b64ToBytes(options.secondKeyB64);
  const parts: number[] = [];
  const pushByte = (b: number): void => {
    parts.push(b & 0xff);
  };
  const pushU16 = (n: number): void => {
    pushByte((n >> 8) & 0xff);
    pushByte(n & 0xff);
  };
  for (const ch of QR_PREFIX) pushByte(ch.charCodeAt(0));
  pushByte(QR_VERSION);
  pushByte(options.mode);
  pushU16(txnBytes.length);
  for (const b of txnBytes) pushByte(b);
  for (const b of first) pushByte(b);
  for (const b of second) pushByte(b);
  if (options.secretBytes.length !== QR_SECRET_BYTES) {
    throw new Error(`secret must be ${QR_SECRET_BYTES} bytes`);
  }
  for (const b of options.secretBytes) pushByte(b);
  return new Uint8Array(parts);
}

/** Parse and strictly validate a scanned QR payload. */
export function parseQrPayload(bytes: Uint8Array): QrPayload | null {
  let i = 0;
  const readByte = (): number => {
    if (i >= bytes.length) throw new RangeError("truncated payload");
    return bytes[i++]!;
  };
  try {
    let prefix = "";
    for (let p = 0; p < QR_PREFIX.length; p++) {
      prefix += String.fromCharCode(readByte());
    }
    if (prefix !== QR_PREFIX) return null;
    const version = readByte();
    if (version !== QR_VERSION) return null;
    const mode = readByte();
    if (
      mode !== QR_MODE_VERIFY_OTHER_USER &&
      mode !== QR_MODE_VERIFY_SELF_TRUSTED &&
      mode !== QR_MODE_VERIFY_SELF_UNTRUSTED &&
      mode !== QR_MODE_DEVICE
    ) {
      return null;
    }
    const len = (readByte() << 8) | readByte();
    const txnBytes = bytes.slice(i, i + len);
    if (txnBytes.length !== len) return null;
    i += len;
    const transactionId = new TextDecoder().decode(txnBytes);
    const first = bytes.slice(i, i + 32);
    if (first.length !== 32) return null;
    i += 32;
    const second = bytes.slice(i, i + 32);
    if (second.length !== 32) return null;
    i += 32;
    const secret = bytes.slice(i, i + QR_SECRET_BYTES);
    if (secret.length !== QR_SECRET_BYTES) return null;
    i += QR_SECRET_BYTES;
    if (i !== bytes.length) return null; /* trailing junk */
    return {
      version,
      mode,
      transactionId,
      firstKeyB64: bytesToUnpaddedB64(first),
      secondKeyB64: bytesToUnpaddedB64(second),
      secretB64: bytesToUnpaddedB64(secret),
    };
  } catch {
    return null;
  }
}

/* ------------------------------ transaction ---------------------------- */

export type QrPhase =
  | "requested" /* request sent/received, user has not chosen yet */
  | "show-qr" /* we render the QR, waiting for the scan */
  | "scan-qr" /* we are scanning (camera / file input) */
  | "confirm-scan" /* shower: scanned! user confirms both show green */
  | "wait-confirm" /* scanner: reciprocate sent, waiting for the done */
  | "verified"
  | "failed"
  | "cancelled";

export interface QrUiState {
  transactionId: string;
  initiatedByMe: boolean;
  peerUserId: string;
  peerDeviceId: string;
  phase: QrPhase;
  /** payload bytes to render as a QR code (phase show-qr) */
  qrBytes: Uint8Array | null;
  error: string | null;
}

/**
 * One QR verification between this device and one peer device. The
 * same class runs on both sides; who shows and who scans is a UX
 * choice made independently on each side.
 */
export class QrTransaction {
  readonly transactionId: string;
  readonly initiatedByMe: boolean;
  readonly myUserId: string;
  readonly myDeviceId: string;
  readonly peerUserId: string;
  readonly peerDeviceId: string;
  private readonly crypto: E2eeCrypto;

  phase: QrPhase = "requested";
  error: string | null = null;
  private _qrBytes: Uint8Array | null = null;
  private _secretBytes: Uint8Array | null = null;
  /** the scanner's done arrived while we were still waiting for the
   *  user's confirmation — complete as soon as they confirm */
  private _theirDone = false;
  /** the shower's done arrived — the scanner can finish */
  private _showerDoneKey: string | null = null;

  onUi: ((state: QrUiState) => void) | null = null;
  onVerified:
    | ((peerUserId: string, peerDeviceId: string, peerEd25519: string) => void)
    | null = null;

  constructor(options: {
    transactionId: string;
    initiatedByMe: boolean;
    myUserId: string;
    myDeviceId: string;
    peerUserId: string;
    peerDeviceId: string;
    crypto: E2eeCrypto;
    /** optional — enables the Element cross-signing QR modes */
    crossSigning?: CrossSigning | null;
  }) {
    this.transactionId = options.transactionId;
    this.initiatedByMe = options.initiatedByMe;
    this.myUserId = options.myUserId;
    this.myDeviceId = options.myDeviceId;
    this.peerUserId = options.peerUserId;
    this.peerDeviceId = options.peerDeviceId;
    this.crypto = options.crypto;
    this._crossSigning = options.crossSigning ?? null;
  }

  private readonly _crossSigning: CrossSigning | null = null;
  /** the mode this transaction showed/scanned (payload bookkeeping) */
  private _mode: number = QR_MODE_DEVICE;

  uiState(): QrUiState {
    return {
      transactionId: this.transactionId,
      initiatedByMe: this.initiatedByMe,
      peerUserId: this.peerUserId,
      peerDeviceId: this.peerDeviceId,
      phase: this.phase,
      qrBytes: this._qrBytes,
      error: this.error,
    };
  }

  private _emit(): void {
    this.onUi?.(this.uiState());
  }

  private async send(type: string, content: Record<string, unknown>): Promise<void> {
    await this.crypto.sendToDeviceEncrypted(this.peerUserId, this.peerDeviceId, type, {
      transaction_id: this.transactionId,
      from_device: this.myDeviceId,
      ...content,
    });
  }

  /** The verification request (shared with the SAS flow). */
  async sendRequest(): Promise<void> {
    await this.send("m.key.verification.request", {
      from_device: this.myDeviceId,
      methods: ["m.sas.v1", "m.qr_code.show.v1", "m.qr_code.scan.v1", "m.reciprocate.v1"],
      timestamp: Date.now(),
      to: this.peerUserId,
    });
  }

  async decline(): Promise<void> {
    if (this.phase === "verified" || this.phase === "cancelled") return;
    await this.send("m.key.verification.cancel", { code: "m.user", reason: "declined" });
    this.phase = "cancelled";
    this._emit();
  }

  /* ------------------------------- shower ------------------------------ */

  /**
   * Generate the QR this device should display. Returns the payload
   * bytes; the UI renders them with the qrcode library. With
   * cross-signing bootstrapped the Element modes are used (0x01/0x02
   * for self-verification, 0x00 cross-user); without it the Grungus
   * device-key mode 0x03 (back-compat).
   */
  async showQrCode(): Promise<Uint8Array> {
    const secret = new Uint8Array(QR_SECRET_BYTES);
    crypto.getRandomValues(secret);
    this._secretBytes = secret;

    let mode = QR_MODE_DEVICE;
    let firstKey = this.crypto.ed25519Key;
    let secondKey = this.crypto.curve25519Key;
    const cs = this._crossSigning;
    if (cs) {
      const msk = await cs.masterPub();
      const selfVerify = this.peerUserId === this.myUserId;
      if (msk) {
        if (selfVerify) {
          const canSign = await cs.canSign();
          if (canSign) {
            /* we trust our master key (we hold it): mode 0x01 —
               my MSK + the peer device's key */
            mode = QR_MODE_VERIFY_SELF_TRUSTED;
            firstKey = msk;
            secondKey =
              (await this.crypto.getDeviceEd25519(this.peerUserId, this.peerDeviceId)) ?? "";
          } else {
            /* we do not trust our master key yet: mode 0x02 —
               our device key + our MSK claim */
            mode = QR_MODE_VERIFY_SELF_UNTRUSTED;
            firstKey = this.crypto.ed25519Key;
            secondKey = msk;
          }
        } else {
          /* cross-user: mode 0x00 — my MSK + their MSK (their MSK is
             not always fetchable — servers distribute it via
             /keys/query; fall back to 0x03 when unknown) */
          const theirMsk = await cs.getRemoteMasterPub(this.peerUserId);
          if (theirMsk) {
            mode = QR_MODE_VERIFY_OTHER_USER;
            firstKey = msk;
            secondKey = theirMsk;
          }
        }
      }
    }
    if (!firstKey || !secondKey) {
      throw new Error("cannot build QR payload: missing keys");
    }
    this._mode = mode;
    this._qrBytes = buildQrPayload({
      transactionId: this.transactionId,
      mode,
      firstKeyB64: firstKey,
      secondKeyB64: secondKey,
      secretBytes: secret,
    });
    this.phase = "show-qr";
    this._emit();
    return this._qrBytes;
  }

  /**
   * Shower: the scanner's m.reciprocate.v1 start arrived. Validate the
   * secret echo and the scanner's MAC, then prompt the user.
   */
  async handleReciprocateStart(
    content: Record<string, unknown>
  ): Promise<void> {
    if (this.phase !== "show-qr" || !this._secretBytes) {
      this._fail("unexpected reciprocate (no QR shown)");
      return;
    }
    const secret = typeof content.secret === "string" ? content.secret : null;
    if (!secret || secret !== bytesToUnpaddedB64(this._secretBytes)) {
      this._fail("scanned secret does not match — wrong or tampered QR");
      return;
    }
    /* Grungus MAC extension: the scanner MACs its Ed25519 device key
       with the shared secret; verify against the server-published key. */
    const mac = typeof content.mac === "string" ? content.mac : null;
    const theirEd25519 = await this.crypto.getDeviceEd25519(
      this.peerUserId,
      this.peerDeviceId
    );
    if (!theirEd25519) {
      this._fail("scanner device key not published on the server");
      return;
    }
    if (!mac || !(await this._verifyScannerMac(mac, theirEd25519))) {
      this._fail("scanner MAC mismatch — device key not verified");
      return;
    }
    this._theirEd25519 = theirEd25519;
    this.phase = "confirm-scan";
    this._emit();
  }

  private _theirEd25519 = "";

  private async _verifyScannerMac(
    mac: string,
    scannerEd25519: string
  ): Promise<boolean> {
    const expected = await this._macWithRole(scannerEd25519, true);
    return expected === mac;
  }

  /**
   * HMAC-SHA256(secret, info + key) as unpadded base64. The info string
   * is ordered shower-first so BOTH sides derive the same value (the
   * scanner computes its MAC, the shower recomputes it to verify).
   * iAmShower selects which endpoint's identity comes first.
   */
  private async _macWithRole(key: string, iAmShower: boolean): Promise<string> {
    if (!this._secretBytes) throw new Error("no secret");
    const showerPart = iAmShower
      ? this.myUserId + this.myDeviceId
      : this.peerUserId + this.peerDeviceId;
    const scannerPart = iAmShower
      ? this.peerUserId + this.peerDeviceId
      : this.myUserId + this.myDeviceId;
    const info =
      "GRUNGUS_QR_VERIFICATION_MAC" + showerPart + scannerPart + this.transactionId;
    const enc = new TextEncoder();
    const macKey = await crypto.subtle.importKey(
      "raw",
      this._secretBytes as BufferSource,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      macKey,
      enc.encode(info + key) as BufferSource
    );
    return bytesToUnpaddedB64(new Uint8Array(sig));
  }

  /**
   * Shower: the user confirmed both devices show the verification
   * result. Mark the scanner trusted and send our done.
   */
  async confirmScanned(): Promise<void> {
    if (this.phase !== "confirm-scan" && this.phase !== "requested") return;
    if (!this._theirEd25519) return;
    await this.crypto.markDeviceVerified(
      this.peerUserId,
      this.peerDeviceId,
      this._theirEd25519
    );
    this._confirmedSent = true;
    await this.send("m.key.verification.done", {});
    if (this._theirDone) {
      this._complete();
    } else {
      this._emit();
    }
  }

  /* ------------------------------ scanner ------------------------------ */

  /**
   * Scanner: switch this transaction into scan mode (the UI shows the
   * camera / upload). The actual scan arrives via scanQrCode().
   */
  startScanning(): void {
    if (this.phase !== "requested") return;
    this.phase = "scan-qr";
    this._emit();
  }

  /**
   * Scanner: a QR was decoded (camera frame or uploaded image).
   * Validates the payload against the pending transaction and the
   * server-published keys — per MODE:
   *   0x03 (device):      both keys are the shower's device keys
   *   0x01 (self,        firstKey = shower's MSK (checked against our
   *      trusted):        own account data), secondKey = shower's device key
   *   0x02 (self,        firstKey = shower's device key, secondKey = the
   *      untrusted):     shower's MSK claim (must match OUR own MSK)
   *   0x00 (other user): firstKey = their MSK, secondKey = OUR MSK
   * then sends the reciprocate start.
   */
  async scanQrCode(payloadBytes: Uint8Array): Promise<void> {
    const payload = parseQrPayload(payloadBytes);
    if (!payload) {
      this._fail("not a Grungus verification QR code");
      return;
    }
    if (payload.transactionId !== this.transactionId) {
      this._fail("QR belongs to a different verification");
      return;
    }
    this._mode = payload.mode;
    const myMsk = this._crossSigning ? await this._crossSigning.masterPub() : null;

    let showerDeviceEd: string | null = null;
    let showerCurve: string | null = null;
    let showerMskClaim: string | null = null;

    if (payload.mode === QR_MODE_DEVICE) {
      showerDeviceEd =
        (await this.crypto.getDeviceEd25519(this.peerUserId, this.peerDeviceId)) ?? null;
      if (!showerDeviceEd || showerDeviceEd !== payload.firstKeyB64) {
        this._fail("QR device key does not match the server");
        return;
      }
      showerCurve =
        (await this.crypto.getDeviceCurve25519(this.peerUserId, this.peerDeviceId)) ?? null;
      if (!showerCurve || showerCurve !== payload.secondKeyB64) {
        this._fail("QR identity key does not match the server");
        return;
      }
    } else if (payload.mode === QR_MODE_VERIFY_SELF_TRUSTED) {
      /* shower = the OLD trusted device; we are the new device */
      const ownMsk = myMsk;
      if (!ownMsk || ownMsk !== payload.firstKeyB64) {
        this._fail("QR master key does not match this account's");
        return;
      }
      showerDeviceEd =
        (await this.crypto.getDeviceEd25519(this.peerUserId, this.peerDeviceId)) ?? null;
      if (!showerDeviceEd || showerDeviceEd !== payload.secondKeyB64) {
        this._fail("QR device key does not match the server");
        return;
      }
      showerCurve =
        (await this.crypto.getDeviceCurve25519(this.peerUserId, this.peerDeviceId)) ?? null;
      showerMskClaim = payload.firstKeyB64;
    } else if (payload.mode === QR_MODE_VERIFY_SELF_UNTRUSTED) {
      /* shower = the NEW device; we are the old trusted one */
      showerDeviceEd =
        (await this.crypto.getDeviceEd25519(this.peerUserId, this.peerDeviceId)) ?? null;
      if (!showerDeviceEd || showerDeviceEd !== payload.firstKeyB64) {
        this._fail("QR device key does not match the server");
        return;
      }
      showerCurve =
        (await this.crypto.getDeviceCurve25519(this.peerUserId, this.peerDeviceId)) ?? null;
      /* the new device claims OUR master key — it must match exactly */
      if (!myMsk || myMsk !== payload.secondKeyB64) {
        this._fail("QR claims a different master key for this account");
        return;
      }
      showerMskClaim = payload.secondKeyB64;
    } else if (payload.mode === QR_MODE_VERIFY_OTHER_USER) {
      /* cross-user: firstKey = their MSK, secondKey = OUR MSK */
      if (!myMsk || myMsk !== payload.secondKeyB64) {
        this._fail("QR master key does not match this account's");
        return;
      }
      showerMskClaim = payload.firstKeyB64;
      /* their device key is not in the QR — device trust goes through
         the MSK/SSK chain (server-dependent) */
      showerDeviceEd =
        (await this.crypto.getDeviceEd25519(this.peerUserId, this.peerDeviceId)) ?? null;
      showerCurve =
        (await this.crypto.getDeviceCurve25519(this.peerUserId, this.peerDeviceId)) ?? null;
    } else {
      this._fail("unsupported QR mode");
      return;
    }

    this._theirEd25519 = showerDeviceEd ?? "";
    this._showerKeysFromQr = { curve25519: showerCurve ?? "" };
    this._showerMskFromQr = showerMskClaim;
    /* the scanner adopts the secret from the QR — both sides MAC with it */
    this._secretBytes = b64ToBytes(payload.secretB64);

    /* reciprocate: echo the secret + MAC our OWN device key (the shower
       verifies this against our server-published key) */
    const mac = await this._macWithRole(this.crypto.ed25519Key, false);
    await this.send("m.key.verification.start", {
      method: "m.reciprocate.v1",
      secret: payload.secretB64,
      mac,
    });
    this.phase = "wait-confirm";
    this._emit();
  }

  private _showerKeysFromQr: { curve25519: string } | null = null;
  /** the MSK the QR carried (cross-signing modes) */
  private _showerMskFromQr: string | null = null;

  /* ------------------------------- done -------------------------------- */

  /**
   * m.key.verification.done arrived over the olm channel. senderKey is
   * the olm-authenticated curve25519 identity of the sending device.
   */
  async handleDone(senderKey: string | null): Promise<void> {
    if (this.phase === "verified" || this.phase === "cancelled") return;

    if (this.phase === "wait-confirm") {
      /* scanner: the shower confirmed the secret echo. The done must
         arrive over the olm channel authenticated by the SAME
         curve25519 the QR carried. */
      if (
        senderKey &&
        this._showerKeysFromQr &&
        this._showerKeysFromQr.curve25519 &&
        senderKey !== this._showerKeysFromQr.curve25519
      ) {
        this._fail("confirmation came from a different device than the QR");
        return;
      }
      await this.crypto.markDeviceVerified(
        this.peerUserId,
        this.peerDeviceId,
        this._theirEd25519
      );
      /* cross-signing propagation per mode:
         - 0x02 (we are the OLD trusted device scanning the new one):
           sign the new device's key with our SSK — every device that
           trusts our MSK now trusts it (the Element flow)
         - 0x00 (cross-user): sign their MSK with our USK
         - 0x01 (we are the new device): our SSK signing is not ours to
           do — the SHOWER (old device) signs us via its onVerified
           hook; here we just recorded its device + MSK trust above */
      if (this._crossSigning && this._mode === QR_MODE_VERIFY_SELF_UNTRUSTED) {
        await this._crossSigning.signDevice(this.peerDeviceId).catch(() => {});
      } else if (this._crossSigning && this._mode === QR_MODE_VERIFY_OTHER_USER && this._showerMskFromQr) {
        await this._crossSigning
          .signUserMasterKeyPub(this.peerUserId, this._showerMskFromQr)
          .catch(() => {});
      }
      await this.send("m.key.verification.done", {});
      this._complete();
      return;
    }

    if (this.phase === "confirm-scan" || this.phase === "show-qr") {
      /* shower: the scanner's done arrived. If our user has already
         confirmed, the transaction is complete; otherwise remember it
         so confirmScanned() finishes immediately. */
      this._theirDone = true;
      if (this.phase === "confirm-scan" && this._theirEd25519 && this._confirmedSent) {
        this._complete();
      } else {
        this._emit();
      }
    }
  }

  private _confirmedSent = false;

  private _complete(): void {
    if (this.phase === "verified") return;
    this.phase = "verified";
    this._emit();
    this.onVerified?.(this.peerUserId, this.peerDeviceId, this._theirEd25519);
  }

  private _fail(message: string): void {
    this.phase = "failed";
    this.error = message;
    this._emit();
  }
}
