/*
 * Grungus — SAS device verification (m.key.verification, libolm SAS).
 *
 * Implements the short-authentication-string verification flow over
 * olm-encrypted to-device messages, following the same wire formats and
 * crypto derivations as matrix-js-sdk / the Matrix spec (key agreement
 * "curve25519", MAC "hkdf-hmac-sha256", 7-emoji display). Two Grungus
 * devices verify each other's Ed25519 device keys; on success both mark
 * the other device trusted, replacing trust-on-first-use for verified
 * pairs.
 *
 * Element Call / matrix-js-sdk interoperability is not claimed (modeled
 * on the same spec; untested against other implementations).
 */

import type { E2eeCrypto } from "./e2ee.ts";
import { QrTransaction, type QrUiState } from "./qr-verify.ts";

/** The spec's 64 SAS emoji, in index order. */
export const SAS_EMOJI: readonly [string, string][] = [
  ["🐶", "dog"], ["🐱", "cat"], ["🦁", "lion"], ["🐎", "horse"],
  ["🦄", "unicorn"], ["🐷", "pig"], ["🐘", "elephant"], ["🐰", "rabbit"],
  ["🐼", "panda"], ["🐓", "rooster"], ["🐧", "penguin"], ["🐢", "turtle"],
  ["🐟", "fish"], ["🐙", "octopus"], ["🦋", "butterfly"], ["🌷", "flower"],
  ["🌳", "tree"], ["🌵", "cactus"], ["🍄", "mushroom"], ["🌏", "globe"],
  ["🌙", "moon"], ["☁️", "cloud"], ["🔥", "fire"], ["🍌", "banana"],
  ["🍎", "apple"], ["🍓", "strawberry"], ["🌽", "corn"], ["🍕", "pizza"],
  ["🎂", "cake"], ["❤️", "heart"], ["😀", "smiley"], ["🤖", "robot"],
  ["🎩", "hat"], ["👓", "glasses"], ["🔧", "spanner"], ["🎅", "santa"],
  ["👍", "thumbs up"], ["☂️", "umbrella"], ["⌛", "hourglass"], ["⏰", "clock"],
  ["🎁", "gift"], ["💡", "light bulb"], ["📕", "book"], ["✏️", "pencil"],
  ["📎", "paperclip"], ["✂️", "scissors"], ["🔒", "lock"], ["🔑", "key"],
  ["🔨", "hammer"], ["☎️", "telephone"], ["🏁", "flag"], ["🚂", "train"],
  ["🚲", "bicycle"], ["✈️", "aeroplane"], ["🚀", "rocket"], ["🏆", "trophy"],
  ["⚽", "ball"], ["🎸", "guitar"], ["🎺", "trumpet"], ["🔔", "bell"],
  ["⚓", "anchor"], ["🎧", "headphones"], ["📁", "folder"], ["📌", "pin"],
];

/** 6 SAS bytes -> 7 emoji (base64-style 6-bit packing, as in the spec). */
export function sasBytesToEmoji(bytes: Uint8Array): string[] {
  const b = bytes;
  const indices = [
    b[0]! >> 2,
    ((b[0]! & 0x3) << 4) | (b[1]! >> 4),
    ((b[1]! & 0xf) << 2) | (b[2]! >> 6),
    b[2]! & 0x3f,
    b[3]! >> 2,
    ((b[3]! & 0x3) << 4) | (b[4]! >> 4),
    ((b[4]! & 0xf) << 2) | (b[5]! >> 6),
  ];
  return indices.map((index) => SAS_EMOJI[index]![0]);
}

export type SasPhase =
  | "requested" /* request sent/received */
  | "started" /* start/accept exchanged */
  | "keys-exchanged" /* SAS pubkeys exchanged */
  | "show-emoji" /* emoji ready for the user */
  | "mac-sent"
  | "verified"
  | "failed"
  | "cancelled";

export interface SasUiState {
  transactionId: string;
  /** true when THIS device initiated the transaction. */
  initiatedByMe: boolean;
  peerUserId: string;
  peerDeviceId: string;
  phase: SasPhase;
  emoji: string[];
  error: string | null;
}

interface OlmSasApi {
  get_pubkey(): string;
  set_their_key(key: string): void;
  generate_bytes(info: string, length: number): Uint8Array;
  calculate_mac(input: string, info: string): string;
  free(): void;
}

