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
 * Screenshare: getDisplayMedia (or a synthetic screen on hosts without
 * display capture), added to every peer connection mid-call with
 * renegotiation from either role. Bandwidth discipline for the mesh:
 * content-hinted screen encoding (~1.5 Mbps, 10fps cap) and one share
 * at a time. m.call.screenshare (active start/stop) rides the same
 * encrypted signaling — a Grungus extension, not verified against
 * Element Call.
 *
 * v1 limits (documented in the README): full mesh only (no SFU — an SFU
 * is the real fix for large-room screenshare bandwidth), no Element Call
 * interoperability (modeled on it, not verified against it).
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
  /** the peer's screen when they are sharing (separate from their camera) */
  screenStream: MediaStream | null;
  sharing: boolean;
  connectionState: string;
}

export interface CallUiState {
  active: boolean;
  roomId: string | null;
  participants: CallParticipant[];
  notice: string | null;
  localMuted: boolean;
  localSharing: boolean;
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
  screenStream: MediaStream;
  screenActive: boolean;
  connectionState: string;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

/* screen encoding caps — mesh bandwidth discipline: screens tolerate
   low fps, text needs sharpness; ~1.5 Mbps instead of camera defaults */
const SCREEN_MAX_BITRATE = 1_500_000;
const SCREEN_MAX_FPS = 10;

export class CallManager {
  private readonly client: MatrixClient;
  private _uiListener: ((state: CallUiState) => void) | null = null;
  private _roomId: string | null = null;
  private _localStream: MediaStream | null = null;
  private _syntheticCanvas: HTMLCanvasElement | null = null;
  private _syntheticTimer: ReturnType<typeof setInterval> | null = null;
  /** call-state heartbeat (keeps expires_ts fresh while connected) */
  private _memberHeartbeat: ReturnType<typeof setInterval> | null = null;
  /** when we first noticed being alone in the call (auto-leave grace) */
  private _aloneSince: number | null = null;
  /** the auto-leave timer when everyone else left */
  private _aloneTimer: ReturnType<typeof setTimeout> | null = null;
  private _audioCtx: AudioContext | null = null;
  private _peers = new Map<string, PeerEntry>();
  private _notice: string | null = null;
  private _localMuted = false;
  private _localDeviceId = "";
  private _removePayloadListener: (() => void) | null = null;
  /* screenshare state (this device as the sharer) */
  private _sharing = false;
  private _screenStream: MediaStream | null = null;
  private _syntheticScreenCanvas: HTMLCanvasElement | null = null;
  private _syntheticScreenTimer: ReturnType<typeof setInterval> | null = null;

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
    const now = Date.now();
    for (const [userId, content] of room.callMembers) {
      if (userId === ownUserId) continue;
      /* the legacy m.calls format: any NON-EXPIRED device of theirs */
      const calls = (content as { "m.calls"?: { "m.devices"?: { expires_ts?: number }[] }[] })[
        "m.calls"
      ];
      if (Array.isArray(calls)) {
        for (const call of calls) {
          for (const device of call["m.devices"] ?? []) {
            /* no expiry = pre-heartbeat state: treat as ongoing (the
               clear-on-hangup contract still applies) */
            if (device.expires_ts == null || device.expires_ts > now) return true;
          }
        }
      } else {
        return true;
      }
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
    this._removePayloadListener = crypto
      ? crypto.addPayloadListener((sender, type, content) => {
          this._onSignal(sender, type, content);
        })
      : null;

    await this._publishMember(true);
    this._reconcileMesh();
    this._emit();
    /* heartbeat: keep our call state's expires_ts fresh while we are
       in the call (a crash stops the beats and the entry expires) */
    this._memberHeartbeat = setInterval(() => {
      void this._publishMember(true).catch(() => {});
    }, 2 * 60_000);
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
    if (this._memberHeartbeat) {
      clearInterval(this._memberHeartbeat);
      this._memberHeartbeat = null;
    }
    if (this._aloneTimer) {
      clearTimeout(this._aloneTimer);
      this._aloneTimer = null;
    }
    this._aloneSince = null;
    this._syntheticCanvas = null;
    if (this._audioCtx) {
      void this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
    }
    this._stopScreenTracks();
    this._roomId = null;
    this._notice = null;
    this._localMuted = false;
    this._removePayloadListener?.();
    this._removePayloadListener = null;
    if (this.client.onToDevice) this.client.onToDevice = null;
    this._emit();
  }

