import { discoverCallService, requestCallToken } from "./matrix-call-service.ts";
/*
 * Grungus — LiveKit calls (SFU).
 *
 * When a room has a `com.grungus.livekit` state event ({url, room,
 * auth_url}), calls join through the LiveKit SFU instead of the mesh:
 * the bandwidth ceiling of full-mesh screensharing is gone (the SFU does
 * simulcast; each receiver gets an appropriate layer).
 *
 * Identity flow (Element lk-jwt-service pattern): the client proves its
 * Matrix identity to the auth service with an OpenID token (or, on
 * homeservers with federation disabled, its access token) and receives a
 * short-lived LiveKit access token — the API secret never leaves the
 * service.
 *
 * Calls use real devices only and enter with the camera off.
 */
import {
  Room as LkRoom,
  RoomEvent,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  Track,
  createLocalTracks,
  type LocalTrack,
} from "livekit-client";
import type { Room } from "./matrix-client.ts";
import type { MatrixClient } from "./matrix-client.ts";
import { mxidLocalpart } from "./matrix-client.ts";
import { LkE2ee } from "./lk-e2ee.ts";
import { SettingsStore } from "./settings.ts";

export interface LkCallState {
  localSpeaking: boolean;
  connected: boolean;
  participants: {
    identity: string;
    name: string;
    stream: MediaStream | null;
    screenStream: MediaStream | null;
    sharing: boolean;
    speaking: boolean;
  }[];
  notice: string | null;
  localMuted: boolean;
  localSharing: boolean;
}

export class LkCallManager {
  private readonly client: MatrixClient;
  private _room: LkRoom | null = null;
  /** LiveKit-path E2EE (encrypted rooms only; keys via Matrix, Element-compatible) */
  private _e2ee: LkE2ee | null = null;
  private _listener: ((state: LkCallState) => void) | null = null;
  private _notice: string | null = null;
  private _localMuted = false;
  private _roomId: string | null = null;


  constructor(client: MatrixClient) {
    this.client = client;
  }

  get roomId(): string | null { return this._roomId; }

  get connected(): boolean {
    return this._room !== null && this._room.state === "connected";
  }

  setListener(listener: (state: LkCallState) => void): void {
    this._listener = listener;
    this._emit();
  }

  /** Join the room's LiveKit call (state event must be present). */
  /** true when the current call goes through MatrixRTC signaling. */
  private _matrixRtc = false;
  /** call-state heartbeat (keeps the membership expiry fresh) */
  private _memberHeartbeat: ReturnType<typeof setInterval> | null = null;

  /**
   * Publish our MatrixRTC membership (Element Call format): an
   * m.call.member state event per device, state_key =
   * `${userId}_${deviceId}_m.call` (MSC4143), session content with
   * focus_active pointing at the auth service. Element Call (and any
   * MatrixRTC client) then sees us in the call and can join the same
   * LiveKit room.
   *
   * Some servers (this conduwuit build) only authorize the LEGACY
   * per-user state key — on rejection we fall back to the legacy
   * m.calls format (which every MatrixRTC client can parse).
   */
  private async _publishRtcMembership(roomId: string, authUrl: string): Promise<void> {
    const userId = this.client.userId ?? "";
    const deviceId = this.client.deviceId ?? "";
    const now = Date.now();
    const sessionContent = {
      application: "m.call",
      call_id: "",
      scope: "m.room",
      device_id: deviceId,
      expires: 5 * 60_000,
      /* focus_active in BOTH shapes: the current flattened { type,
         livekit_service_url } (what element-call's parser requires) and
         the original { active_focus } for older MSC4143 clients */
      focus_active: {
        type: "livekit",
        focus_selection: "oldest_membership",
        livekit_service_url: authUrl,
        active_focus: { focus: "livekit", livekit_service_url: authUrl },
        joined_ts: now,
      },
      /* the transport current MatrixRTC clients (element-call, rust) read:
         UnstableLivekitTransport = { type: "livekit", livekit_service_url }.
         `focus` stays for older focus-shape parsers. */
      foci_preferred: [{ type: "livekit", focus: "livekit", livekit_service_url: authUrl }],
      created_ts: now,
    };
    /* MSC4143 per-device state key. Room versions before MSC3779 prefix it
       with "_" — which is also what conduwuit's auth rules accept (the
       unprefixed form is 403 on old-version rooms). */
    const perDeviceKey = `_${userId}_${deviceId}_m.call`;
    try {
      /* the UNSTABLE event type: element-call's parser strictly checks
         org.matrix.msc3401.call.member (our own parser accepts both) */
      await this.client.sendStateEvent(
        roomId,
        "org.matrix.msc3401.call.member",
        perDeviceKey,
        sessionContent
      );
      return;
    } catch {
      /* server auth rules or power levels reject per-device state keys —
         legacy per-user format */
    }
    const legacyContent = this._mergeLegacyMembership(roomId, deviceId, authUrl);
    await this.client.sendStateEvent(roomId, "m.call.member", userId, legacyContent);
  }

