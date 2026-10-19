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
 * Media falls back to synthetic canvas/oscillator streams on hosts
 * without capture devices (headless/CI), so the whole SFU pipeline
 * stays verifiable — same pattern as the mesh calls.
 */
import {
  Room as LkRoom,
  RoomEvent,
  RemoteParticipant,
  RemoteTrack,
  RemoteTrackPublication,
  LocalVideoTrack,
  Track,
  VideoPresets,
  createLocalTracks,
  type LocalTrack,
} from "livekit-client";
import type { Room } from "./matrix-client.ts";
import type { MatrixClient } from "./matrix-client.ts";
import { mxidLocalpart } from "./matrix-client.ts";
import { LkE2ee } from "./lk-e2ee.ts";

export interface LkCallState {
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
  /** synthetic media kept alive across the call */
  private _syntheticCanvas: HTMLCanvasElement | null = null;
  private _syntheticTimer: ReturnType<typeof setInterval> | null = null;
  private _audioCtx: AudioContext | null = null;

  constructor(client: MatrixClient) {
    this.client = client;
  }

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
   * Discover the LiveKit service for a MatrixRTC call (Element Call
   * interop). Returns null when the room has no active memberships
   * with a LiveKit focus. The focus URL points at the MatrixRTC
   * authorization service (lk-jwt-service — the same pattern as
   * Grungus's own livekit/auth-service.ts, which returns the SFU url
   * together with the token); the LiveKit room for a MatrixRTC call is
   * the MATRIX ROOM ID (every client in the room gets a token scoped
   * to the same LiveKit room).
   */
  private async _discoverMatrixRtcFocus(
    matrixRoom: Room,
    roomId: string
  ): Promise<{ room: string; authUrl: string } | null> {
    const focusUrl = matrixRoom.rtcMemberships.find((m) => m.focusUrl)?.focusUrl ?? null;
    if (!focusUrl) return null;
    return { room: roomId, authUrl: focusUrl };
  }

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

  async join(): Promise<void> {
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
      const focus = await this._discoverMatrixRtcFocus(matrixRoom, roomId ?? "");
      if (focus) {
        lkRoom = focus.room;
        authUrl = focus.authUrl;
        matrixRtc = true;
      }
    }
    /* the SFU url comes with the token from the auth service */
    if (!lkRoom || !authUrl) {
      throw new Error("No LiveKit service configured for this room");
    }
    this._matrixRtc = matrixRtc;

