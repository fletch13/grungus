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
import type { MatrixClient } from "./matrix-client.ts";
import { mxidLocalpart } from "./matrix-client.ts";

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
  async join(): Promise<void> {
    if (this._room) return;
    const roomId = this._roomId;
    const matrixRoom = roomId ? this.client.getRoom(roomId) : null;
    const service = matrixRoom?.livekitService;
    if (!service) throw new Error("No LiveKit service configured for this room");

    /* prove our Matrix identity to the token service — send BOTH the
       scoped OpenID token and (as fallback for services on homeservers
       with federation disabled) the session token; the service picks */
    let authBody: Record<string, unknown>;
    try {
      const openid = await this.client.requestOpenIdToken();
      authBody = {
        room: service.room,
        openid_token: openid.access_token,
        matrix_token: this.client.accessToken,
      };
    } catch {
      authBody = { room: service.room, matrix_token: this.client.accessToken };
    }
    const res = await fetch(service.authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authBody),
    });
    const data = (await res.json().catch(() => ({}))) as {
      token?: string;
      url?: string;
      error?: string;
    };
    if (!res.ok || !data.token || !data.url) {
      throw new Error(data.error ?? `token service refused (${res.status})`);
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

    const lk = new LkRoom({ adaptiveStream: true, dynacast: true });
    this._wireEvents(lk);
    this._room = lk;
    await lk.connect(data.url, data.token);
    for (const track of localTracks) {
      await lk.localParticipant.publishTrack(track, {
        /* keep the camera at a sensible simulcast base */
        source: track.kind === "video" ? Track.Source.Camera : Track.Source.Microphone,
        name: track.kind === "video" ? "camera" : "mic",
      });
    }
    this._emit();
  }

  async leave(): Promise<void> {
    const room = this._room;
    this._room = null;
    this._roomId = null;
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