  /**
   * Build the legacy per-user membership content, MERGING our device
   * into the existing m.calls (the state key is shared between devices
   * of the same user — a blind overwrite would clobber them).
   */
  private _mergeLegacyMembership(
    roomId: string,
    deviceId: string,
    authUrl: string
  ): Record<string, unknown> {
    const existing = this.client.getRoom(roomId)?.callMembers.get(this.client.userId ?? "") as
      | { "m.calls"?: { "m.call_id"?: string; "m.devices"?: Record<string, unknown>[] }[] }
      | undefined;
    const now = Date.now();
    const devices = (existing?.["m.calls"]?.[0]?.["m.devices"] ?? []).filter(
      (d) => d.device_id !== deviceId
    );
    devices.push({
      device_id: deviceId,
      expires_ts: now + 5 * 60_000,
      foci_active: [
        /* both shapes: `type` for the current transport parsers,
           `focus` for the legacy focus format */
        { type: "livekit", focus: "livekit", livekit_service_url: authUrl },
      ],
    });
    return {
      "m.calls": [
        {
          "m.call_id": existing?.["m.calls"]?.[0]?.["m.call_id"] ?? "",
          "m.devices": devices,
        },
      ],
    };
  }

  /** Clear our call membership (empty content = left). Tries the
   *  per-device state key, then filters our device out of the legacy
   *  per-user entry (other devices of ours may still be in the call). */
  private async _clearRtcMembership(roomId: string): Promise<void> {
    const userId = this.client.userId ?? "";
    const deviceId = this.client.deviceId ?? "";
    try {
      await this.client.sendStateEvent(roomId, "m.call.member", `${userId}_${deviceId}_m.call`, {});
      return;
    } catch {
      /* per-device state keys not authorized on this server */
    }
    /* legacy: keep the OTHER devices of ours, drop only this one */
    const existing = this.client.getRoom(roomId)?.callMembers.get(userId) as
      | { "m.calls"?: { "m.call_id"?: string; "m.devices"?: Record<string, unknown>[] }[] }
      | undefined;
    const devices = (existing?.["m.calls"]?.[0]?.["m.devices"] ?? []).filter(
      (d) => d.device_id !== deviceId
    );
    const content = devices.length
      ? {
          "m.calls": [
            {
              "m.call_id": existing?.["m.calls"]?.[0]?.["m.call_id"] ?? "",
              "m.devices": devices,
            },
          ],
        }
      : { "m.calls": [] };
    await this.client.sendStateEvent(roomId, "m.call.member", userId, content).catch(() => {});
  }

