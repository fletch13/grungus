import { SettingsStore } from "./settings.ts";
import { setCamera, switchMicrophone } from "./call-devices.ts";
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
 * capture errors are reported so the user can choose another device
 * instead of generating replacement media.
 *
 * Screenshare: getDisplayMedia (real capture only; hosts without
 * display capture), added to every peer connection mid-call with
 * renegotiation from either role. Bandwidth discipline for the mesh:
 * content-hinted screen encoding (~1.5 Mbps, 10fps cap) and one share
 * at a time. m.call.screenshare (active start/stop) rides the same
 * encrypted signaling — a Grungus extension, not verified against
 * Element Call.
 *
 * v1 limits (documented in the README): full mesh only (no SFU — an SFU
 * is the real fix for large-room screenshare bandwidth). 1:1 DM calls
 * use the legacy room-event protocol (calls-p2p.ts) for Element interop;
 * this mesh serves group rooms.
 */

import type { MatrixClient, Room, ToDeviceEvent } from "./matrix-client.ts";
import { mxidLocalpart } from "./matrix-client.ts";
import type { E2eeCrypto } from "./e2ee.ts";
import { colorFor, initials } from "../components/ui.ts";
import { CallMedia } from "./call-media.ts";
import {
  attachReceiverTransform,
  attachSenderTransform,
  bytesToB64,
  b64ToBytes,
  importAesGcm,
  MEDIA_KEY_BYTES,
  randomBytes,
} from "./media-e2ee.ts";

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
  speaking?: boolean;
}

export interface CallUiState {
  localSpeaking?: boolean;
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
  /** the peer's media-encryption keys by key id (their sender keys) */
  remoteKeys: Map<number, CryptoKey>;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

export class CallManager {
  private readonly client: MatrixClient;
  private _uiListener: ((state: CallUiState) => void) | null = null;
  private _roomId: string | null = null;
  private _localStream: MediaStream | null = null;
  /** media acquisition (real device capture only) */
  private _media: CallMedia;
  /** call-state heartbeat (keeps expires_ts fresh while connected) */
  private _memberHeartbeat: ReturnType<typeof setInterval> | null = null;
  /** when we first noticed being alone in the call (auto-leave grace) */
  private _aloneSince: number | null = null;
  /** the auto-leave timer when everyone else left */
  private _aloneTimer: ReturnType<typeof setTimeout> | null = null;
  /** true once other members appeared in the call state (auto-leave
   *  only fires after a real call happened — never while ringing) */
  private _sawOthersInCall = false;
  private _peers = new Map<string, PeerEntry>();
  private _notice: string | null = null;
  /** E2EE media state — active in encrypted rooms only (keys ride olm) */
  private _mediaE2ee = false;
  private _mediaKeyBytes: Uint8Array | null = null;
  private _mediaKey: CryptoKey | null = null;
  private _mediaKeyId = 0;
  /** frame counters for the UI/debug (encrypted/dropped) */
  private _framesDropped = 0;
  private _framesEncrypted = 0;
  private _localMuted = false;
  private _localDeviceId = "";
  private _removePayloadListener: (() => void) | null = null;
  /* screenshare state (this device as the sharer) */
  private _sharing = false;
  private _screenStream: MediaStream | null = null;

  constructor(client: MatrixClient) {
    this.client = client;
    this._media = new CallMedia(client.userId ?? "?");
  }

  get roomId(): string | null {
    return this._roomId;
  }

  get active(): boolean {
    return this._roomId !== null;
  }

  /** True when the call's media frames are end-to-end encrypted. */
  get e2eeMedia(): boolean {
    return this._mediaE2ee;
  }

  /** Encrypted-frame count (debug/live verification). */
  get framesEncrypted(): number {
    return this._framesEncrypted;
  }