  private _stopScreenTracks(): void {
    if (this._screenStream) {
      for (const track of this._screenStream.getTracks()) track.stop();
      this._screenStream = null;
    }
    if (this._syntheticScreenTimer) {
      clearInterval(this._syntheticScreenTimer);
      this._syntheticScreenTimer = null;
    }
    this._syntheticScreenCanvas = null;
    this._sharing = false;
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

  /* ------------------------------ screenshare ------------------------------ */

  get localSharing(): boolean {
    return this._sharing;
  }

  /** The locally captured/synthetic screen stream (for the local tile). */
  get localScreenStream(): MediaStream | null {
    return this._screenStream;
  }

  /**
   * Start sharing this device's screen with everyone in the call. One share
   * at a time (mesh bandwidth discipline): a remote share blocks starting.
   * Falls back to a synthetic screen when the host has no display capture
   * (headless/CI) so the whole pipeline stays verifiable.
   */
  async startScreenshare(): Promise<void> {
    if (!this.active || this._sharing) return;

    const remoteSharer = this.remoteSharer();
    if (remoteSharer) {
      this._notice = `${remoteSharer.name} is already sharing — one share at a time`;
      this._emit();
      return;
    }

    const captured = await this._acquireScreen();
    this._screenStream = captured.stream;
    if (captured.synthetic) {
      this._notice = "No display capture available — sharing a synthetic screen";
    } else if (this._notice && this._notice.includes("synthetic")) {
      this._notice = null;
    }
    this._sharing = true;

    /* tell the peers BEFORE the media can arrive so their track routing
       knows the next video track is a screen */
    await this._broadcastSignal("m.call.screenshare", { active: true });

    const screenStream = this._screenStream;
    for (const entry of this._peers.values()) {
      for (const track of screenStream.getTracks()) {
        try {
          const sender = entry.pc.addTrack(track, screenStream);
          this._capScreenSender(sender);
        } catch (err) {
          console.error("[call] addTrack(screen) failed:", err);
        }
      }
    }
    this._emit();
  }

  async stopScreenshare(): Promise<void> {
    if (!this._sharing) return;
    await this._broadcastSignal("m.call.screenshare", { active: false });
    const screenStream = this._screenStream;
    for (const entry of this._peers.values()) {
      if (!screenStream) continue;
      for (const track of screenStream.getTracks()) {
        for (const sender of entry.pc.getSenders()) {
          if (sender.track === track) {
            try {
              entry.pc.removeTrack(sender);
            } catch (err) {
              console.warn("[call] removeTrack(screen) failed:", err);
            }
          }
        }
      }
    }
    this._stopScreenTracks();
    if (this._notice && this._notice.includes("synthetic screen")) {
      this._notice = null;
    }
    this._emit();
  }

  /** The peer currently sharing, if any (soft one-share-at-a-time). */
  remoteSharer(): CallParticipant | null {
    const entry = [...this._peers.values()].find((p) => p.screenActive);
    if (!entry) return null;
    return {
      key: `${entry.userId}|${entry.deviceId}`,
      userId: entry.userId,
      deviceId: entry.deviceId,
      name: this._nameFor(entry.userId),
      stream: entry.stream,
      screenStream: entry.screenStream,
      sharing: true,
      connectionState: entry.connectionState,
    };
  }

  private async _acquireScreen(): Promise<{ stream: MediaStream; synthetic: boolean }> {
    try {
      const md = navigator.mediaDevices;
      if (md && typeof md.getDisplayMedia === "function") {
        const stream = await md.getDisplayMedia({
          video: { frameRate: { ideal: SCREEN_MAX_FPS, max: SCREEN_MAX_FPS } },
          audio: false,
        });
        for (const track of stream.getVideoTracks()) {
          /* text/detail keeps small UI text sharp at low bitrates */
          if (typeof track.contentHint === "string") track.contentHint = "detail";
        }
        return { stream, synthetic: false };
      }
    } catch (err) {
      console.warn("[call] getDisplayMedia failed, falling back to synthetic screen:", err);
    }
    return { stream: this._syntheticScreen(), synthetic: true };
  }

  /** A synthetic screen: animated text canvas producing REAL RTP frames. */
  private _syntheticScreen(): MediaStream {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    this._syntheticScreenCanvas = canvas;
    const ctx = canvas.getContext("2d")!;
    let tick = 0;
    const draw = (): void => {
      tick += 1;
      ctx.fillStyle = "#101319";
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = "#7ee787";
      ctx.font = "18px monospace";
      const lines = [
        "GRUNGUS — synthetic screen share",
        "",
        "$ grungus --share-screen",
        "reading frame " + tick + " ...",
        "",
        "[ok] renegotiation: offer -> answer",
        "[ok] screen track flowing (10 fps cap)",
      ];
      lines.forEach((line, i) => ctx.fillText(line, 16, 40 + i * 26));
    };
    draw();
    this._syntheticScreenTimer = setInterval(draw, 100);
    const stream = canvas.captureStream(SCREEN_MAX_FPS) as MediaStream;
    for (const track of stream.getVideoTracks()) {
      if (typeof track.contentHint === "string") track.contentHint = "text";
    }
    return stream;
  }

  /** Best-effort sender-side caps for the mesh (~1.5 Mbps, 10fps). */
  private _capScreenSender(sender: RTCRtpSender): void {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      params.encodings[0]!.maxBitrate = SCREEN_MAX_BITRATE;
      params.encodings[0]!.maxFramerate = SCREEN_MAX_FPS;
      void sender.setParameters(params).catch(() => {
        /* encoder defaults then — caps are best-effort */
      });
    } catch {
      /* getParameters unsupported — best-effort only */
    }
  }

