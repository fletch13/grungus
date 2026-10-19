import test from "node:test";
import assert from "node:assert/strict";
import { switchMicrophone } from "../src/renderer/services/call-devices.ts";

test("microphone replacement preserves mute, video, and screen audio; failure rolls back", async t => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => { if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else Reflect.deleteProperty(globalThis, "navigator"); });
  let replacementStopped = false;
  let previousStopped = false;
  let requested: MediaStreamConstraints | undefined;
  const previous = { kind: "audio", stop: () => { previousStopped = true; } } as unknown as MediaStreamTrack;
  const replacement = { kind: "audio", enabled: true, stop: () => { replacementStopped = true; } } as unknown as MediaStreamTrack;
  const screenAudio = { kind: "audio" } as MediaStreamTrack;
  let tracks = [previous];
  const stream = {
    getAudioTracks: () => tracks,
    removeTrack: (track: MediaStreamTrack) => { tracks = tracks.filter(item => item !== track); },
    addTrack: (track: MediaStreamTrack) => { tracks.push(track); },
  } as MediaStream;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async (constraints: MediaStreamConstraints) => {
    requested = constraints;
    return { getAudioTracks: () => [replacement], getTracks: () => [replacement] };
  } } } });
  const sender = { track: previous, replaceTrack: async (track: MediaStreamTrack) => { sender.track = track; } };
  const untouched = { track: screenAudio, replaceTrack: async () => { throw new Error("Must not replace screen audio"); } };
  const peer = { getSenders: () => [sender, untouched] } as unknown as RTCPeerConnection;
  await switchMicrophone(stream, () => [peer], () => true, () => true, "usb-mic");
  assert.deepEqual(requested, { audio: { deviceId: { exact: "usb-mic" } }, video: false });
  assert.equal(replacement.enabled, false);
  assert.equal(sender.track, replacement);
  assert.equal(previousStopped, true);
  assert.equal(replacementStopped, false);
  assert.deepEqual(tracks, [replacement]);

  tracks = [previous]; sender.track = previous; previousStopped = false;
  const failingPeer = { getSenders: () => [{ track: previous, replaceTrack: async () => { throw new Error("Device failed"); } }] } as unknown as RTCPeerConnection;
  await assert.rejects(switchMicrophone(stream, () => [peer, failingPeer], () => true, () => false, ""), /Device failed/);
  assert.equal(sender.track, previous, "A partial switch must restore the original sender");
  assert.equal(previousStopped, false, "Failed switches must retain the current microphone");
  assert.equal(replacementStopped, true, "Failed switches must release the new microphone");
});

test("microphone acquired after hangup is immediately released", async t => {
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => { if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator); else Reflect.deleteProperty(globalThis, "navigator"); });
  let stopped = false;
  const track = { stop: () => { stopped = true; } } as unknown as MediaStreamTrack;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) } } });
  const stream = { getAudioTracks: () => [] } as unknown as MediaStream;
  await assert.rejects(switchMicrophone(stream, () => [], () => false, () => false, ""), /call has ended/);
  assert.equal(stopped, true);
});

test("camera capture is explicit, camera-off stops capture, and late permission results are released", async t => {
  const { setCamera } = await import("../src/renderer/services/call-devices.ts");
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  t.after(() => { if (original) Object.defineProperty(globalThis, "navigator", original); else Reflect.deleteProperty(globalThis, "navigator"); });
  let captures = 0;
  let stopped = false;
  const track = { readyState: "live", stop: () => { stopped = true; } } as unknown as MediaStreamTrack;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async (constraints: MediaStreamConstraints) => {
    captures++; assert.equal(constraints.audio, false); assert.equal(constraints.video, true);
    return { getVideoTracks: () => [track], getTracks: () => [track] };
  } } } });
  let tracks: MediaStreamTrack[] = [];
  const stream = { getVideoTracks: () => tracks, addTrack: (item: MediaStreamTrack) => { tracks.push(item); }, removeTrack: (item: MediaStreamTrack) => { tracks = tracks.filter(track => track !== item); } } as MediaStream;
  await setCamera(stream, [], () => true, false, "");
  assert.equal(captures, 0);
  await setCamera(stream, [], () => true, true, "");
  assert.equal(captures, 1); assert.equal(tracks.length, 1);
  await setCamera(stream, [], () => true, false, "");
  assert.equal(stopped, true); assert.equal(tracks.length, 0);
  stopped = false;
  await assert.rejects(setCamera(stream, [], () => false, true, ""), /call ended/);
  assert.equal(stopped, true);
});