const KEY_AGREEMENT = "curve25519";
const HASH = "sha256";
const MAC_METHOD = "hkdf-hmac-sha256";
const SAS_METHOD = "m.sas.v1";

/**
 * One SAS transaction between this device and one peer device.
 * The same instance runs on both sides (initiatedByMe distinguishes them).
 */
export class SasTransaction {
  readonly transactionId: string;
  readonly initiatedByMe: boolean;
  readonly myUserId: string;
  readonly myDeviceId: string;
  readonly myEd25519: string;
  readonly peerUserId: string;
  readonly peerDeviceId: string;
  readonly crypto: E2eeCrypto;

  phase: SasPhase = "requested";
  emoji: string[] = [];
  error: string | null = null;

  private _olmSas: OlmSasApi | null = null;
  private _gotTheirKey = false;
  private _macSent = false;
  /** their MAC arrived and verified — completes once ours is sent too */
  private _theirMacVerified = false;
  private _theirEd25519 = "";

  onUi: ((state: SasUiState) => void) | null = null;
  /** Called when this transaction verifies the peer device. */
  onVerified:
    | ((peerUserId: string, peerDeviceId: string, peerEd25519: string) => void)
    | null = null;

  constructor(options: {
    transactionId: string;
    initiatedByMe: boolean;
    myUserId: string;
    myDeviceId: string;
    myEd25519: string;
    peerUserId: string;
    peerDeviceId: string;
    crypto: E2eeCrypto;
  }) {
    this.transactionId = options.transactionId;
    this.initiatedByMe = options.initiatedByMe;
    this.myUserId = options.myUserId;
    this.myDeviceId = options.myDeviceId;
    this.myEd25519 = options.myEd25519;
    this.peerUserId = options.peerUserId;
    this.peerDeviceId = options.peerDeviceId;
    this.crypto = options.crypto;
  }

  private get olmSas(): OlmSasApi {
    if (!this._olmSas) this._olmSas = this.crypto.createSas();
    return this._olmSas;
  }

  private async send(type: string, content: Record<string, unknown>): Promise<void> {
    await this.crypto.sendToDeviceEncrypted(this.peerUserId, this.peerDeviceId, type, {
      transaction_id: this.transactionId,
      from_device: this.myDeviceId,
      ...content,
    });
  }

  uiState(): SasUiState {
    return {
      transactionId: this.transactionId,
      initiatedByMe: this.initiatedByMe,
      peerUserId: this.peerUserId,
      peerDeviceId: this.peerDeviceId,
      phase: this.phase,
      emoji: this.emoji,
      error: this.error,
    };
  }

  private _emit(): void {
    this.onUi?.(this.uiState());
  }

  /* ----------------------------- initiator ----------------------------- */

  /** Initiator: send the initial verification request. */
  async sendRequest(): Promise<void> {
    this.phase = "requested";
    this._emit();
    await this.send("m.key.verification.request", {
      from_device: this.myDeviceId,
      methods: [
        SAS_METHOD,
        "m.qr_code.show.v1",
        "m.qr_code.scan.v1",
        "m.reciprocate.v1",
      ],
      timestamp: Date.now(),
      to: this.peerUserId,
    });
  }

  /** Either side: decline before the handshake starts (m.key.verification.cancel). */
  async decline(): Promise<void> {
    if (this.phase !== "requested") return;
    await this.send("m.key.verification.cancel", {
      code: "m.user",
      reason: "declined",
    });
    this.phase = "cancelled";
    this._emit();
    this._olmSas?.free();
    this._olmSas = null;
  }

  /** Initiator: respond to the responder's m.key.verification.start. */
  async handleStart(content: Record<string, unknown>): Promise<void> {
    const protocols = content.key_agreement_protocols;
    const macs = content.message_authentication_codes;
    const sasFormats = content.short_authentication_string;
    if (
      !Array.isArray(protocols) ||
      !Array.isArray(macs) ||
      !Array.isArray(sasFormats) ||
      !protocols.includes(KEY_AGREEMENT) ||
      !macs.includes(MAC_METHOD) ||
      !sasFormats.includes("emoji")
    ) {
      this._fail("unsupported verification algorithms");
      return;
    }
    await this.send("m.key.verification.accept", {
      key_agreement_protocol: KEY_AGREEMENT,
      hash: HASH,
      message_authentication_code: MAC_METHOD,
      short_authentication_string: ["emoji"],
    });
    this.phase = "started";
    await this._sendKey();
    this._emit();
  }

