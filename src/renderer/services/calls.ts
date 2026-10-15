/*
 * Grungus — native group calls (MSC3401, full-mesh WebRTC).
 *
 * Signaling follows MSC3401 (the model Element Call uses):
 *   - m.call.member room state, per user: which devices are in a call
 *   - m.call.negotiate / m.call.candidates to-device messages for SDP and
 *     ICE, olm-encrypted when the room is encrypted, plaintext otherwise
 *   - one RTCPeerConnection per remote device (full mesh), with the
 *     standard perfect-negotiation pattern (polite peer by key order)
 *
 * Media: WebRTC DTLS-SRTP (always encrypted pairwise; in a full mesh there
 * is no middleman). When no capture devices exist (headless hosts, CI),
 * a synthetic canvas/oscillator stream is used so calls remain testable
 * and demonstrable — the UI shows a notice.
 *
 * v1 limits (documented in the README): full mesh only (no SFU), no
 * screenshare, no Element Call interoperability (modeled on it, not
 * verified against it).
 */

import type { MatrixClient, Room, ToDeviceEvent } from "./matrix-client.ts";
import { mxidLocalpart } from "./matrix-client.ts";
import type { E2eeCrypto } from "./e2ee.ts";
import { colorFor, initials } from "../components/ui.ts";

export interface CallParticipant {
  key: string; /* userId|deviceId */
  userId: string;
  deviceId: string;
  name: string;
  stream: MediaStream | null;
  connectionState: string;
}

export interface CallUiState {
  active: boolean;
  roomId: string | null;
  participants: CallParticipant[];
  notice: string | null;
  localMuted: boolean;
  localKey: string | null;
}

interface PeerEntry {
  userId: string;
  deviceId: string;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  remoteDescriptionSet: boolean;
  stream: MediaStream | null;
  connectionState: string;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

export class CallManager {
  private readonly client: MatrixClient;
  private _uiListener: ((state: CallUiState) => void) | null = null;
  private _roomId: string | null = null;
  private _localStream: MediaStream | null = null;
  private _syntheticCanvas: HTMLCanvasElement | null = null;
  private _syntheticTimer: ReturnType<typeof setInterval> | null = null;
  private _audioCtx: AudioContext | null = null;
  private _peers = new Map<string, PeerEntry>();
  private _notice: string | null = null;
  private _localMuted = false;
  private _localDeviceId = "";

  constructor(client: MatrixClient) {
    this.client = client;
  }

  get roomId(): string | null {
    return this._roomId;
  }

  get active(): boolean {
    return this._roomId !== null;
  }

  setUiListener(listener: (state: CallUiState) => void): void {
    this._uiListener = listener;
    this._emit();
  }

  private get crypto(): E2eeCrypto | null {
    return this.client.crypto;
  }

  private get localKey(): string {
    return `${this.client.userId}|${this._localDeviceId}`;
  }

  /** Is there an ongoing call in the room (someone besides us)? */
  static callOngoing(room: Room | null, ownUserId: string | null): boolean {
    if (!room) return false;
    for (const userId of room.callMembers.keys()) {
      if (userId !== ownUserId) return true;
    }
    return false;
  }

  /* ------------------------------ lifecycle ------------------------------ */

  async start(roomId: string, opts: { video?: boolean } = {}): Promise<void> {
    if (this._roomId !== null) return;
    this._roomId = roomId;
    this._localDeviceId = this.client.deviceId ?? "NODEVICE";

    const media = await this.acquireMedia(opts.video === true);
    this._localStream = media.stream;
    this._notice = media.synthetic
      ? "No microphone/camera available — using a synthetic stream"
      : null;

    /* register signal hooks */
    this.client.onToDevice = (event) => this._onPlainSignal(event);
    const crypto = this.client.crypto;
    if (crypto) {
      crypto.toDevicePayloadHandler = (sender, payload) => {
        this._onSignal(sender, payload.type, payload.content);
      };
    }

    await this._publishMember(true);
    this._reconcileMesh();
    this._emit();
  }