    /* prove our Matrix identity to the token service — send BOTH the
       scoped OpenID token and (as fallback for services on homeservers
       with federation disabled) the session token; the service picks */
    let authBody: Record<string, unknown>;
    try {
      const openid = await this.client.requestOpenIdToken();
      authBody = {
        room: lkRoom,
        room_id: lkRoom,
        openid_token: openid.access_token,
        matrix_token: this.client.accessToken,
      };
    } catch {
      authBody = { room: lkRoom, room_id: lkRoom, matrix_token: this.client.accessToken };
    }
    /* A MatrixRTC focus (Element Call) points at the SERVICE ROOT — the
       token endpoint lives at a known sub-path. Grungus's own
       com.grungus.livekit auth_url IS the endpoint already. Try the
       focus sub-paths first, then the bare URL. */
    const endpoints = matrixRtc
      ? [
          `${authUrl.replace(/\/$/, "")}/session/get_token`,
          `${authUrl.replace(/\/$/, "")}/sfu/get`,
          `${authUrl.replace(/\/$/, "")}/get_token`,
          authUrl,
        ]
      : [authUrl];
    let data: { token?: string; jwt?: string; url?: string; error?: string } = {};
    let resStatus = 0;
    let lastError = "token service unreachable";
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(authBody),
        });
        resStatus = res.status;
        data = (await res.json().catch(() => ({}))) as {
          token?: string;
          jwt?: string;
          url?: string;
          error?: string;
        };
        /* element-call's legacy /sfu/get answers {url, jwt} */
        const token = data.token ?? data.jwt;
        if (res.ok && token && data.url) {
          data.token = token;
          lastError = "";
          break;
        }
        lastError = data.error ?? `token service refused (${res.status})`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : "network error";
      }
    }
    if (!data.token || !data.url) {
      throw new Error(lastError || `token service refused (${resStatus})`);
    }

    /* publish local media first (synthetic fallback on headless hosts) */
    let localTracks;
    try {
      localTracks = await createLocalTracks({
        audio: true,
        video: { resolution: VideoPresets.h720.resolution },
      });
    } catch (err) {
      console.warn("[lk-call] capture failed, using synthetic media:", err);
      localTracks = await this._syntheticTracks();
      this._notice = "No microphone/camera available — using a synthetic stream";
    }

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
    await lk.connect(data.url, data.token);
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
    if (this._syntheticTimer) {
      clearInterval(this._syntheticTimer);
      this._syntheticTimer = null;
    }
    this._syntheticCanvas = null;
    if (this._audioCtx) {
      void this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
    }
    this._notice = null;
    this._localMuted = false;
    this._emit();
  }

  setRoomId(roomId: string): void {
    this._roomId = roomId;
  }

  setMuted(muted: boolean): void {
    this._localMuted = muted;
    const mic = this._room?.localParticipant.getTrackPublication(Track.Source.Microphone);
    const raw = (mic?.track as unknown as { mediaStreamTrack?: MediaStreamTrack } | undefined)
      ?.mediaStreamTrack;
    if (raw) raw.enabled = !muted;
    this._emit();
  }

  /** Screen share through the SFU (synthetic fallback on headless hosts). */
  async setSharing(enabled: boolean): Promise<void> {
    const room = this._room;
    if (!room) return;
    try {
      if (enabled) {
        const hasCapture =
          typeof navigator !== "undefined" &&
          typeof navigator.mediaDevices?.getDisplayMedia === "function";
        if (hasCapture) {
          await room.localParticipant.setScreenShareEnabled(true, {
            audio: false,
            contentHint: "detail",
          });
        } else {
          /* synthetic screen through the SFU keeps the pipeline verifiable */
          const screen = this._syntheticScreen();
          const rawTrack = screen.getVideoTracks()[0];
          if (rawTrack) {
            const track = new LocalVideoTrack(rawTrack as unknown as MediaStreamTrack);
            await room.localParticipant.publishTrack(track, {
              source: Track.Source.ScreenShare,
              name: "screen",
            });
          }
          this._notice = "No display capture available — sharing a synthetic screen";
        }
      } else {
        await room.localParticipant.setScreenShareEnabled(false);
        if (this._notice && this._notice.includes("synthetic screen")) {
          this._notice = null;
        }
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
    lk.on(RoomEvent.TrackSubscribed, () => this._emit());
    lk.on(RoomEvent.TrackUnsubscribed, () => this._emit());
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
    let stream: MediaStream | null = null;
    let screenStream: MediaStream | null = null;
    let sharing = false;
    for (const pub of participant.trackPublications.values()) {
      const remotePub = pub as RemoteTrackPublication;
      const track = remotePub.track;
      if (!track || remotePub.isSubscribed === false || track.kind !== "video") continue;
      /* livekit's remote track wraps the underlying MediaStreamTrack */
      const raw = (track as unknown as { mediaStreamTrack?: MediaStreamTrack })
        .mediaStreamTrack ?? (track as unknown as MediaStreamTrack);
      const ms = new MediaStream([raw]);
      if (remotePub.source === Track.Source.ScreenShare) {
        sharing = true;
        screenStream = ms;
      } else {
        stream = ms;
      }
    }
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
      participants,
      notice: this._notice,
      localMuted: this._localMuted,
      localSharing: this.localSharing,
    });
  }

  /* ---------------------------- synthetic media --------------------------- */

  private _syntheticTracks(): Promise<MediaStreamTrack[]> {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    this._syntheticCanvas = canvas;
    const ctx = canvas.getContext("2d")!;
    let tick = 0;
    const draw = (): void => {
      tick = (tick + 1) % 320;
      ctx.fillStyle = "#5865f2";
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = "#ffffff";
      ctx.font = "16px monospace";
      ctx.fillText("grungus sfu cam", 12, 30);
      ctx.fillRect(tick, 120, 20, 40);
    };
    draw();
    this._syntheticTimer = setInterval(draw, 100);
    const videoStream = canvas.captureStream(15) as MediaStream;

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

    return Promise.resolve([
      ...videoStream.getVideoTracks(),
      ...dest.stream.getAudioTracks(),
    ]);
  }

  private _syntheticScreen(): MediaStream {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d")!;
    let tick = 0;
    const draw = (): void => {
      tick += 1;
      ctx.fillStyle = "#101319";
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = "#7ee787";
      ctx.font = "18px monospace";
      const lines = [
        "GRUNGUS — synthetic screen (via SFU)",
        "",
        "$ grungus --livekit",
        "frame " + tick,
        "",
        "[ok] simulcast: publisher sends once, SFU fans out",
      ];
      lines.forEach((line, i) => ctx.fillText(line, 16, 40 + i * 26));
    };
    draw();
    this._syntheticTimer = setInterval(draw, 100);
    return canvas.captureStream(10) as MediaStream;
  }
}
