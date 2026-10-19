import test from "node:test";
import assert from "node:assert/strict";
import { VoiceActivityGate, VoiceActivityMonitor } from "../src/renderer/services/voice-activity.ts";

test("speech highlighting rejects a single transient and holds briefly between syllables", () => {
  const gate = new VoiceActivityGate();
  assert.equal(gate.update(.1, 0), false);
  assert.equal(gate.update(0, 100), false);
  assert.equal(gate.update(.1, 200), false);
  assert.equal(gate.update(.1, 300), true);
  assert.equal(gate.update(0, 600), true);
  assert.equal(gate.update(0, 800), false);
});

test("voice analysis reuses tracks, ignores muted inputs, and releases nodes and context", async t => {
  const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "AudioContext");
  const originalStream = Object.getOwnPropertyDescriptor(globalThis, "MediaStream");
  let sources = 0; let disconnected = 0; let closed = 0;
  Object.defineProperty(globalThis, "MediaStream", { configurable: true, value: class { tracks: unknown[]; constructor(tracks: unknown[]) { this.tracks = tracks; } } });
  Object.defineProperty(globalThis, "AudioContext", { configurable: true, value: class {
    state = "running";
    createAnalyser() { return { fftSize: 512, getFloatTimeDomainData: (samples: Float32Array) => samples.fill(.1), disconnect: () => { disconnected++; } }; }
    createMediaStreamSource() { sources++; return { connect: () => {}, disconnect: () => { disconnected++; } }; }
    async close() { closed++; }
  } });
  t.after(() => {
    if (originalAudio) Object.defineProperty(globalThis, "AudioContext", originalAudio); else Reflect.deleteProperty(globalThis, "AudioContext");
    if (originalStream) Object.defineProperty(globalThis, "MediaStream", originalStream); else Reflect.deleteProperty(globalThis, "MediaStream");
  });
  let speakers = new Set<string>();
  const monitor = new VoiceActivityMonitor(active => { speakers = active; });
  t.after(() => monitor.stop());
  const track = { enabled: true, readyState: "live", muted: false };
  const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
  monitor.setStreams([{ key: "friend", stream }]);
  await new Promise(resolve => setTimeout(resolve, 130));
  assert.ok(speakers.has("friend"));
  monitor.setStreams([{ key: "friend", stream: { getAudioTracks: () => [track] } as unknown as MediaStream }]);
  assert.equal(sources, 1, "New stream wrappers must reuse the existing analyser for the same tracks");
  track.enabled = false;
  monitor.setStreams([{ key: "friend", stream }]);
  assert.equal(speakers.size, 0, "Muted/disabled audio must clear the speaking state");
  assert.equal(disconnected, 2);
  monitor.stop(); assert.equal(closed, 1);
});
