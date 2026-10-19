/** Real device capture only. Permission or device failures are reported to the caller. */
import { SettingsStore } from "./settings.ts";
export interface AcquiredMedia { stream: MediaStream; }

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
  constructor(_userId: string) {}

  async acquire(video = false): Promise<AcquiredMedia> {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) throw new Error("Microphone capture is unavailable on this device");
    const prefs = new SettingsStore();
    const stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(video, {
      audioInput: prefs.get("audioInput"), videoInput: prefs.get("videoInput"),
    }));
    return { stream };
  }

  /* ------------------------------- screen -------------------------------- */

  /** Capture a real screen, returning null when unavailable or cancelled. */
  async acquireScreen(audio = true): Promise<AcquiredMedia | null> {
    try {
      const md = navigator.mediaDevices;
      if (md && typeof md.getDisplayMedia === "function") {
        const stream = await md.getDisplayMedia({
          video: { frameRate: { ideal: SCREEN_MAX_FPS, max: SCREEN_MAX_FPS } },
          audio,
        });
        for (const track of stream.getVideoTracks()) {
          /* text/detail keeps small UI text sharp at low bitrates */
          if (typeof track.contentHint === "string") track.contentHint = "detail";
        }
        return { stream };
      }
    } catch (err) {
      console.warn("[call] screen capture cancelled or unavailable:", err);
      return null;
    }
    return null;
  }

  stopScreen(): void {}

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

  stop(): void {}
}