  /* ----------------------------- responder ----------------------------- */

  /** Responder: reply to a request with a start event. */
  async sendStart(): Promise<void> {
    this.phase = "requested";
    await this.send("m.key.verification.start", {
      method: SAS_METHOD,
      key_agreement_protocols: [KEY_AGREEMENT],
      hashes: [HASH],
      message_authentication_codes: [MAC_METHOD],
      short_authentication_string: ["emoji"],
    });
    this._emit();
  }

  async handleAccept(_content: Record<string, unknown>): Promise<void> {
    this.phase = "started";
    await this._sendKey();
    this._emit();
  }

  /* ------------------------------ key phase ---------------------------- */

  private async _sendKey(): Promise<void> {
    await this.send("m.key.verification.key", { key: this.olmSas.get_pubkey() });
  }

  /** Either side: receive the peer's SAS pubkey. */
  async handleKey(content: Record<string, unknown>): Promise<void> {
    const key = typeof content.key === "string" ? content.key : null;
    if (!key) {
      this._fail("missing SAS key");
      return;
    }
    if (!this._gotTheirKey) {
      this._gotTheirKey = true;
      this.olmSas.set_their_key(key);
    }
    if (this._bothKeysReady()) {
      this._computeEmoji();
    }
  }

  private _bothKeysReady(): boolean {
    /* libolm's set_their_key guards; both sides always send their key, so
       receiving one key while ours is implicit means we are ready. */
    return this._gotTheirKey;
  }

  private _computeEmoji(): void {
    /* Info string per the "curve25519" key agreement: the INITIATOR's
       user+device come first (matrix-js-sdk format). */
    const myPart = `${this.myUserId}${this.myDeviceId}`;
    const theirPart = `${this.peerUserId}${this.peerDeviceId}`;
    const info =
      "MATRIX_KEY_VERIFICATION_SAS" +
      (this.initiatedByMe ? myPart + theirPart : theirPart + myPart) +
      this.transactionId;
    const bytes = this.olmSas.generate_bytes(info, 6);
    this.emoji = sasBytesToEmoji(bytes);
    this.phase = "show-emoji";
    this._emit();
  }

  /* ------------------------------ MAC phase ---------------------------- */

  /**
   * Called when the user confirms the emoji match. Sends our MAC; the
   * transaction only completes once BOTH sides have exchanged MACs
   * (receiving theirs first does not excuse us from sending ours).
   */
  async confirmEmojiMatch(): Promise<void> {
    if (this.phase !== "show-emoji" && this.phase !== "mac-sent") return;
    if (!this._macSent) {
      this._macSent = true;
      const baseInfo =
        "MATRIX_KEY_VERIFICATION_MAC" +
        this.myUserId +
        this.myDeviceId +
        this.peerUserId +
        this.peerDeviceId +
        this.transactionId;
      const deviceKeyId = `ed25519:${this.myDeviceId}`;
      const mac: Record<string, string> = {
        [deviceKeyId]: this.olmSas.calculate_mac(this.myEd25519, baseInfo + deviceKeyId),
      };
      const keys = this.olmSas.calculate_mac(deviceKeyId, baseInfo + "KEY_IDS");
      await this.send("m.key.verification.mac", { mac, keys });
      this.phase = "mac-sent";
      this._emit();
    }
    if (this._theirMacVerified) {
      this._complete();
    }
  }