  /** Dropped-inbound-frame count (unknown key / bad tag — fail closed). */
  get framesDropped(): number {
    return this._framesDropped;
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

    /* E2EE media: encrypted rooms only — the media keys ride the same
       olm-encrypted signal channel as the call signaling */
    const room = this.client.getRoom(roomId);
    if (room?.isEncrypted && this.client.crypto) {
      this._mediaE2ee = true;
      this._mediaKeyBytes = randomBytes(MEDIA_KEY_BYTES);
      this._mediaKey = await importAesGcm(this._mediaKeyBytes, ["encrypt"]);
      this._mediaKeyId = 1;
    }

    const media = await this._media.acquire(opts.video === true).catch(error => { this._teardown(); throw error; });
    this._localStream = media.stream;
    this._notice = null;
    if (this._mediaE2ee) {
      this._notice = (this._notice ? this._notice + " · " : "") + "🔒 E2EE media";
    }

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

    /* E2EE media state: keys only live as long as the call */
    this._mediaE2ee = false;
    this._mediaKeyBytes = null;
    this._mediaKey = null;
    this._mediaKeyId = 0;
    this._framesDropped = 0;

    if (this._localStream) {
      for (const track of this._localStream.getTracks()) track.stop();
      this._localStream = null;
    }
    this._media.stop();
    if (this._memberHeartbeat) {
      clearInterval(this._memberHeartbeat);
      this._memberHeartbeat = null;
    }
    if (this._aloneTimer) {
      clearTimeout(this._aloneTimer);
      this._aloneTimer = null;
    }
    this._aloneSince = null;
    this._sawOthersInCall = false;
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
    this._media.stopScreen();
    this._sharing = false;
  }

  /* -------------------------------- media -------------------------------- */


  private _cameraTransforms = new WeakSet<RTCRtpSender>();
  get localCameraEnabled(): boolean { return this._localStream?.getVideoTracks().some(track => track.readyState === "live") ?? false; }
  async setCameraEnabled(enabled: boolean): Promise<void> {
    const stream = this._localStream;
    const prefs = new SettingsStore();
    await setCamera(stream, [...this._peers.values()].map(peer => peer.pc), () => this._localStream === stream && this._roomId !== null, enabled, prefs.get("videoInput"), sender => {
      if (this._mediaE2ee && !this._cameraTransforms.has(sender)) {
        this._cameraTransforms.add(sender);
        attachSenderTransform(sender, () => ({ keyId: this._mediaKeyId, key: this._mediaKey! }), () => { this._framesEncrypted++; });
      }
    });
    this._emit();
  }