  private async _broadcastSignal(type: string, content: Record<string, unknown>): Promise<void> {
    for (const entry of this._peers.values()) {
      await this._sendSignal(entry.userId, entry.deviceId, type, {
        call_id: "",
        device_id: this._localDeviceId,
        ...content,
      });
    }
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
              "m.devices": [
                {
                  device_id: this._localDeviceId,
                  muted: this._localMuted,
                  /* a crashed client never clears its state — the
                     heartbeat republishes every 2 min and the entry
                     self-heals 5 min after the last beat */
                  expires_ts: Date.now() + 5 * 60_000,
                },
              ],
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

    /* everyone else left: a DM call with nobody on the other side is
       over — leave after a short grace so a peer's state blip does
       not drop the call */
    const others = [...present].some((key) => key.split("|")[0] !== this.client.userId);
    if (!others && this._peers.size === 0) {
      if (this._aloneTimer == null) {
        this._aloneTimer = setTimeout(() => {
          this._aloneTimer = null;
          this._aloneSince = null;
          void this.hangUp();
        }, 4_000);
        this._aloneSince = Date.now();
      }
    } else if (this._aloneTimer != null) {
      clearTimeout(this._aloneTimer);
      this._aloneTimer = null;
      this._aloneSince = null;
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
      screenStream: new MediaStream(),
      screenActive: false,
      connectionState: "new",
    };
    this._peers.set(key, entry);

    /* media */
    if (this._localStream) {
      for (const track of this._localStream.getTracks()) {
        pc.addTrack(track, this._localStream);
      }
    }
    /* a share started before this peer joined still reaches them */
    if (this._screenStream) {
      for (const track of this._screenStream.getTracks()) {
        try {
          const sender = pc.addTrack(track, this._screenStream);
          this._capScreenSender(sender);
        } catch (err) {
          console.error("[call] addTrack(screen) failed:", err);
        }
      }
    }
    pc.ontrack = (event) => {
      for (const stream of event.streams) {
        for (const track of stream.getTracks()) {
          /* route the screen track to its own stream when we know a share
             is active; the signal usually precedes the media (the sharer
             broadcasts before adding the track) */
          if (
            entry.screenActive &&
            track.kind === "video" &&
            entry.screenStream.getVideoTracks().length === 0
          ) {
            entry.screenStream.addTrack(track);
            continue;
          }
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
      /* BOTH roles may need to renegotiate mid-call (a screenshare adds a
         track from either side); perfect negotiation resolves collisions:
         the polite peer rolls back on glare (see _handleNegotiate) */
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
    } else if (type === "m.call.screenshare") {
      this._handleScreenshareSignal(entry, content);
    }
  }

  /** A peer started/stopped sharing their screen. */
  private _handleScreenshareSignal(entry: PeerEntry, content: Record<string, unknown>): void {
    const active = content.active === true;
    if (active) {
      entry.screenActive = true;
      /* tolerate the media having raced ahead of the signal: a second
         video track already sitting in the camera stream is the screen */
      const cameraVideos = entry.stream?.getVideoTracks() ?? [];
      if (cameraVideos.length > 1) {
        const maybeScreen = cameraVideos[cameraVideos.length - 1]!;
        entry.stream?.removeTrack(maybeScreen);
        entry.screenStream.addTrack(maybeScreen);
      }
    } else {
      entry.screenActive = false;
      for (const track of entry.screenStream.getTracks()) {
        track.stop(); /* remote track — stopping locally frees the tile */
      }
      entry.screenStream = new MediaStream();
    }
    this._emit();
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

    /* glare: the polite peer was mid-offer when the peer's offer arrived —
       roll back ours and accept theirs (canonical perfect negotiation) */
    if (description.type === "offer" && entry.polite && offerCollision) {
      try {
        await entry.pc.setLocalDescription(); /* implicit rollback */
      } catch (err) {
        console.warn("[call] rollback failed:", err);
      }
    }

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
        screenStream: entry.screenActive && entry.screenStream.getTracks().length > 0
          ? entry.screenStream
          : null,
        sharing: entry.screenActive,
        connectionState: entry.connectionState,
      });
    }
    this._uiListener({
      active: this._roomId !== null,
      roomId: this._roomId,
      participants,
      notice: this._notice,
      localMuted: this._localMuted,
      localSharing: this._sharing,
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
