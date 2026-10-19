/*
 * Grungus — shared call media acquisition (real capture with a synthetic
 * fallback), used by the mesh CallManager and the 1:1 P2PCallManager.
 *
 * The synthetic stream is an animated canvas (a known color per user with
 * a moving bar so frames keep flowing) plus a quiet oscillator audio
 * track. It produces REAL RTP media, so the full WebRTC path stays
 * verifiable on hosts with no capture devices (headless, CI).
 */
import { colorFor } from "../color.ts";
import { SettingsStore } from "./settings.ts";

export interface AcquiredMedia {
  stream: MediaStream;
  /** true when the stream is synthetic (no capture devices existed) */
  synthetic: boolean;
}

/* screen encoding caps — bandwidth discipline: screens tolerate low
   fps, text stays sharp; ~1.5 Mbps instead of camera defaults */
const SCREEN_MAX_BITRATE = 1_500_000;
const SCREEN_MAX_FPS = 10;

/**
 * True when an SDP offer/answer carries an ACTIVE video m-line (port
 * non-zero) — the callee answers with camera only when the caller
 * offered one. Pure — unit-tested.
 */
export function offerHasVideo(sdp: string): boolean {
  return /^m=video [1-9]/m.test(sdp);
}

/**
 * getUserMedia constraints honoring the persisted device picks
 * ("" = system default). `ideal` (not `exact`) so an unplugged device
 * falls back to the system default instead of failing the call.
 * Pure — unit-tested.
 */
export function mediaConstraints(
  video: boolean,
  devices: { audioInput: string; videoInput: string }
): MediaStreamConstraints {
  return {
    audio: devices.audioInput
      ? { deviceId: { ideal: devices.audioInput } }
      : true,
    video: video
      ? devices.videoInput
        ? { deviceId: { ideal: devices.videoInput } }
        : true
      : false,
  };
}

export class CallMedia {
  private readonly _userId: string;
  private _canvas: HTMLCanvasElement | null = null;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _audioCtx: AudioContext | null = null;
  private _screenCanvas: HTMLCanvasElement | null = null;
  private _screenTimer: ReturnType<typeof setInterval> | null = null;

  constructor(userId: string) {
    this._userId = userId;
  }

  async acquire(video: boolean): Promise<AcquiredMedia> {
    try {
      if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
        /* the settings' Voice & Video picks: microphone and camera */
        const prefs = new SettingsStore();
        const stream = await navigator.mediaDevices.getUserMedia(
          mediaConstraints(video, {
            audioInput: prefs.get("audioInput"),
            videoInput: prefs.get("videoInput"),
          })
        );
        return { stream, synthetic: false };
      }
    } catch (err) {
      console.warn("[call] getUserMedia failed, falling back to synthetic:", err);
    }
    return { stream: this._syntheticStream(), synthetic: true };
  }

  private _syntheticStream(): MediaStream {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    this._canvas = canvas;

    const ctx = canvas.getContext("2d")!;
    const base = colorFor(this._userId);
    let tick = 0;
    const draw = (): void => {
      tick = (tick + 1) % 320;
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, 320, 240);
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(tick, 100, 20, 40);
    };
    draw();
    this._timer = setInterval(draw, 100);

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
    if (!this._canvas) return null;
    const ctx = this._canvas.getContext("2d")!;
    const data = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
  }

  /* ------------------------------- screen -------------------------------- */

  /** Capture the screen for sharing (synthetic fallback on headless hosts). */
  async acquireScreen(): Promise<AcquiredMedia> {
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
    this._screenCanvas = canvas;
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
        "[ok] screen track flowing (10 fps cap)",
      ];
      lines.forEach((line, i) => ctx.fillText(line, 16, 40 + i * 26));
    };
    draw();
    this._screenTimer = setInterval(draw, 100);
    const stream = canvas.captureStream(SCREEN_MAX_FPS) as MediaStream;
    for (const track of stream.getVideoTracks()) {
      if (typeof track.contentHint === "string") track.contentHint = "text";
    }
    return stream;
  }

  /** Stop the synthetic screen machinery (the caller stops real tracks). */
  stopScreen(): void {
    if (this._screenTimer) {
      clearInterval(this._screenTimer);
      this._screenTimer = null;
    }
    this._screenCanvas = null;
  }

  /** Best-effort sender caps while a screen rides the sender (~1.5 Mbps, 10fps). */
  static capScreenSender(sender: RTCRtpSender): void {
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

  /** Clear the screen caps (back to camera defaults). */
  static uncapSender(sender: RTCRtpSender): void {
    try {
      const params = sender.getParameters();
      if (params.encodings && params.encodings.length > 0) {
        params.encodings[0]!.maxBitrate = undefined;
        params.encodings[0]!.maxFramerate = undefined;
        void sender.setParameters(params).catch(() => {
          /* best-effort */
        });
      }
    } catch {
      /* best-effort only */
    }
  }

  /** Stop the synthetic machinery (canvas timer, oscillator context). */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._canvas = null;
    if (this._audioCtx) {
      void this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
    }
    this.stopScreen();
  }
}
