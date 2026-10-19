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
  }
}