  async join(discoveredService?: string): Promise<void> {
    if (this._room) return;
    const roomId = this._roomId;
    const matrixRoom = roomId ? this.client.getRoom(roomId) : null;

    /* LiveKit service discovery, in order:
       1. this room's com.grungus.livekit state (the Grungus deployment)
       2. an active MatrixRTC membership's focus (Element Call interop —
          join the call Element Call or any MatrixRTC client started)
       3. the homeserver's MSC4143 transports endpoint (Synapse's
          matrix_rtc config; conduwuit does not serve it) */
    const service = matrixRoom?.livekitService ?? null;
    let lkRoom = service?.room ?? null;
    let authUrl = service?.authUrl ?? null;
    let matrixRtc = false;

    if (!service && matrixRoom) {
      const focus = discoveredService ?? await discoverCallService(this.client, matrixRoom);
      if (focus) {
        lkRoom = roomId;
        authUrl = focus;
        matrixRtc = true;
      }
    }
    /* the SFU url comes with the token from the auth service */
    if (!lkRoom || !authUrl) {
      throw new Error("No LiveKit service configured for this room");
    }
    this._matrixRtc = matrixRtc;

    let data: { token: string; url: string };
    if (matrixRtc) data = await requestCallToken(this.client, roomId!, authUrl);
    else {
      const proof = service?.authMode === "whoami"
        ? { matrix_token: this.client.accessToken }
        : { openid_token: (await this.client.requestOpenIdToken()).access_token };
      const response = await fetch(authUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: lkRoom, room_id: roomId, ...proof }),
        signal: AbortSignal.timeout(12000), redirect: "error",
      });
      const result = await response.json() as { token?: string; jwt?: string; url?: string; error?: string };
      const token = result.token ?? result.jwt;
      if (!response.ok || !token || !result.url) throw new Error(result.error || `Call authorization failed (${response.status})`);
      data = { token, url: result.url };
    }

    const prefs = new SettingsStore();
    const audioInput = prefs.get("audioInput");
    const localTracks = await createLocalTracks({
      audio: audioInput ? { deviceId: { ideal: audioInput } } : true,
      video: false,
    });

    /* LiveKit-path E2EE: encrypted rooms only. Element-compatible —
       livekit's own e2ee worker + per-participant keys over Matrix
       (io.element.call.encryption_keys room events), so Grungus and
       Element Call clients interop inside one encrypted call. */
    if (matrixRoom?.isEncrypted && this.client.crypto && this.client.userId) {
      try {
        this._e2ee = await LkE2ee.create({
          client: this.client,
          roomId: roomId ?? "",
          identity: this.client.userId,
          participantIdentity: matrixRtc ? `${this.client.userId}:${this.client.deviceId}` : this.client.userId,
          deviceId: this.client.deviceId,
        });
      } catch (err) {
        console.warn("[lk-call] E2EE setup failed (call stays plaintext):", err);
        this._e2ee = null;
      }
    }

    const lk = new LkRoom({
      adaptiveStream: true,
      dynacast: true,
      ...(this._e2ee ? { e2ee: this._e2ee.options } : {}),
    });
    this._wireEvents(lk);
    this._room = lk;
    try {
    await lk.connect(data.url, data.token);
    /* the Voice & Video speaker pick routes all incoming audio ("" =
       system default; unsupported platforms just keep the default) */
    const speaker = new SettingsStore().get("audioOutput");
    if (speaker) {
      await lk.switchActiveDevice("audiooutput", speaker).catch((err: unknown) =>
        console.warn("[lk-call] speaker switch failed:", err)
      );
    }
    if (this._e2ee) {
      /* flip every sender/receiver transform on; the keys we distributed
         (and keep resending) do the rest */
      await lk.setE2EEEnabled(true).catch((err: unknown) =>
        console.warn("[lk-call] setE2EEEnabled failed:", err)
      );
      this._e2ee.start();
      this._notice = (this._notice ? this._notice + " · " : "") + "🔒 E2EE media";
    }
    for (const track of localTracks) {
      await lk.localParticipant.publishTrack(track, {
        /* keep the camera at a sensible simulcast base */
        source: track.kind === "video" ? Track.Source.Camera : Track.Source.Microphone,
        name: track.kind === "video" ? "camera" : "mic",
      });
    }
    /* publish our call membership so others see the ongoing call and
       get the incoming-call ring — MatrixRTC members (Element Call)
       and mesh-style clients (callOngoing) both read it */
    await this._publishRtcMembership(roomId ?? "", authUrl).catch((err) =>
      console.warn("[lk-call] call membership publish failed:", err)
    );
    /* heartbeat: keep the membership's expiry fresh while connected
       (a crash stops the beats and the state self-heals) */
    this._memberHeartbeat = setInterval(() => {
      void this._publishRtcMembership(roomId ?? "", authUrl).catch(() => {});
    }, 2 * 60_000);
    this._emit();
    } catch (error) {
      for (const track of localTracks) track.stop();
      await this.leave();
      throw error;
    }
  }

  async leave(): Promise<void> {
    const room = this._room;
    const leftRoomId = this._roomId;
    if (this._memberHeartbeat) {
      clearInterval(this._memberHeartbeat);
      this._memberHeartbeat = null;
    }
    this._e2ee?.stop();
    this._e2ee = null;
    this._room = null;
    this._roomId = null;
    this._matrixRtc = false;
    /* clear our call membership (everyone else then sees us leave) */
    if (leftRoomId) {
      await this._clearRtcMembership(leftRoomId);
    }
    try {
      room?.disconnect();
    } catch {
      /* already gone */
    }
    this._notice = null;
    this._localMuted = false;
    this._emit();
  }

  setRoomId(roomId: string): void {
    this._roomId = roomId;
  }

  get localCameraEnabled(): boolean { return this._room?.localParticipant.isCameraEnabled ?? false; }
  get localStream(): MediaStream | null {
    const tracks = [...(this._room?.localParticipant.trackPublications.values() ?? [])]
      .filter(publication => publication.source === Track.Source.Camera || publication.source === Track.Source.Microphone)
      .flatMap(publication => publication.track ? [publication.track.mediaStreamTrack] : []);
    return tracks.length ? new MediaStream(tracks) : null;
  }
  async setCameraEnabled(enabled: boolean): Promise<void> {
    if (!this._room) throw new Error("No active call");
    const prefs = new SettingsStore();
    await this._room.localParticipant.setCameraEnabled(enabled, { deviceId: prefs.get("videoInput") || undefined });
    this._emit();
  }

  async switchAudioInput(deviceId: string): Promise<void> {
    if (!this._room) throw new Error("No active call");
    const switched = await this._room.switchActiveDevice("audioinput", deviceId || "default");
    if (!switched) throw new Error("Could not switch microphone");
  }

  async switchAudioOutput(deviceId: string): Promise<void> {
    if (!this._room) throw new Error("No active call");
    const switched = await this._room.switchActiveDevice("audiooutput", deviceId || "default");
    if (!switched) throw new Error("Could not switch speaker");
  }

  setMuted(muted: boolean): void {
    this._localMuted = muted;
    const mic = this._room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const raw = (mic?.track as unknown as { mediaStreamTrack?: MediaStreamTrack } | undefined)
      ?.mediaStreamTrack;
    if (raw) raw.enabled = !muted;
    this._emit();
  }

  /** Route incoming audio to a different speaker mid-call ("" = default). */
  setAudioOutput(sinkId: string): void {
    if (!this._room) return;
    void this._room
      .switchActiveDevice("audiooutput", sinkId)
      .catch((err: unknown) => console.warn("[lk-call] speaker switch failed:", err));
  }

  /** Share a real display through the SFU. */
  async setSharing(enabled: boolean): Promise<void> {
    const room = this._room;
    if (!room) return;
    try {
      if (enabled) {
        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) throw new Error("Screen capture is unavailable");
        await room.localParticipant.setScreenShareEnabled(true, { audio: true, contentHint: "detail" });
      } else {
        await room.localParticipant.setScreenShareEnabled(false);

      }
    } catch (err) {
      console.error("[lk-call] screenshare failed:", err);
      this._notice = `Screenshare failed: ${err instanceof Error ? err.message : "unknown"}`;
    }
    this._emit();
  }

  get localSharing(): boolean {
    return this._room?.localParticipant.isScreenShareEnabled ?? false;
  }

  /* ------------------------------- events -------------------------------- */

  private _wireEvents(lk: LkRoom): void {
    lk.on(RoomEvent.ActiveSpeakersChanged, () => this._emit());
    lk.on(RoomEvent.TrackSubscribed, () => this._emit());
    lk.on(RoomEvent.TrackUnsubscribed, () => this._emit());
    lk.on(RoomEvent.TrackMuted, () => this._emit());
    lk.on(RoomEvent.TrackUnmuted, () => this._emit());
    lk.on(RoomEvent.LocalTrackPublished, () => this._emit());
    lk.on(RoomEvent.LocalTrackUnpublished, () => this._emit());
    lk.on(RoomEvent.ParticipantConnected, () => this._emit());
    lk.on(RoomEvent.ParticipantDisconnected, () => this._emit());
    lk.on(RoomEvent.Disconnected, () => {
      this._room = null;
      this._emit();
    });
  }

  private _remoteStreams(participant: RemoteParticipant): {
    stream: MediaStream | null;
    screenStream: MediaStream | null;
    sharing: boolean;
  } {
    const media: MediaStreamTrack[] = [];
    const screen: MediaStreamTrack[] = [];
    for (const pub of participant.trackPublications.values()) {
      const remotePub = pub as RemoteTrackPublication;
      const track = remotePub.track;
      if (!track || remotePub.isSubscribed === false || (track.kind === "video" && remotePub.isMuted)) continue;
      if (remotePub.source === Track.Source.ScreenShare || remotePub.source === Track.Source.ScreenShareAudio) screen.push(track.mediaStreamTrack);
      else media.push(track.mediaStreamTrack);
    }
    const stream = media.length ? new MediaStream(media) : null;
    const screenStream = screen.length ? new MediaStream(screen) : null;
    const sharing = screen.some(track => track.kind === "video");
    return { stream, screenStream, sharing };
  }

  private _emit(): void {
    if (!this._listener) return;
    const participants: LkCallState["participants"] = [];
    const room = this._room;
    if (room) {
      for (const participant of room.remoteParticipants.values()) {
        const { stream, screenStream, sharing } = this._remoteStreams(participant);
        participants.push({
          identity: participant.identity,
          name: participant.name || mxidLocalpart(participant.identity),
          stream,
          screenStream,
          sharing,
          speaking: participant.isSpeaking,
        });
      }
    }
    this._listener({
      connected: this.connected,
      localSpeaking: !this._localMuted && (room?.localParticipant.isSpeaking ?? false),
      participants,
      notice: this._notice,
      localMuted: this._localMuted,
      localSharing: this.localSharing,
    });
  }

}
