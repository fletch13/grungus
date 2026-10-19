/*
 * Grungus — 1:1 calls over the legacy room-event protocol (MSC2746) —
 * the protocol every Element client speaks in direct messages:
 *
 *   m.call.invite       {call_id, lifetime, party_id, version, offer}
 *   m.call.answer       {call_id, party_id, version, answer}
 *   m.call.select_answer{call_id, party_id, selected_party_id}
 *   m.call.candidates   {call_id, party_id, candidates}
 *   m.call.hangup       {call_id, party_id, version}
 *
 * All of them ride ordinary room events — megolm-encrypted in encrypted
 * rooms, exactly like Element's call events. party_id is the device id
 * (MSC2746); events from pre-2746 clients without one still work.
 *
 * Media is WebRTC DTLS-SRTP over a single peer connection. The
 * insertable-streams E2EE media layer is mesh-only (Element cannot
 * decrypt Grungus's v1 frame format), and screenshare needs mid-call
 * renegotiation the legacy protocol has no event for — both stay off
 * this path. Group rooms keep the MSC3401 mesh; LiveKit-focused calls
 * (Element Call) join through the SFU instead.
 */

import type { MatrixClient, MatrixEvent } from "./matrix-client.ts";
import { mxidLocalpart } from "./matrix-client.ts";
import type { CallParticipant, CallUiState } from "./calls.ts";
import { CallMedia } from "./call-media.ts";

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

/** How long our outgoing invite stays valid (Element uses 60s too). */
const INVITE_LIFETIME_MS = 60_000;

interface PendingInvite {
  roomId: string;
  callId: string;
  sender: string;
  senderPartyId: string | null;
  offer: { type: string; sdp: string };
  /** origin_server_ts of the invite event */
  ts: number;
  /** buffered ICE candidates that arrived before the remote description */
  candidates: RTCIceCandidateInit[];
}

export class P2PCallManager {
  private readonly client: MatrixClient;
  private readonly _media: CallMedia;
  private _uiListener: ((state: CallUiState) => void) | null = null;
  private _incomingListener: ((roomId: string, roomTitle: string) => void) | null =
    null;
  private _ringCancelListener: ((roomId: string) => void) | null = null;
  private _roomId: string | null = null;
  private _callId: string | null = null;
  private _role: "caller" | "callee" | null = null;
  private _pc: RTCPeerConnection | null = null;
  private _localStream: MediaStream | null = null;
  private _remoteStream: MediaStream | null = null;
  private _remoteUserId: string | null = null;
  private _remotePartyId: string | null = null;
  private _pendingCandidates: RTCIceCandidateInit[] = [];
  private _pendingInvite: PendingInvite | null = null;
  private _inviteTimer: ReturnType<typeof setTimeout> | null = null;
  private _notice: string | null = null;
  private _localMuted = false;

  constructor(client: MatrixClient) {
    this.client = client;
    this._media = new CallMedia(client.userId ?? "?");
  }

  get active(): boolean {
    return this._roomId !== null;
  }

  get roomId(): string | null {
    return this._roomId;
  }

  /** The room of a ringing, unanswered incoming call (for the Join button). */
  get pendingIncomingRoomId(): string | null {
    return this._pendingInvite ? this._pendingInvite.roomId : null;
  }

  setUiListener(listener: (state: CallUiState) => void): void {
    this._uiListener = listener;
    this._emit();
  }

  /** Fired when a fresh, unexpired invite arrives while we are idle. */
  setIncomingListener(listener: (roomId: string, roomTitle: string) => void): void {
    this._incomingListener = listener;
  }

