/** Replace only microphone senders, retaining camera/screenshare tracks and mute state. */
export async function switchMicrophone(
  stream: MediaStream | null,
  peers: () => RTCPeerConnection[],
  current: () => boolean,
  muted: () => boolean,
  deviceId: string,
): Promise<void> {
  if (!stream) throw new Error("No active microphone to switch");
  const capture = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true, video: false });
  const replacement = capture.getAudioTracks()[0];
  if (!replacement) { capture.getTracks().forEach(track => track.stop()); throw new Error("The microphone provided no audio track"); }
  const previous = stream.getAudioTracks();
  const changed: { sender: RTCRtpSender; track: MediaStreamTrack | null }[] = [];
  try {
    if (!current()) throw new Error("The call has ended");
    replacement.enabled = !muted();
    for (const pc of peers()) {
      for (const sender of pc.getSenders()) {
        if (!sender.track || !previous.includes(sender.track)) continue;
        const track = sender.track;
        await sender.replaceTrack(replacement);
        changed.push({ sender, track });
      }
    }
    if (!current()) throw new Error("The call has ended");
    replacement.enabled = !muted();
    previous.forEach(track => stream.removeTrack(track));
    stream.addTrack(replacement);
    previous.forEach(track => track.stop());
  } catch (error) {
    await Promise.allSettled(changed.map(({ sender, track }) => sender.replaceTrack(track)));
    capture.getTracks().forEach(track => track.stop());
    throw error;
  }
}

/** Camera capture is requested only by the explicit camera control. */
export async function setCamera(
  stream: MediaStream | null,
  peers: RTCPeerConnection[],
  current: () => boolean,
  enabled: boolean,
  deviceId: string,
  onSender: (sender: RTCRtpSender) => void = () => {},
): Promise<void> {
  if (!stream) throw new Error("No active call");
  const previous = stream.getVideoTracks();
  if (!enabled) {
    for (const track of previous) {
      for (const pc of peers) for (const sender of pc.getSenders()) if (sender.track === track) await sender.replaceTrack(null);
      stream.removeTrack(track); track.stop();
    }
    return;
  }
  if (previous.some(track => track.readyState === "live")) return;
  const capture = await navigator.mediaDevices.getUserMedia({ audio: false, video: deviceId ? { deviceId: { exact: deviceId } } : true });
  const track = capture.getVideoTracks()[0];
  if (!track || !current()) { capture.getTracks().forEach(item => item.stop()); throw new Error("Camera unavailable or call ended"); }
  const changed: RTCRtpSender[] = [];
  try {
    stream.addTrack(track);
    for (const pc of peers) {
      const reusable = pc.getTransceivers().find(transceiver => !transceiver.sender.track && transceiver.receiver.track.kind === "video");
      if (reusable) { await reusable.sender.replaceTrack(track); changed.push(reusable.sender); onSender(reusable.sender); }
      else { const sender = pc.addTrack(track, stream); changed.push(sender); onSender(sender); }
    }
    if (!current()) throw new Error("The call has ended");
  } catch (error) {
    await Promise.allSettled(changed.map(sender => sender.replaceTrack(null)));
    stream.removeTrack(track); capture.getTracks().forEach(item => item.stop()); throw error;
  }
}