  async switchAudioInput(deviceId: string): Promise<void> {
    const stream = this._localStream;
    await switchMicrophone(stream, () => [...this._peers.values()].map(peer => peer.pc), () => this._localStream === stream && this._roomId !== null, () => this._localMuted, deviceId);
    this._emit();
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

  /** The locally captured screen stream (for the local tile). */
  get localScreenStream(): MediaStream | null {
    return this._screenStream;
  }

  /**
   * Start sharing this device's screen with everyone in the call. One share
   * at a time (mesh bandwidth discipline): a remote share blocks starting.
   * Returns without sharing when the host has no display capture
   * or the user cancels the source picker.
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
    if (!captured) return;
    this._screenStream = captured.stream;

    this._sharing = true;

    /* tell the peers BEFORE the media can arrive so their track routing
       knows the next video track is a screen */
    await this._broadcastSignal("m.call.screenshare", { active: true });

    const screenStream = this._screenStream;
    for (const entry of this._peers.values()) {
      for (const track of screenStream.getTracks()) {
        try {
          const sender = entry.pc.addTrack(track, screenStream);
          CallMedia.capScreenSender(sender);
          /* the share's frames encrypt too */
          if (this._mediaE2ee) {
            attachSenderTransform(
              sender,
              () => ({ keyId: this._mediaKeyId, key: this._mediaKey! }),
              () => {
                this._framesEncrypted++;
              }
            );
          }
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

  private async _acquireScreen(): Promise<{ stream: MediaStream } | null> {
    return this._media.acquireScreen();
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
    let droppedPeers = false;
    for (const key of [...this._peers.keys()]) {
      if (!present.has(key)) {
        this._closePeer(key);
        droppedPeers = true;
      }
    }
    /* a departed member's key must decrypt nothing going forward */
    if (droppedPeers) void this._rotateMediaKey();

    /* add new peers (own devices are skipped — v1 meshes distinct users) */
    for (const key of present) {
      if (this._peers.has(key)) continue;
      const [userId, deviceId] = key.split("|");
      if (userId === this.client.userId) continue;
      if (userId && deviceId) this._addPeer(userId, deviceId);
    }

    /* everyone else left: a DM call with nobody on the other side is
       over — leave after a short grace so a peer's state blip does
       not drop the call. Only when we actually SAW others in the call:
       a caller waiting alone for the callee to pick up must ring
       indefinitely. */
    const others = [...present].some((key) => key.split("|")[0] !== this.client.userId);
    if (others) this._sawOthersInCall = true;
    if (!others && this._peers.size === 0 && this._sawOthersInCall) {
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

  /* --------------------------- E2EE media keys --------------------------- */

  /** Send our current media-encryption key to one peer (olm channel). */
  private async _sendMediaKey(entry: PeerEntry): Promise<void> {
    if (!this._mediaE2ee || !this._mediaKeyBytes) return;
    await this._sendSignal(entry.userId, entry.deviceId, "m.call.media_key", {
      key_id: this._mediaKeyId,
      media_key: bytesToB64(this._mediaKeyBytes),
    });
  }

  /** A peer's media-encryption key arrived — install it for their
   *  inbound frames (a later key id supersedes earlier ones). */
  private async _handleMediaKey(
    entry: PeerEntry,
    content: Record<string, unknown>
  ): Promise<void> {
    const keyId = typeof content.key_id === "number" ? content.key_id : null;
    const b64 = typeof content.media_key === "string" ? content.media_key : null;
    if (keyId === null || !b64) return;
    const raw = b64ToBytes(b64);
    if (raw.length !== MEDIA_KEY_BYTES) return;
    const key = await importAesGcm(raw, ["decrypt"]);
    entry.remoteKeys.set(keyId, key);
  }

  /**
   * Rotate our media key (a peer left — their stale key must decrypt
   * nothing going forward) and tell the remaining peers the new one.
   */
  private async _rotateMediaKey(): Promise<void> {
    if (!this._mediaE2ee) return;
    this._mediaKeyBytes = randomBytes(MEDIA_KEY_BYTES);
    this._mediaKey = await importAesGcm(this._mediaKeyBytes, ["encrypt"]);
    this._mediaKeyId = (this._mediaKeyId + 1) & 0xff;
    for (const entry of this._peers.values()) {
      await this._sendMediaKey(entry);
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
      remoteKeys: new Map(),
    };
    this._peers.set(key, entry);

    /* E2EE media: send this peer our media key over the olm channel */
    if (this._mediaE2ee) {
      void this._sendMediaKey(entry);
    }

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
          CallMedia.capScreenSender(sender);
        } catch (err) {
          console.error("[call] addTrack(screen) failed:", err);
        }
      }
    }

    /* E2EE media: encrypt every outbound stream (after the tracks are
       added — transforms attach per sender) */
    if (this._mediaE2ee) {
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === "video") this._cameraTransforms.add(sender);
        attachSenderTransform(
          sender,
          () => ({ keyId: this._mediaKeyId, key: this._mediaKey! }),
          () => {
            this._framesEncrypted++;
          }
        );
      }
    }
    pc.ontrack = (event) => {
      /* E2EE media: decrypt this stream with the peer's sender keys */
      if (this._mediaE2ee) {
        attachReceiverTransform(
          event.receiver,
          () => entry.remoteKeys,
          (reason) => {
            this._framesDropped++;
          }
        );
      }
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
    } else if (type === "m.call.media_key") {
      void this._handleMediaKey(entry, content);
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