  /** Fired when a ringing call was cancelled (the caller hung up). */
  setRingCancelListener(listener: (roomId: string) => void): void {
    this._ringCancelListener = listener;
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /** Start an outgoing 1:1 call: send m.call.invite and ring their side. */
  async start(roomId: string): Promise<void> {
    if (this._roomId !== null) return;
    this._roomId = roomId;
    this._role = "caller";
    this._callId = this._newCallId();

    const media = await this._media.acquire(false);
    this._localStream = media.stream;
    this._notice = media.synthetic
      ? "No microphone/camera available — using a synthetic stream"
      : null;

    const pc = this._createPeerConnection();
    this._pc = pc;
    for (const track of media.stream.getTracks()) {
      pc.addTrack(track, media.stream);
    }

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await this._sendCallEvent("m.call.invite", {
      call_id: this._callId,
      lifetime: INVITE_LIFETIME_MS,
      party_id: this.client.deviceId ?? undefined,
      version: "1",
      offer: { type: offer.type, sdp: offer.sdp },
    });

    /* give up (and tell the other side) when the invite lifetime passes */
    this._inviteTimer = setTimeout(() => {
      if (this._role === "caller" && this._pc && !this._pc.remoteDescription) {
        void this.hangUp().catch(() => {});
      }
    }, INVITE_LIFETIME_MS);

    this._emit();
  }

  /** Accept the ringing incoming call in the given room. */
  async answer(roomId: string): Promise<void> {
    const pending = this._pendingInvite;
    if (!pending || pending.roomId !== roomId) {
      throw new Error("No incoming call to answer in this room");
    }
    if (Date.now() - pending.ts > INVITE_LIFETIME_MS) {
      this._pendingInvite = null;
      throw new Error("The call already timed out");
    }
    this._pendingInvite = null;
    this._roomId = roomId;
    this._role = "callee";
    this._callId = pending.callId;
    this._remoteUserId = pending.sender;
    this._remotePartyId = pending.senderPartyId;

    const media = await this._media.acquire(false);
    this._localStream = media.stream;
    this._notice = media.synthetic
      ? "No microphone/camera available — using a synthetic stream"
      : null;

    const pc = this._createPeerConnection();
    this._pc = pc;
    for (const track of media.stream.getTracks()) {
      pc.addTrack(track, media.stream);
    }

    await pc.setRemoteDescription({
      type: pending.offer.type as RTCSdpType,
      sdp: pending.offer.sdp,
    });
    await this._flushPendingCandidates();
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this._sendCallEvent("m.call.answer", {
      call_id: this._callId,
      party_id: this.client.deviceId ?? undefined,
      version: "1",
      answer: { type: answer.type, sdp: answer.sdp },
    });
    this._emit();
  }

  async hangUp(): Promise<void> {
    if (this._roomId === null) return;
    await this._sendCallEvent("m.call.hangup", {
      call_id: this._callId ?? "",
      party_id: this.client.deviceId ?? undefined,
      version: "1",
    }).catch(() => {});
    this._teardown();
  }

  setMuted(muted: boolean): void {
    this._localMuted = muted;
    if (this._localStream) {
      for (const track of this._localStream.getAudioTracks()) track.enabled = !muted;
    }
    this._emit();
  }

  /* --------------------------- event handling ---------------------------- */

  /** Raw m.call.* room events (routed here via client.onCallEvent). */
  onCallEvent(roomId: string, ev: MatrixEvent): void {
    const content = (ev.content ?? {}) as Record<string, unknown>;
    const type = ev.type;
    const sender = ev.sender ?? "";
    const partyId = typeof content.party_id === "string" ? content.party_id : null;
    const callId = typeof content.call_id === "string" ? content.call_id : null;
    const ts = ev.origin_server_ts ?? Date.now();

    /* our own device's events (echoes) never loop back */
    if (sender === this.client.userId && partyId === this.client.deviceId) return;

    if (type === "m.call.invite") {
      this._handleInvite(roomId, ev, content, ts);
      return;
    }

    if (!callId) return;

    /* a hangup for the call we are RINGING on cancels the ring (the
       caller gave up before we answered) */
    if (
      type === "m.call.hangup" &&
      this._pendingInvite &&
      callId === this._pendingInvite.callId
    ) {
      this._pendingInvite = null;
      this._ringCancelListener?.(roomId);
      return;
    }

    if (callId !== this._callId) {
      /* events for other calls (other devices' conversations) are not
         ours to act on */
      return;
    }

    if (type === "m.call.answer") {
      this._handleAnswer(sender, partyId, content);
    } else if (type === "m.call.select_answer") {
      this._handleSelectAnswer(sender, content);
    } else if (type === "m.call.candidates") {
      this._handleCandidates(content);
    } else if (type === "m.call.hangup") {
      this._teardown();
    }
  }

  private _handleInvite(
    roomId: string,
    ev: MatrixEvent,
    content: Record<string, unknown>,
    ts: number
  ): void {
    const offer = content.offer as { type?: string; sdp?: string } | undefined;
    const lifetime = typeof content.lifetime === "number" ? content.lifetime : INVITE_LIFETIME_MS;
    if (!offer?.type || !offer.sdp) return;
    /* stale invite (the caller gave up before we saw it) */
    if (Date.now() - ts > lifetime) return;
    /* busy: an active call or another ringing call wins */
    if (this._roomId !== null) return;
    const callId = typeof content.call_id === "string" ? content.call_id : null;
    if (!callId) return;
    if (this._pendingInvite && this._pendingInvite.callId === callId) return;

    this._pendingInvite = {
      roomId,
      callId,
      sender: ev.sender ?? "",
      senderPartyId:
        typeof content.party_id === "string" ? content.party_id : null,
      offer: { type: offer.type, sdp: offer.sdp },
      ts,
      candidates: [],
    };
    const room = this.client.getRoom(roomId);
    this._incomingListener?.(roomId, room?.title ?? roomId);
  }

  private _handleAnswer(
    sender: string,
    partyId: string | null,
    content: Record<string, unknown>
  ): void {
    if (this._role !== "caller") return;
    const pc = this._pc;
    const answer = content.answer as { type?: string; sdp?: string } | undefined;
    if (!pc || !answer?.type || !answer.sdp) return;
    /* first answer wins; later answerers are released by select_answer */
    if (pc.remoteDescription) return;
    this._remoteUserId = sender;
    this._remotePartyId = partyId;
    void pc
      .setRemoteDescription({ type: answer.type as RTCSdpType, sdp: answer.sdp })
      .then(() => this._flushPendingCandidates())
      .then(() =>
        this._sendCallEvent("m.call.select_answer", {
          call_id: this._callId ?? "",
          party_id: this.client.deviceId ?? undefined,
          selected_party_id: partyId ?? undefined,
        })
      )
      .then(() => {
        if (this._inviteTimer) {
          clearTimeout(this._inviteTimer);
          this._inviteTimer = null;
        }
        this._emit();
      })
      .catch((err) => console.error("[p2p-call] answer failed:", err));
  }

  /** The caller picked another device's answer — stand down. */
  private _handleSelectAnswer(
    _sender: string,
    content: Record<string, unknown>
  ): void {
    if (this._role !== "callee") return;
    const selected = content.selected_party_id;
    if (selected != null && selected !== this.client.deviceId) {
      this._teardown();
    }
  }

  private _handleCandidates(content: Record<string, unknown>): void {
    const raw = content.candidates;
    if (!Array.isArray(raw)) return;
    const candidates = raw as RTCIceCandidateInit[];
    const pc = this._pc;
    if (!pc) {
      /* candidates may precede our answer — keep them for the pc */
      if (this._pendingInvite) this._pendingInvite.candidates.push(...candidates);
      return;
    }
    for (const candidate of candidates) {
      if (pc.remoteDescription) {
        void pc.addIceCandidate(candidate).catch(() => {
          /* stale candidate — the renegotiation-free protocol can
             just drop it */
        });
      } else {
        this._pendingCandidates.push(candidate);
      }
    }
  }

  /* ------------------------------ plumbing ------------------------------- */

  private _createPeerConnection(): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        void this._sendCallEvent("m.call.candidates", {
          call_id: this._callId ?? "",
          party_id: this.client.deviceId ?? undefined,
          candidates: [event.candidate.toJSON()],
        }).catch(() => {});
      }
    };
    pc.ontrack = (event) => {
      if (!this._remoteStream) this._remoteStream = new MediaStream();
      for (const stream of event.streams) {
        for (const track of stream.getTracks()) this._remoteStream.addTrack(track);
      }
      if (this._remoteStream.getTracks().length === 0 && event.track) {
        this._remoteStream.addTrack(event.track);
      }
      this._emit();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        void pc.restartIce();
      }
      this._emit();
    };
    return pc;
  }

  private async _flushPendingCandidates(): Promise<void> {
    const pc = this._pc;
    if (!pc) return;
    const pending = this._pendingCandidates.splice(0, this._pendingCandidates.length);
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* stale candidate */
      }
    }
  }

  private _sendCallEvent(
    type: string,
    content: Record<string, unknown>
  ): Promise<string | null> {
    if (!this._roomId) return Promise.resolve(null);
    return this.client.sendRoomEvent(this._roomId, type, content);
  }

  private _newCallId(): string {
    return crypto.randomUUID();
  }

  private _teardown(): void {
    if (this._inviteTimer) {
      clearTimeout(this._inviteTimer);
      this._inviteTimer = null;
    }
    if (this._pc) {
      try {
        this._pc.close();
      } catch {
        /* already closed */
      }
      this._pc = null;
    }
    if (this._localStream) {
      for (const track of this._localStream.getTracks()) track.stop();
      this._localStream = null;
    }
    this._media.stop();
    this._remoteStream = null;
    this._remoteUserId = null;
    this._remotePartyId = null;
    this._pendingCandidates = [];
    this._pendingInvite = null;
    this._roomId = null;
    this._callId = null;
    this._role = null;
    this._notice = null;
    this._localMuted = false;
    this._emit();
  }

  /* --------------------------------- UI ---------------------------------- */

  get localStream(): MediaStream | null {
    return this._localStream;
  }

  get localScreenStream(): MediaStream | null {
    return null;
  }

  /** Screenshare needs mid-call renegotiation the legacy protocol lacks. */
  startScreenshare(): void {
    this._notice = "Screenshare isn't available in 1:1 calls yet";
    this._emit();
  }

  stopScreenshare(): void {
    if (this._notice === "Screenshare isn't available in 1:1 calls yet") {
      this._notice = null;
      this._emit();
    }
  }

  private _emit(): void {
    if (!this._uiListener) return;
    const participants: CallParticipant[] = [];
    const me = this.client.userId ?? "?";
    if (this._roomId) {
      participants.push({
        key: `local|${this.client.deviceId ?? ""}`,
        userId: me,
        deviceId: this.client.deviceId ?? "",
        name: "You",
        stream: this._localStream,
        screenStream: null,
        sharing: false,
        connectionState: "connected",
      });
      if (this._remoteStream) {
        const room = this.client.getRoom(this._roomId);
        const member = this._remoteUserId
          ? room?.members.get(this._remoteUserId)
          : undefined;
        participants.push({
          key: `${this._remoteUserId}|${this._remotePartyId ?? ""}`,
          userId: this._remoteUserId ?? "",
          deviceId: this._remotePartyId ?? "",
          name:
            member?.displayname ??
            (this._remoteUserId ? mxidLocalpart(this._remoteUserId) : "?"),
          stream: this._remoteStream,
          screenStream: null,
          sharing: false,
          connectionState: this._pc?.connectionState ?? "connecting",
        });
      }
    }
    this._uiListener({
      active: this._roomId !== null,
      roomId: this._roomId,
      participants,
      notice: this._notice,
      localMuted: this._localMuted,
      localSharing: false,
      localKey: me,
    });
  }
}
