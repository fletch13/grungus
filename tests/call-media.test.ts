/*
 * Grungus — call media device-selection tests: the getUserMedia
 * constraints built from the Voice & Video picks (microphone, camera).
 * Pure logic — the capture itself needs a browser (verified there).
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { CallMedia, mediaConstraints, offerHasVideo } from "../src/renderer/services/call-media.ts";

test("media constraints: defaults capture exactly audio, no video", () => {
  assert.deepEqual(mediaConstraints(false, { audioInput: "", videoInput: "" }), {
    audio: true,
    video: false,
  });
});

test("media constraints: a microphone pick constrains the audio device", () => {
  const c = mediaConstraints(false, { audioInput: "mic-1", videoInput: "" });
  assert.deepEqual(c.audio, { deviceId: { ideal: "mic-1" } });
  assert.equal(c.video, false);
});

test("media constraints: a camera pick constrains the video device (ideal, not exact)", () => {
  const c = mediaConstraints(true, { audioInput: "", videoInput: "cam-2" });
  assert.equal(c.audio, true);
  assert.deepEqual(c.video, { deviceId: { ideal: "cam-2" } });
});

test("media constraints: video without a pick stays on the system default", () => {
  const c = mediaConstraints(true, { audioInput: "", videoInput: "" });
  assert.deepEqual(c, { audio: true, video: true });
});

test("media constraints: both picks combine", () => {
  const c = mediaConstraints(true, { audioInput: "mic-1", videoInput: "cam-2" });
  assert.deepEqual(c.audio, { deviceId: { ideal: "mic-1" } });
  assert.deepEqual(c.video, { deviceId: { ideal: "cam-2" } });
});

test("offerHasVideo: an active video m-line is detected", () => {
  assert.ok(offerHasVideo("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n"));
});

test("offerHasVideo: audio-only SDP has no video", () => {
  assert.ok(!offerHasVideo("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"));
});

test("offerHasVideo: a REJECTED video m-line (port 0) does not count", () => {
  assert.ok(!offerHasVideo("v=0\r\nm=video 0 UDP/TLS/RTP/SAVPF 96\r\n"));
});

test("cancelled screen selection never falls back to sharing a synthetic screen", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    mediaDevices: { getDisplayMedia: async () => { throw new DOMException("Cancelled", "NotAllowedError"); } },
  } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "navigator", original); else Reflect.deleteProperty(globalThis, "navigator"); });
  assert.equal(await new CallMedia("@test:example.org").acquireScreen(), null);
});

test("microphone capture failures propagate without creating replacement media", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let requested: MediaStreamConstraints | undefined;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {
    getUserMedia: async (constraints: MediaStreamConstraints) => { requested = constraints; throw new DOMException("Microphone denied", "NotAllowedError"); },
  } } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "navigator", original); else Reflect.deleteProperty(globalThis, "navigator"); });
  await assert.rejects(new CallMedia("@test:example.org").acquire(false), /Microphone denied/);
  assert.equal(requested?.video, false, "Audio-only entry must not request camera permission");
});

test("unavailable device and display capture never generate synthetic streams", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: {} } });
  t.after(() => { if (original) Object.defineProperty(globalThis, "navigator", original); else Reflect.deleteProperty(globalThis, "navigator"); });
  const media = new CallMedia("@test:example.org");
  await assert.rejects(media.acquire(false), /capture is unavailable/);
  assert.equal(await media.acquireScreen(), null);
});