  /** Either side: verify the peer's MAC against their published device key. */
  async handleMac(content: Record<string, unknown>): Promise<void> {
    const mac = content.mac as Record<string, string> | undefined;
    const keys = typeof content.keys === "string" ? content.keys : null;
    if (!mac || !keys) {
      this._fail("malformed MAC event");
      return;
    }

    const baseInfo =
      "MATRIX_KEY_VERIFICATION_MAC" +
      this.peerUserId +
      this.peerDeviceId +
      this.myUserId +
      this.myDeviceId +
      this.transactionId;

    /* key IDs listed in the event must MAC correctly */
    const keyIds = Object.keys(mac).sort();
    if (keys !== this.olmSas.calculate_mac(keyIds.join(","), baseInfo + "KEY_IDS")) {
      this._fail("MAC key list mismatch");
      return;
    }

    /* verify the MAC of their Ed25519 key — and that it matches the key
       the server published for their device (substitution check) */
    const deviceKeyId = `ed25519:${this.peerDeviceId}`;
    const theirMac = mac[deviceKeyId];
    if (!theirMac) {
      this._fail("MAC does not cover their device key");
      return;
    }
    const theirEd25519 = await this.crypto.getDeviceEd25519(
      this.peerUserId,
      this.peerDeviceId
    );
    if (!theirEd25519) {
      this._fail("device key not published on the server");
      return;
    }
    if (this.olmSas.calculate_mac(theirEd25519, baseInfo + deviceKeyId) !== theirMac) {
      this._fail("MAC mismatch — the device key was not verified");
      return;
    }

    /* success: mark their device trusted; the transaction completes only
       when BOTH sides have exchanged MACs — if we have not sent ours yet
       (the user has not confirmed the emoji), stay open so we still can */
    await this.crypto.markDeviceVerified(this.peerUserId, this.peerDeviceId, theirEd25519);
    await this.send("m.key.verification.done", {});
    this._theirMacVerified = true;
    this._theirEd25519 = theirEd25519;
    if (this._macSent) {
      this._complete();
    } else {
      /* their MAC arrived before our user confirmed — keep the emoji up */
      this._emit();
    }
  }

  /** Both MACs exchanged: the transaction is complete. */
  private _complete(): void {
    if (this.phase === "verified") return;
    this.phase = "verified";
    this._emit();
    this.onVerified?.(this.peerUserId, this.peerDeviceId, this._theirEd25519);
    this._olmSas?.free();
    this._olmSas = null;
  }

  private _fail(message: string): void {
    this.phase = "failed";
    this.error = message;
    this._emit();
    this._olmSas?.free();
    this._olmSas = null;
  }
}

/**
 * Routes m.verification / m.key.verification payloads to transactions and
 * exposes UI callbacks. One per client, wired by app.ts. Holds SAS
 * transactions (emoji comparison) and QR transactions (show/scan a
 * code) — a request starts as SAS and can switch to QR while it is
 * still in the "requested" phase; both share the transaction id.
 */
export class VerificationManager {
  private readonly _transactions = new Map<string, SasTransaction>();
  private readonly _qrTransactions = new Map<string, QrTransaction>();
  /** optional — injected by app.ts so QR transactions can use the Element modes */
  crossSigning: import("./cross-signing.ts").CrossSigning | null = null;
  onUi: ((state: SasUiState) => void) | null = null;
  onQrUi: ((state: QrUiState) => void) | null = null;
  onIncoming: ((txn: SasTransaction) => void) | null = null;
  onVerified:
    | ((peerUserId: string, peerDeviceId: string, peerEd25519: string) => void)
    | null = null;

  private readonly _crypto: E2eeCrypto;

  constructor(crypto: E2eeCrypto) {
    this._crypto = crypto;
  }

  get transactions(): SasTransaction[] {
    return [...this._transactions.values()];
  }

  get qrTransactions(): QrTransaction[] {
    return [...this._qrTransactions.values()];
  }

  /**
   * Get (or create) the QR transaction sharing this request's id. The
   * QR transaction carries the same peer and initiatedByMe as the SAS
   * transaction for the id, so both sides reference one request.
   */
  asQr(transactionId: string): QrTransaction | null {
    const existing = this._qrTransactions.get(transactionId);
    if (existing) return existing;
    const base = this._transactions.get(transactionId);
    if (!base) return null;
    const txn = new QrTransaction({
      transactionId,
      initiatedByMe: base.initiatedByMe,
      myUserId: this._crypto.host.userId ?? "",
      myDeviceId: this._crypto.deviceId,
      peerUserId: base.peerUserId,
      peerDeviceId: base.peerDeviceId,
      crypto: this._crypto,
      crossSigning: this.crossSigning,
    });
    txn.onUi = (state) => this.onQrUi?.(state);
    txn.onVerified = (userId, deviceId, ed25519) => {
      /* the request is finished — drop both the QR and SAS entries */
      this._qrTransactions.delete(transactionId);
      this._transactions.delete(transactionId);
      this.onVerified?.(userId, deviceId, ed25519);
    };
    this._qrTransactions.set(transactionId, txn);
    return txn;
  }

