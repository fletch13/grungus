/*
 * Grungus — SAS device verification (m.key.verification).
 *
 * Implements the short-authentication-string verification flow over
 * olm-encrypted to-device messages, interoperable with Element's rust
 * crypto stack (matrix-sdk-crypto / vodozemac):
 *
 *   - key agreement: "curve25519-hkdf-sha256" (the only one current
 *     Element offers; the legacy plain "curve25519" is still accepted
 *     for older peers)
 *   - MAC: "hkdf-hmac-sha256.v2" preferred (HMAC-SHA256 keyed by
 *     HKDF(SAS secret, info) — vodozemac's calculate_mac), the
 *     libolm-compat "hkdf-hmac-sha256" kept as a fallback
 *   - SAS bytes: HKDF(SAS secret) with the pipe-separated info
 *     "MATRIX_KEY_VERIFICATION_SAS|user|device|pubkey|user|device|
 *     pubkey|flowId" (initiator's side first — MSC3783)
 *   - MAC info: the legacy concatenated "MATRIX_KEY_VERIFICATION_MAC"
 *     form (what the rust stack uses for both MAC generations)
 *   - commitment: SHA-256(SAS pubkey || canonical JSON of the start
 *     content), sent in the accept, verified by the initiator
 *   - flow: request → ready (responder) → start (requester) → accept →
 *     keys → MACs, on olm-encrypted to-device events
 */

import type { E2eeCrypto } from "./e2ee.ts";
import { canonicalJson } from "./cross-signing.ts";
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
  | "ready-sent" /* responder answered a request, waiting for their start */
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

/* The algorithms we support, in preference order (rust stack order). */
const KEY_AGREEMENT_HKDF = "curve25519-hkdf-sha256";
const KEY_AGREEMENT_LEGACY = "curve25519";
const MAC_V2 = "hkdf-hmac-sha256.v2";
const MAC_MSC3783 = "org.matrix.msc3783.hkdf-hmac-sha256";
const MAC_V1 = "hkdf-hmac-sha256";
const HASH = "sha256";
const SAS_METHOD = "m.sas.v1";

const ALL_MAC_METHODS = [MAC_V2, MAC_MSC3783, MAC_V1];
const ALL_AGREEMENTS = [KEY_AGREEMENT_HKDF, KEY_AGREEMENT_LEGACY];
const ALL_METHODS = [
  SAS_METHOD,
  "m.qr_code.show.v1",
  "m.qr_code.scan.v1",
  "m.reciprocate.v1",
];

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "");
}

function strToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function sha256Bytes(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return new Uint8Array(digest);
}

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

  /* negotiated protocol */
  agreement: string = KEY_AGREEMENT_HKDF;
  macMethod: string = MAC_V2;

  private _olmSas: OlmSasApi | null = null;
  private _gotTheirKey = false;
  private _theirSasPubkey = "";
  private _macSent = false;
  /** their MAC arrived and verified — completes once ours is sent too */
  private _theirMacVerified = false;
  private _theirEd25519 = "";
  /** initiator only: the accept's commitment, checked against their key */
  private _theirCommitment: string | null = null;
  /** initiator only: the start content we sent (for the commitment check) */
  private _ourStartContent: Record<string, unknown> | null = null;

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

  /* --------------------------- request / ready --------------------------- */

  /** Initiator: send the initial verification request. */
  async sendRequest(): Promise<void> {
    this.phase = "requested";
    this._emit();
    await this.send("m.key.verification.request", {
      from_device: this.myDeviceId,
      methods: ALL_METHODS,
      timestamp: Date.now(),
      to: this.peerUserId,
    });
  }

  /** Responder: accept the request — announce readiness; the REQUESTER
   *  then starts the actual SAS exchange (the spec flow Element runs). */
  async sendReady(): Promise<void> {
    this.phase = "ready-sent";
    this._emit();
    await this.send("m.key.verification.ready", {
      from_device: this.myDeviceId,
      methods: ALL_METHODS,
    });
  }

  /** Initiator: the responder is ready — begin the SAS exchange. */
  async handleReady(): Promise<void> {
    if (!this.initiatedByMe) return; /* stray ready — nothing to do */
    if (this.phase !== "requested") return;
    await this.sendStart();
  }

  /** Either side: cancel the transaction (works from ANY active phase —
   *  the overlay's close buttons use this; terminal phases are no-ops). */
  async decline(): Promise<void> {
    if (this.phase === "verified" || this.phase === "cancelled") return;
    await this.send("m.key.verification.cancel", {
      code: "m.user",
      reason: "declined",
    });
    this.phase = "cancelled";
    this._emit();
    this._olmSas?.free();
    this._olmSas = null;
  }

  /* ------------------------------ start/accept ---------------------------- */

  /** Initiator: send the start event with our offered algorithms. */
  async sendStart(): Promise<void> {
    this.phase = "requested";
    /* the EXACT wire content — the accept's commitment hashes it */
    const content: Record<string, unknown> = {
      transaction_id: this.transactionId,
      from_device: this.myDeviceId,
      method: SAS_METHOD,
      key_agreement_protocols: ALL_AGREEMENTS,
      hashes: [HASH],
      message_authentication_codes: ALL_MAC_METHODS,
      short_authentication_string: ["decimal", "emoji"],
    };
    this._ourStartContent = content;
    await this.send("m.key.verification.start", content);
    this._emit();
  }

  /** Responder: negotiate + accept the initiator's start. */
  async handleStart(content: Record<string, unknown>): Promise<void> {
    const protocols = content.key_agreement_protocols;
    const macs = content.message_authentication_codes;
    const sasFormats = content.short_authentication_string;
    if (!Array.isArray(protocols) || !Array.isArray(macs) || !Array.isArray(sasFormats)) {
      this._fail("unsupported verification algorithms");
      return;
    }
    /* prefer the modern hkdf agreement; fall back to legacy curve25519
       (Element only ever offers the hkdf one) */
    const agreement = protocols.includes(KEY_AGREEMENT_HKDF)
      ? KEY_AGREEMENT_HKDF
      : protocols.includes(KEY_AGREEMENT_LEGACY)
        ? KEY_AGREEMENT_LEGACY
        : null;
    const macMethod = ALL_MAC_METHODS.find((m) => macs.includes(m)) ?? null;
    if (!agreement || !macMethod || !sasFormats.includes("emoji")) {
      await this.send("m.key.verification.cancel", {
        code: "m.unknown_method",
        reason: "no common verification algorithms",
      });
      this._fail("unsupported verification algorithms");
      return;
    }
    this.agreement = agreement;
    this.macMethod = macMethod;
    /* commitment: SHA-256(our SAS pubkey || canonical JSON of the start) */
    const commitment = bytesToB64(
      await sha256Bytes(
        new Uint8Array([
          ...strToBytes(this.olmSas.get_pubkey()),
          ...strToBytes(canonicalJson(content)),
        ])
      )
    );
    await this.send("m.key.verification.accept", {
      key_agreement_protocol: agreement,
      hash: HASH,
      message_authentication_code: macMethod,
      short_authentication_string: ["emoji"],
      commitment,
    });
    this.phase = "started";
    await this._sendKey();
    this._emit();
  }

  /** Initiator: the responder accepted — record the commitment and
   *  exchange keys. */
  async handleAccept(content: Record<string, unknown>): Promise<void> {
    if (typeof content.commitment === "string") {
      this._theirCommitment = content.commitment;
    }
    if (typeof content.key_agreement_protocol === "string") {
      this.agreement = content.key_agreement_protocol;
    }
    if (typeof content.message_authentication_code === "string") {
      this.macMethod = content.message_authentication_code;
    }
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
      this._theirSasPubkey = key;
      this.olmSas.set_their_key(key);
      /* initiator: the accept's commitment must match this key + our
         start (vodozemac checks this — so must we) */
      if (this.initiatedByMe && this._theirCommitment && this._ourStartContent) {
        const expected = bytesToB64(
          await sha256Bytes(
            new Uint8Array([
              ...strToBytes(key),
              ...strToBytes(canonicalJson(this._ourStartContent)),
            ])
          )
        );
        const norm = (s: string): string => s.replace(/=+$/, "");
        if (norm(expected) !== norm(this._theirCommitment)) {
          await this.send("m.key.verification.cancel", {
            code: "m.key_mismatch",
            reason: "SAS commitment mismatch",
          });
          this._fail("commitment mismatch — the accept was tampered with");
          return;
        }
      }
    }
    this._computeEmoji();
  }

  /* ----------------------------- SAS display ---------------------------- */

  private _computeEmoji(): void {
    if (!this._gotTheirKey) return;
    const myPubkey = this.olmSas.get_pubkey();
    if (this.agreement === KEY_AGREEMENT_HKDF) {
      /* MSC3783: pipe-separated, both sides' SAS pubkeys included, the
         initiator's ids first (vodozemac extra_info_sas) */
      const mine = `${this.myUserId}|${this.myDeviceId}|${myPubkey}`;
      const theirs = `${this.peerUserId}|${this.peerDeviceId}|${this._theirSasPubkey}`;
      const [first, second] = this.initiatedByMe ? [mine, theirs] : [theirs, mine];
      const info = `MATRIX_KEY_VERIFICATION_SAS|${first}|${second}|${this.transactionId}`;
      this.emoji = sasBytesToEmoji(this.olmSas.generate_bytes(info, 6));
    } else {
      /* legacy plain curve25519: concatenated ids, initiator first */
      const mine = `${this.myUserId}${this.myDeviceId}`;
      const theirs = `${this.peerUserId}${this.peerDeviceId}`;
      const info =
        "MATRIX_KEY_VERIFICATION_SAS" +
        (this.initiatedByMe ? mine + theirs : theirs + mine) +
        this.transactionId;
      this.emoji = sasBytesToEmoji(this.olmSas.generate_bytes(info, 6));
    }
    this.phase = "show-emoji";
    this._emit();
  }

  /* ------------------------------ MAC phase ---------------------------- */

  /**
   * MAC for the negotiated method.
   *
   * v2 (vodozemac calculate_mac): HMAC-SHA256(key = HKDF(SAS secret,
   * info), input) — libolm's generate_bytes IS that HKDF, so we derive
   * the key with it and HMAC via WebCrypto.
   *
   * v1 (libolm compat): olm's own calculate_mac — with the historical
   * buffer-reuse base64 quirk both libolm and vodozemac replicate.
   */
  private async _calculateMac(input: string, info: string): Promise<string> {
    if (this.macMethod === MAC_V2 || this.macMethod === MAC_MSC3783) {
      const macKey = this.olmSas.generate_bytes(info, 32);
      const key = await crypto.subtle.importKey(
        "raw",
        macKey as BufferSource,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", key, strToBytes(input) as BufferSource);
      return bytesToB64(new Uint8Array(sig));
    }
    return this.olmSas.calculate_mac(input, info);
  }

  /** The MAC info: the rust stack keeps the legacy concatenated form. */
  private _macInfo(firstUser: string, firstDevice: string, secondUser: string, secondDevice: string): string {
    return (
      "MATRIX_KEY_VERIFICATION_MAC" +
      firstUser +
      firstDevice +
      secondUser +
      secondDevice +
      this.transactionId
    );
  }

  /**
   * Called when the user confirms the emoji match. Sends our MAC; the
   * transaction only completes once BOTH sides have exchanged MACs
   * (receiving theirs first does not excuse us from sending ours).
   */
  async confirmEmojiMatch(): Promise<void> {
    if (this.phase !== "show-emoji" && this.phase !== "mac-sent") return;
    if (!this._macSent) {
      this._macSent = true;
      const baseInfo = this._macInfo(this.myUserId, this.myDeviceId, this.peerUserId, this.peerDeviceId);
      const deviceKeyId = `ed25519:${this.myDeviceId}`;
      const mac: Record<string, string> = {
        [deviceKeyId]: await this._calculateMac(this.myEd25519, baseInfo + deviceKeyId),
      };
      const keys = await this._calculateMac(deviceKeyId, baseInfo + "KEY_IDS");
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

    const baseInfo = this._macInfo(this.peerUserId, this.peerDeviceId, this.myUserId, this.myDeviceId);

    /* key IDs listed in the event must MAC correctly */
    const keyIds = Object.keys(mac).sort();
    if (keys !== (await this._calculateMac(keyIds.join(","), baseInfo + "KEY_IDS"))) {
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
    const norm = (s: string): string => s.replace(/=+$/, "");
    if (norm(await this._calculateMac(theirEd25519, baseInfo + deviceKeyId)) !== norm(theirMac)) {
      this._fail("MAC mismatch — the device key was not verified");
      return;
    }

    /* success: mark their device trusted; the transaction completes only
       when BOTH sides have exchanged MACs — if we have not sent ours yet
       (the user has not confirmed the emoji), stay open so we still can */
    await this.crypto.markDeviceVerified(this.peerUserId, this.peerDeviceId, theirEd25519);
    /* NO done here: our user may not have confirmed yet. Sending done now
       would complete the peer's request and tear down its flow BEFORE our
       own MAC arrives — the peer would never mark us verified (observed
       against matrix-rust-sdk: its request reaches Done on our done event).
       done goes out in _complete(), once BOTH MACs are exchanged. */
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
    /* the spec's done: sent once the verification has actually finished */
    void this.send("m.key.verification.done", {}).catch(() => {});
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

  /** Remove a transaction from the UI without touching the wire
   *  (declined/failed cards' Dismiss) — SAS and QR alike. */
  discard(transactionId: string): void {
    this._transactions.delete(transactionId);
    this._qrTransactions.delete(transactionId);
  }

  /** Cancel EVERYTHING (the overlay's ✕): all SAS + QR transactions,
   *  removed from the UI as well. */
  cancelAll(): void {
    for (const [id, txn] of [...this._transactions]) {
      this._transactions.delete(id);
      void txn.decline();
    }
    for (const [id, txn] of [...this._qrTransactions]) {
      this._qrTransactions.delete(id);
      void txn.decline();
    }
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

    /* ready — the responder accepted; the REQUESTER now starts */
    if (type === "m.key.verification.ready" || type === "m.verification.ready") {
      const txn = this._transactions.get(transactionId);
      if (txn) void txn.handleReady();
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