  async hangUp(): Promise<void> {
    if (this._roomId === null) return;
    await this._publishMember(false).catch(() => {});
    this._teardown();
  }

  private _teardown(): void {
    for (const entry of this._peers.values()) {
      try {
        entry.pc.close();
      } catch {
        /* already closed */
      }
    }
    this._peers.clear();

    if (this._localStream) {
      for (const track of this._localStream.getTracks()) track.stop();
      this._localStream = null;
    }
    if (this._syntheticTimer) {
      clearInterval(this._syntheticTimer);
      this._syntheticTimer = null;
    }
    this._syntheticCanvas = null;
    if (this._audioCtx) {
      void this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
    }
    this._roomId = null;
    this._notice = null;
    this._localMuted = false;
    if (this.client.crypto) this.client.crypto.toDevicePayloadHandler = null;
    if (this.client.onToDevice) this.client.onToDevice = null;
    this._emit();
  }

  /* -------------------------------- media -------------------------------- */

  private async acquireMedia(
    video: boolean
  ): Promise<{ stream: MediaStream; synthetic: boolean }> {
    try {
      if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video,
        });
        return { stream, synthetic: false };
      }
    } catch (err) {
      console.warn("[call] getUserMedia failed, falling back to synthetic:", err);
    }
    return { stream: this._syntheticStream(), synthetic: true };
  }

  /**
   * A synthetic media stream: an animated canvas (known color per user,
   * moving bar so frames keep flowing) plus a quiet oscillator audio
   * track. Used when no capture devices exist — it produces REAL RTP
   * media, so the full WebRTC path stays verifiable.
   */
  private _syntheticStream(): MediaStream {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    this._syntheticCanvas = canvas;

    const ctx = canvas.getContext("2d")!;
    const base = colorFor(this.client.userId ?? "?");
    let tick = 0;
    const draw = (): void => {
      tick = (tick + 1) % 320;
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(tick, 100, 20, 40);
    };
    draw();
    this._syntheticTimer = setInterval(draw, 100);

    const stream = canvas.captureStream(15) as MediaStream;

    /* quiet 440Hz tone so an audio track exists */
    const AudioCtor =
      (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
      AudioContext;
    this._audioCtx = new AudioCtor();
    const dest = this._audioCtx.createMediaStreamDestination();
    const osc = this._audioCtx.createOscillator();
    const gain = this._audioCtx.createGain();
    gain.gain.value = 0.02;
    osc.frequency.value = 440;
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);

    return stream;
  }

  /** Sample the synthetic canvas color (used by e2e verification). */
  syntheticColorCss(): string | null {
    if (!this._syntheticCanvas) return null;
    const ctx = this._syntheticCanvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
  }

  setMuted(muted: boolean): void {
    this._localMuted = muted;
    if (this._localStream) {
      for (const track of this._localStream.getAudioTracks()) track.enabled = !muted;
    }
    this._emit();
  }

  /* ------------------------------ membership ------------------------------ */

  private async _publishMember(activeInCall: boolean): Promise<void> {
    const roomId = this._roomId;
    if (!roomId || !this.client.userId) return;
    const userId = this.client.userId;

    const content: Record<string, unknown> = activeInCall
      ? {
          "m.calls": [
            {
              "m.call_id": "",
              "m.devices": [{ device_id: this._localDeviceId, muted: this._localMuted }],
            },
          ],
        }
      : { "m.calls": [] };

    await this.client.sendStateEvent(roomId, "m.call.member", userId, content);
  }

  /** Called by the app on every room update for the call room. */
  onRoomUpdate(room: Room): void {
    if (room.id !== this._roomId) return;
    this._reconcileMesh();
    this._emit();
  }

  /** Recompute the mesh from the room's m.call.member states. */
  private _reconcileMesh(): void {
    const room = this._roomId ? this.client.getRoom(this._roomId) : null;
    if (!room || this._localStream === null) return;

    const present = new Set<string>();
    for (const [userId, content] of room.callMembers) {
      const calls = content["m.calls"];
      if (!Array.isArray(calls)) continue;
      for (const call of calls as { "m.devices"?: { device_id?: unknown }[] }[]) {
        for (const device of call["m.devices"] ?? []) {
          if (typeof device.device_id === "string" && device.device_id) {
            present.add(`${userId}|${device.device_id}`);
          }
        }
      }
    }

    /* drop peers that left the call */
    for (const key of [...this._peers.keys()]) {
      if (!present.has(key)) this._closePeer(key);
    }

    /* add new peers (own devices are skipped — v1 meshes distinct users) */
    for (const key of present) {
      if (this._peers.has(key)) continue;
      const [userId, deviceId] = key.split("|");
      if (userId === this.client.userId) continue;
      if (userId && deviceId) this._addPeer(userId, deviceId);
    }
  }

  /* ------------------------------ peer setup ------------------------------ */

  private _addPeer(userId: string, deviceId: string): void {
    const key = `${userId}|${deviceId}`;
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const polite = this.localKey > key; /* smaller key is impolite (offers) */
    const entry: PeerEntry = {
      userId,
      deviceId,
      pc,
      polite,
      makingOffer: false,
      ignoreOffer: false,
      remoteDescriptionSet: false,
      pendingCandidates: [],
      stream: new MediaStream(),
      connectionState: "new",
    };
    this._peers.set(key, entry);

    /* media */
    if (this._localStream) {
      for (const track of this._localStream.getTracks()) {
        pc.addTrack(track, this._localStream);
      }
    }
    pc.ontrack = (event) => {
      for (const stream of event.streams) {
        for (const track of stream.getTracks()) {
          entry.stream?.addTrack(track);
        }
      }
      if (entry.stream && entry.stream.getTracks().length === 0 && event.track) {
        entry.stream.addTrack(event.track);
      }
      this._emit();
    };
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        void this._sendSignal(userId, deviceId, "m.call.candidates", {
          call_id: "",
          device_id: this._localDeviceId,
          candidates: [event.candidate.toJSON()],
        });
      }
    };
    pc.onconnectionstatechange = () => {
      entry.connectionState = pc.connectionState;
      if (pc.connectionState === "failed") {
        void pc.restartIce();
      }
      this._emit();
    };
    pc.onnegotiationneeded = async () => {
      if (entry.polite) return; /* only the impolite side offers */
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription(await pc.createOffer());
        if (pc.localDescription) {
          void this._sendSignal(userId, deviceId, "m.call.negotiate", {
            call_id: "",
            device_id: this._localDeviceId,
            description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
        }
      } catch (err) {
        console.error("[call] offer failed:", err);
      } finally {
        entry.makingOffer = false;
      }
    };

    /* the impolite peer fires negotiationneeded from addTrack and offers */
    this._emit();
  }

  private _closePeer(key: string): void {
    const entry = this._peers.get(key);
    if (!entry) return;
    try {
      entry.pc.close();
    } catch {
      /* ignore */
    }
    this._peers.delete(key);
    this._emit();
  }

  /* ------------------------------- signaling ------------------------------ */

  private async _sendSignal(
    targetUserId: string,
    targetDeviceId: string,
    type: string,
    content: Record<string, unknown>
  ): Promise<void> {
    try {
      const room = this._roomId ? this.client.getRoom(this._roomId) : null;
      if (room?.isEncrypted && this.crypto) {
        await this.crypto.sendToDeviceEncrypted(targetUserId, targetDeviceId, type, content);
      } else {
        await this.client.sendToDevice(targetUserId, targetDeviceId, type, content);
      }
    } catch (err) {
      console.error(`[call] signal ${type} to ${targetUserId}/${targetDeviceId} failed:`, err);
    }
  }

  /** plaintext to-device hook (unencrypted rooms) */
  private _onPlainSignal(event: ToDeviceEvent): void {
    if (!this._roomId) return;
    if (!event.type.startsWith("m.call.")) return;
    this._onSignal(event.sender, event.type, event.content as Record<string, unknown>);
  }

  private _onSignal(
    sender: string,
    type: string,
    content: Record<string, unknown>
  ): void {
    if (!this._roomId) return;
    const senderDevice = typeof content.device_id === "string" ? content.device_id : null;
    if (!sender || !senderDevice) return;
    if (sender === this.client.userId && senderDevice === this._localDeviceId) return;
    const key = `${sender}|${senderDevice}`;
    const entry = this._peers.get(key);
    if (!entry) return;

    if (type === "m.call.negotiate") {
      void this._handleNegotiate(entry, content);
    } else if (type === "m.call.candidates") {
      void this._handleCandidates(entry, content);
    }
  }

  private async _handleNegotiate(
    entry: PeerEntry,
    content: Record<string, unknown>
  ): Promise<void> {
    const description = content.description as
      | { type?: string; sdp?: string }
      | undefined;
    if (!description?.type || !description.sdp) return;
    const offerCollision =
      description.type === "offer" &&
      (entry.makingOffer || entry.pc.signalingState !== "stable");

    entry.ignoreOffer = !entry.polite && offerCollision;
    if (entry.ignoreOffer) return;

    try {
      if (description.type === "offer" && entry.polite) {
        await entry.pc.setRemoteDescription({ type: description.type, sdp: description.sdp });
        await this._flushPendingCandidates(entry);
        await entry.pc.setLocalDescription(await entry.pc.createAnswer());
        if (entry.pc.localDescription) {
          void this._sendSignal(entry.userId, entry.deviceId, "m.call.negotiate", {
            call_id: "",
            device_id: this._localDeviceId,
            description: {
              type: entry.pc.localDescription.type,
              sdp: entry.pc.localDescription.sdp,
            },
          });
        }
      } else if (description.type === "answer") {
        await entry.pc.setRemoteDescription({ type: description.type, sdp: description.sdp });
        await this._flushPendingCandidates(entry);
      }
      entry.remoteDescriptionSet = true;
      this._emit();
    } catch (err) {
      console.error("[call] negotiate failed:", err);
    }
  }

  private async _handleCandidates(
    entry: PeerEntry,
    content: Record<string, unknown>
  ): Promise<void> {
    const candidates = content.candidates as
      | RTCIceCandidateInit[]
      | undefined;
    if (!Array.isArray(candidates)) return;
    for (const candidate of candidates) {
      try {
        if (entry.pc.remoteDescription) {
          await entry.pc.addIceCandidate(candidate);
        } else {
          entry.pendingCandidates.push(candidate);
        }
      } catch (err) {
        console.warn("[call] addIceCandidate failed:", err);
      }
    }
  }

  private async _flushPendingCandidates(entry: PeerEntry): Promise<void> {
    const pending = entry.pendingCandidates.splice(0, entry.pendingCandidates.length);
    for (const candidate of pending) {
      try {
        await entry.pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn("[call] flush candidate failed:", err);
      }
    }
  }

  /* --------------------------------- UI ----------------------------------- */

  private _emit(): void {
    if (!this._uiListener) return;
    const participants: CallParticipant[] = [];
    for (const [key, entry] of this._peers) {
      participants.push({
        key,
        userId: entry.userId,
        deviceId: entry.deviceId,
        name: this._nameFor(entry.userId),
        stream: entry.stream,
        connectionState: entry.connectionState,
      });
    }
    this._uiListener({
      active: this._roomId !== null,
      roomId: this._roomId,
      participants,
      notice: this._notice,
      localMuted: this._localMuted,
      localKey: this._roomId ? this.localKey : null,
    });
  }

  private _nameFor(userId: string): string {
    if (!this._roomId) return mxidLocalpart(userId);
    const room = this.client.getRoom(this._roomId);
    const member = room?.members.get(userId);
    return member?.displayname ?? mxidLocalpart(userId);
  }

  /** Exposed for the local video tile. */
  get localStream(): MediaStream | null {
    return this._localStream;
  }

  /** Stable initials/color helpers for tiles (imported for the view). */
  static tileInitials(name: string): string {
    return initials(name);
  }

  static tileColor(seed: string): string {
    return colorFor(seed);
  }
}