  /** Start a verification with a specific device of another user. */
  start(peerUserId: string, peerDeviceId: string): SasTransaction {
    const transactionId = `gr-sas-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const txn = this._makeTxn(transactionId, true, peerUserId, peerDeviceId);
    void txn.sendRequest();
    return txn;
  }

  /**
   * Session verification: ask every OTHER device of the SAME user to
   * verify this one (the "new login" flow). Returns the started
   * transactions (one per device; offline devices simply never answer).
   */
  async startSessionVerification(): Promise<SasTransaction[]> {
    const ownUserId = this._crypto.host.userId ?? "";
    if (!ownUserId) return [];
    const devices = await this._crypto.getDevicesOf(ownUserId);
    const txns: SasTransaction[] = [];
    for (const device of devices) {
      if (device.deviceId === this._crypto.deviceId) continue;
      txns.push(this.start(ownUserId, device.deviceId));
    }
    return txns;
  }

  /** Decline/cancel a pending transaction by id. */
  async cancel(transactionId: string): Promise<void> {
    const txn = this._transactions.get(transactionId);
    if (!txn) return;
    this._transactions.delete(transactionId);
    await txn.decline();
  }

  /** Remove a transaction from the UI (e.g. an ignored request). */
  discard(transactionId: string): void {
    this._transactions.delete(transactionId);
  }

  /** Payload dispatch — called by E2eeCrypto for non-room-key payloads. */
  handlePayload(
    sender: string,
    type: string,
    content: Record<string, unknown>,
    senderKey?: string
  ): boolean {
    if (!type.startsWith("m.verification.") && !type.startsWith("m.key.verification.")) {
      return false;
    }
    const transactionId = typeof content.transaction_id === "string"
      ? content.transaction_id
      : null;
    const fromDevice = typeof content.from_device === "string"
      ? content.from_device
      : null;
    if (!transactionId) return true;

    /* QR reciprocate: the scanner's m.key.verification.start with
       method m.reciprocate.v1 goes to the shower's QR transaction */
    if (type === "m.key.verification.start" && content.method === "m.reciprocate.v1") {
      const qr = this._qrTransactions.get(transactionId) ?? this.asQr(transactionId);
      if (qr) void qr.handleReciprocateStart(content);
      return true;
    }

    /* done events complete QR transactions (SAS completes via MACs) */
    if (type === "m.key.verification.done" || type === "m.verification.done") {
      const qr = this._qrTransactions.get(transactionId);
      if (qr) {
        void qr.handleDone(senderKey ?? null);
        return true;
      }
      /* no QR transaction for this id — an SAS done; SAS completes via
         MAC exchange, so nothing to do */
      return true;
    }

    /* incoming request as the responder — spec name, legacy alias kept */
    if (type === "m.key.verification.request" || type === "m.verification.request") {
      if (!fromDevice || this._transactions.has(transactionId)) return true;
      const txn = this._makeTxn(transactionId, false, sender, fromDevice);
      this.onIncoming?.(txn);
      return true;
    }

    const txn = this._transactions.get(transactionId);
    if (!txn) return true;

    switch (type) {
      case "m.key.verification.start":
        void txn.handleStart(content);
        break;
      case "m.key.verification.accept":
        void txn.handleAccept(content);
        break;
      case "m.key.verification.key":
        void txn.handleKey(content);
        break;
      case "m.key.verification.mac":
        void txn.handleMac(content);
        break;
      case "m.key.verification.cancel":
      case "m.verification.cancel":
        txn.phase = "cancelled";
        break;
      default:
        break;
    }
    return true;
  }

  private _makeTxn(
    transactionId: string,
    initiatedByMe: boolean,
    peerUserId: string,
    peerDeviceId: string
  ): SasTransaction {
    const txn = new SasTransaction({
      transactionId,
      initiatedByMe,
      myUserId: this._crypto.host.userId ?? "",
      myDeviceId: this._crypto.deviceId,
      myEd25519: this._crypto.ed25519Key ?? "",
      peerUserId,
      peerDeviceId,
      crypto: this._crypto,
    });
    txn.onUi = (state) => this.onUi?.(state);
    txn.onVerified = (userId, deviceId, ed25519) => {
      this._transactions.delete(transactionId);
      this.onVerified?.(userId, deviceId, ed25519);
    };
    this._transactions.set(transactionId, txn);
    return txn;
  }
}
