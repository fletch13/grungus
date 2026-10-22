import { PushToTalk } from "../services/push-to-talk.ts";
import { SettingsStore } from "../services/settings.ts";
import { bindUserTile } from "./user-menu.ts";
import { VoiceActivityMonitor } from "../services/voice-activity.ts";
/*
 * Grungus — <call-view>: full-screen call overlay.
 * Local + remote tiles, mute toggle, screenshare start/stop, a large
 * presentation tile for the active screen, hangup, per-peer state.
 * Works with the MSC3401 mesh manager or the LiveKit SFU adapter —
 * anything satisfying the controller interface below.
 */
import { icon } from "./icons.ts";
import { el } from "./ui.ts";
import type { MatrixClient } from "../services/matrix-client.ts";
import type { CallUiState } from "../services/calls.ts";

/** What the overlay needs from whichever call backend drives it. */
export interface CallController {
  setMuted(muted: boolean): void;
  hangUp(): void;
  startScreenshare(): void;
  stopScreenshare(): void;
  localStream: MediaStream | null;
  localCameraEnabled?: boolean;
  setCameraEnabled?(enabled: boolean): Promise<void>;
  switchAudioInput?(deviceId: string): Promise<void>;
  switchAudioOutput?(deviceId: string): Promise<void>;
  /** the sharer's own screen stream, when driving with mesh calls */
  localScreenStream?: MediaStream | null;
}

export class CallView extends HTMLElement {
  private _state: CallUiState | null = null;
  private _deafened = false;
  private _mutedBeforeDeafen = false;
  private _peerVolumes = new Map<string, number>();
  private _peerMuted = new Set<string>();
  private _applyPeerAudio(): void {
    for (const [key, video] of this._videos) {
      if (key === "local" || key === "screen-local") { video.muted = true; continue; }
      const peer = key.startsWith("screen-") ? key.slice(7) : key;
      video.volume = this._peerVolumes.get(peer) ?? 1;
      video.muted = this._deafened || this._peerMuted.has(peer);
    }
  }
  private _ptt = new PushToTalk();
  private _pttEnabled = false;
  private _pttKey = "Space";
  private _configurePtt(): void {
    const manager = this._manager;
    if (!this._state?.active || !manager) { this._ptt.stop(); return; }
    this._ptt.configure(this._pttEnabled, this._pttKey, muted => manager.setMuted(this._deafened || muted));
  }
  private _client: MatrixClient | null = null;
  private _speakers = new Set<string>();
  private _voiceActivity = new VoiceActivityMonitor(active => { this._speakers = active; this._applySpeaking(); });
  private _applySpeaking(): void {
    const state = this._state;
    for (const tile of this.querySelectorAll<HTMLElement>(".call-tile[data-speaker-key]")) {
      const key = tile.dataset.speakerKey!;
      const participant = state?.participants.find(participant => participant.key === key);
      const speaking = key === "local"
        ? !state?.localMuted && (state?.localSpeaking ?? this._speakers.has(key))
        : participant?.speaking ?? this._speakers.has(key);
      tile.classList.toggle("speaking", speaking);
      const indicator = tile.querySelector<HTMLElement>(".call-speaking-indicator");
      if (indicator) indicator.hidden = !speaking;
    }
  }
  private _watchSpeaking(): void {
    const state = this._state!;
    this._voiceActivity.setStreams([
      ...(state.localSpeaking === undefined && !state.localMuted ? [{ key: "local", stream: this._manager?.localStream ?? null }] : []),
      ...state.participants.filter(participant => participant.speaking === undefined).map(participant => ({ key: participant.key, stream: participant.stream })),
    ]);
    this._applySpeaking();
  }
  private _featuredKey: string | null = null;
  private _cameraKeys = new Set<string>();
  private _mediaListeners = new Map<EventTarget, () => void>();
  private _avatarLoads = new Map<string, { expires: number; load: Promise<string | null> }>();
  setClient(client: MatrixClient): void { this._client = client; this._avatarLoads.clear(); }
  private _hasVideo(stream: MediaStream | null): boolean {
    return stream?.getVideoTracks().some(track => track.readyState === "live" && track.enabled && !track.muted) ?? false;
  }
  private _userId(identity: string): string {
    const room = this._state?.roomId ? this._client?.getRoom(this._state.roomId) : null;
    const membership = room?.rtcMemberships.find(member => `${member.sender}:${member.deviceId}` === identity);
    if (membership) return membership.sender;
    return [...(room?.members.keys() ?? [])].sort((a, b) => b.length - a.length).find(user => identity === user || identity.startsWith(`${user}:`)) ?? identity;
  }
  private _avatar(userId: string, size: number): HTMLElement {
    const avatar = document.createElement("g-avatar");
    const user = this._userId(userId);
    const client = this._client;
    const room = this._state?.roomId ? client?.getRoom(this._state.roomId) : null;
    const member = room?.members.get(user);
    const key = `${user}|${member?.avatarMxc ?? ""}`;
    let cached = this._avatarLoads.get(key);
    if (client && (!cached || cached.expires < Date.now())) {
      const load = (async () => {
        const mxc = member?.avatarMxc || (await client.getProfile(user).catch(() => null))?.avatar_url;
        return client.avatarSrc(mxc, 96);
      })().catch(() => null);
      cached = { expires: Date.now() + 60_000, load }; this._avatarLoads.set(key, cached);
      if (this._avatarLoads.size > 128) this._avatarLoads.delete(this._avatarLoads.keys().next().value!);
    }
    avatar.update({ userId: user, name: member?.displayname || user, size, load: cached?.load });
    avatar.setAttribute("aria-label", `${member?.displayname || user} profile picture`);
    return avatar;
  }
  private _watchMedia(): void {
    const streams = [this._manager?.localStream, this._manager?.localScreenStream, ...(this._state?.participants.flatMap(participant => [participant.stream, participant.screenStream]) ?? [])].filter((stream): stream is MediaStream => !!stream);
    const targets = new Set<EventTarget>();
    for (const stream of streams) {
      targets.add(stream);
      for (const track of stream.getTracks()) targets.add(track);
    }
    for (const [target, cleanup] of this._mediaListeners) if (!targets.has(target)) { cleanup(); this._mediaListeners.delete(target); }
    for (const target of targets) if (!this._mediaListeners.has(target)) {
      const events = ["addtrack", "removetrack", "mute", "unmute", "ended"];
      const update = () => this._render();
      events.forEach(event => target.addEventListener(event, update));
      this._mediaListeners.set(target, () => events.forEach(event => target.removeEventListener(event, update)));
    }
  }
  private _clearMediaListeners(): void {
    for (const cleanup of this._mediaListeners.values()) cleanup(); this._mediaListeners.clear();
  }
  private _manager: CallController | null = null;
  /** key -> video element, reused across renders to avoid flicker. */
  private _videos = new Map<string, HTMLVideoElement>();
  /** the preferred speaker ("" = system default), from Voice & Video */
  private _audioOutput = "";
  private _audioInput = "";
  private _devices: MediaDeviceInfo[] = [];
  private _deviceError = "";
  private _switching = false;
  private _refreshSequence = 0;
  private _refreshDevices = async (): Promise<void> => {
    const sequence = ++this._refreshSequence;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (sequence !== this._refreshSequence || !this._state?.active || !this.isConnected) return;
      this._devices = devices; this._render();
    } catch { this._deviceError = "Device list unavailable. Check microphone permission."; this._render(); }
  };
  setAudioInput(deviceId: string): void { this._audioInput = deviceId; }
  disconnectedCallback(): void {
    this._ptt.stop();
    this._refreshSequence++;
    this._clearMediaListeners(); this._voiceActivity.stop(); this._speakers.clear();
    navigator.mediaDevices?.removeEventListener("devicechange", this._refreshDevices);
    for (const video of this._videos.values()) video.srcObject = null;
    this._videos.clear();
  }

  connectedCallback(): void {
    navigator.mediaDevices?.addEventListener("devicechange", this._refreshDevices);
    this._render();
  }

  update(state: CallUiState, manager: CallController): void {
    const starting = state.active && !this._state?.active;
    if (state.roomId !== this._state?.roomId) { this._featuredKey = null; this._cameraKeys.clear(); }
    this._state = state;
    this._manager = manager;
    if (starting) {
      this._deafened = false; this._peerVolumes.clear(); this._peerMuted.clear();
      const settings = new SettingsStore(); this._pttEnabled = settings.get("pushToTalk"); this._pttKey = settings.get("pushToTalkKey");
      this._configurePtt();
    }
    if (!state.active) this._ptt.stop();
    this._render();
    if (starting) { this._deviceError = ""; void this._refreshDevices(); }
  }

  /**
   * Route every tile's audio to the given speaker ("" = system
   * default). Applied to new tiles as they appear; the app calls this
   * again when the Voice & Video pick changes mid-call.
   */
  applyAudioOutput(sinkId: string): void {
    this._audioOutput = sinkId;
    for (const video of this._videos.values()) this._applyAudioOutput(video);
  }

  private _applyAudioOutput(video: HTMLVideoElement): void {
    const sink = this._audioOutput;

    const el = video as HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId !== "function") return;
    /* a device unplugged mid-call rejects — the tile keeps playing on
       the default output */
    void el.setSinkId(sink).catch(() => {});
  }

  private _render(): void {
    const state = this._state;
    const manager = this._manager;
    const focused = this.contains(document.activeElement) ? document.activeElement?.getAttribute("aria-label") : null;
    this.textContent = "";

    if (!state || !state.active || !manager) {
      /* the call ended — drop the overlay backdrop too, or an empty
         gray sheet stays over the whole app */
      this.classList.remove("call-overlay");
      for (const video of this._videos.values()) {
        video.srcObject = null;
      }
      this._videos.clear(); this._clearMediaListeners(); this._voiceActivity.stop(); this._speakers.clear();
      this._featuredKey = null; this._cameraKeys.clear();
      this._refreshSequence++;
      return;
    }

    this.classList.add("call-overlay");

    const header = el("div", { class: "call-header" });
    header.appendChild(el("div", { class: "call-heading" },
      el("span", { class: "call-eyebrow", text: "LIVE CONVERSATION" }),
      el("h2", { class: "call-title", text: "Your call" })));
    header.appendChild(el("span", { class: "call-participant-count" }, icon("users", 16), `${state.participants.length + 1} ${state.participants.length ? "participants" : "participant"}`));
    if (state.notice) {
      header.appendChild(el("span", { class: "call-notice", text: state.notice }));
    }
    this.appendChild(header);

    this._watchMedia();
    const cameras = state.participants.filter(participant => this._hasVideo(participant.stream));
    const newCamera = [...cameras].reverse().find(participant => !this._cameraKeys.has(participant.key));
    if (newCamera) this._featuredKey = newCamera.key;
    if (!cameras.some(participant => participant.key === this._featuredKey)) this._featuredKey = cameras[0]?.key ?? null;
    this._cameraKeys = new Set(cameras.map(participant => participant.key));
    const featured = cameras.find(participant => participant.key === this._featuredKey);
    const localUser = this._client?.userId ?? state.localKey ?? "You";
    const stages = state.participants.filter(participant => participant.sharing && this._hasVideo(participant.screenStream)).map(participant => ({
      key: `screen-${participant.key}`, name: `${participant.name}’s screen`, stream: participant.screenStream,
      status: participant.connectionState, userId: participant.userId, speakerKey: participant.key, screen: true,
    }));
    if (state.localSharing && this._hasVideo(manager.localScreenStream ?? null)) stages.push({ key: "screen-local", name: "Your screen", stream: manager.localScreenStream!, status: "local", userId: localUser, speakerKey: "local", screen: true });
    const orderedCameras = [...cameras].sort((a, b) => Number(b.key === featured?.key) - Number(a.key === featured?.key));
    for (const participant of orderedCameras) stages.push({ key: participant.key, name: participant.name, stream: participant.stream, status: participant.connectionState, userId: participant.userId, speakerKey: participant.key, screen: false });
    const layout = el("div", { class: `call-layout${stages.length ? " has-stage" : ""}` });
    if (stages.length) {
      const stageGrid = el("section", { class: `call-stage${stages.length > 1 ? " multiple-streams" : ""}`, "aria-label": "Call streams" });
      for (const stage of stages) {
        const tile = this._buildTile(stage.key, stage.name, stage.stream, stage.status, false, stage.screen ? "presentation" : "featured-video", stage.userId);
        tile.dataset.speakerKey = stage.speakerKey;
        tile.setAttribute("aria-label", stage.screen ? "Shared screen" : `${stage.name} video`);
        stageGrid.append(tile);
      }
      layout.append(stageGrid);
    }
    const grid = el("div", { class: "call-grid", "aria-label": "Call participants" });
    grid.appendChild(this._buildTile("local", "You", manager.localStream, "local", state.localMuted, "", localUser));
    for (const participant of state.participants) {
      const onStage = cameras.some(camera => camera.key === participant.key);
      const tile = this._buildTile(onStage ? `preview-${participant.key}` : participant.key,
        participant.name, onStage ? null : participant.stream, participant.connectionState, false, onStage ? "on-stage" : "", participant.userId, !onStage);
      const audio = el("div", { class: "call-peer-audio" });
      const volume = el("input", { type: "range", min: "0", max: "100", step: "1", value: String(Math.round((this._peerVolumes.get(participant.key) ?? 1) * 100)), "aria-label": `Volume for ${participant.name}` }) as HTMLInputElement;
      const level = el("output", { text: `${volume.value}%` });
      volume.addEventListener("input", () => { this._peerVolumes.set(participant.key, Number(volume.value) / 100); level.textContent = `${volume.value}%`; this._applyPeerAudio(); });
      const mutePeer = el("button", { type: "button", class: "call-btn", text: this._peerMuted.has(participant.key) ? "Unmute locally" : "Mute locally", "aria-pressed": String(this._peerMuted.has(participant.key)), "aria-label": `Mute ${participant.name} locally` });
      mutePeer.addEventListener("click", () => { if (this._peerMuted.has(participant.key)) this._peerMuted.delete(participant.key); else this._peerMuted.add(participant.key); this._applyPeerAudio(); mutePeer.textContent = this._peerMuted.has(participant.key) ? "Unmute locally" : "Mute locally"; mutePeer.setAttribute("aria-pressed", String(this._peerMuted.has(participant.key))); });
      audio.append(el("label", {}, "Volume", volume), level, mutePeer); tile.append(audio);
      tile.dataset.participantKey = participant.key;
      tile.dataset.speakerKey = participant.key;
      if (this._hasVideo(participant.stream) ) {
        const focus = el("button", { type: "button", class: "call-focus-video", "aria-label": `Feature ${participant.name} video`, "aria-pressed": String(participant.key === featured?.key), title: "Show this video first" }, icon("video", 16));
        focus.addEventListener("click", () => { this._featuredKey = participant.key; this._render(); });
        tile.append(focus);
      }
      grid.appendChild(tile);
    }
    if (!state.participants.length) grid.append(el("div", { class: "call-empty", text: "Waiting for others to join…" }));
    layout.append(grid); this.append(layout);
    const devicePanel = el("div", { class: "call-device-panel", "aria-label": "Call audio devices" });
    for (const [kind, label, selected] of [["audioinput", "Microphone", this._audioInput], ["audiooutput", "Speaker", this._audioOutput]] as const) {
      const select = el("select", { "aria-label": label, class: "call-device-select", disabled: this._switching || (kind === "audioinput" && !manager.switchAudioInput) || (kind === "audiooutput" && !manager.switchAudioOutput && typeof HTMLMediaElement.prototype.setSinkId !== "function") }) as HTMLSelectElement;
      select.append(el("option", { value: "", text: "System default" }));
      const devices = this._devices.filter(device => device.kind === kind && device.deviceId && device.deviceId !== "default");
      devices.forEach((device, index) => select.append(el("option", { value: device.deviceId, text: device.label || `${label} ${index + 1}` })));
      if (selected && !devices.some(device => device.deviceId === selected)) select.append(el("option", { value: selected, text: "Saved device (unavailable)" }));
      select.value = selected;
      select.addEventListener("change", () => { void this._changeDevice(kind, select.value); });
      devicePanel.append(el("label", { class: "call-device-field" }, el("span", { text: label }), select));
    }
    const refresh = el("button", { type: "button", class: "call-btn call-device-refresh", text: "Refresh devices", disabled: this._switching });
    refresh.addEventListener("click", () => { void this._refreshDevices(); });
    devicePanel.append(refresh);
    if (this._deviceError) devicePanel.append(el("p", { class: "call-device-error", role: "alert", text: this._deviceError }));
    const ptt = el("input", { type: "checkbox", "aria-label": "Push to talk" }) as HTMLInputElement; ptt.checked = this._pttEnabled;
    ptt.addEventListener("change", () => {
      this._pttEnabled = ptt.checked; new SettingsStore().set("pushToTalk", ptt.checked); this._configurePtt(); this._render();
    });
    const key = el("select", { class: "call-device-select", "aria-label": "Push-to-talk key" }) as HTMLSelectElement;
    for (const code of ["Space", ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`), ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`)]) key.append(el("option", { value: code, text: code.startsWith("Key") ? code.slice(3) : code }));
    key.value = this._pttKey;
    key.addEventListener("change", () => { this._pttKey = key.value; new SettingsStore().set("pushToTalkKey", key.value); this._configurePtt(); });
    devicePanel.append(el("label", {}, ptt, " Push to talk"), key, el("small", { class: "settings-hint", text: "Hold the selected key while Grungus is focused. Typing fields do not transmit audio." }));
    this.append(devicePanel);

    const footer = el("div", { class: "call-footer" });
    const mute = el(
      "button",
      { class: "call-btn" + (state.localMuted ? " muted" : ""), text: state.localMuted ? "Unmute" : "Mute" }
    );
    (mute as HTMLButtonElement).disabled = this._pttEnabled || this._deafened;
    mute.addEventListener("click", () => {
      manager.setMuted(!state.localMuted);
    });
    const share = el(
      "button",
      {
        class: "call-btn" + (state.localSharing ? " sharing" : ""),
        text: state.localSharing ? "Stop sharing" : "Share screen",
      }
    );
    share.addEventListener("click", () => {
      void (state.localSharing ? manager.stopScreenshare() : manager.startScreenshare());
    });
    const hangUp = el("button", { class: "call-btn danger", text: "Hang up" });
    hangUp.addEventListener("click", () => {
      void manager.hangUp();
    });
    mute.setAttribute("aria-pressed", String(state.localMuted));
    mute.prepend(icon("mic", 20));
    share.setAttribute("aria-pressed", String(state.localSharing));
    share.prepend(icon("screen", 20));
    hangUp.prepend(icon("phone", 20));
    footer.appendChild(mute);
    const deafen = el("button", { type: "button", class: "call-btn", text: this._deafened ? "Undeafen" : "Deafen", "aria-pressed": String(this._deafened), "aria-label": "Deafen" });
    deafen.addEventListener("click", () => {
      if (!this._deafened) this._mutedBeforeDeafen = state.localMuted;
      this._deafened = !this._deafened;
      manager.setMuted(this._deafened || this._pttEnabled || this._mutedBeforeDeafen); this._applyPeerAudio(); this._render();
    }); footer.append(deafen);
    if (manager.setCameraEnabled) {
      const enabled = manager.localCameraEnabled === true;
      const camera = el("button", { type: "button", class: "call-btn" + (enabled ? " sharing" : ""), text: enabled ? "Turn camera off" : "Turn camera on", "aria-label": enabled ? "Turn camera off" : "Turn camera on", "aria-pressed": String(enabled), disabled: this._switching }, icon("video", 20));
      camera.addEventListener("click", () => {
        this._switching = true; this._deviceError = ""; this._render();
        void manager.setCameraEnabled!(!enabled).catch(error => {
          this._deviceError = `Could not change camera: ${error instanceof Error ? error.message : "unknown error"}`;
        }).finally(() => { this._switching = false; this._render(); });
      });
      footer.appendChild(camera);
    }
    footer.appendChild(share);
    footer.appendChild(hangUp);
    this.appendChild(footer);
    if (focused) [...this.querySelectorAll<HTMLElement>("[aria-label]")].find(node => node.getAttribute("aria-label") === focused)?.focus();
    this._applyPeerAudio();
    this._watchSpeaking();
    const activeKeys = new Set(["local", ...state.participants.map(p => p.key), ...stages.map(stage => stage.key)]);
    for (const [key, video] of this._videos) if (!activeKeys.has(key)) { video.srcObject = null; this._videos.delete(key); }
  }

  private async _changeDevice(kind: "audioinput" | "audiooutput", deviceId: string): Promise<void> {
    const manager = this._manager;
    const state = this._state;
    if (this._switching || !manager || !state?.active) return;
    this._switching = true; this._deviceError = ""; this._render();
    try {
      if (kind === "audioinput") {
        if (!manager.switchAudioInput) throw new Error("Microphone switching is unavailable");
        await manager.switchAudioInput(deviceId);
      } else {
        if (manager.switchAudioOutput) await manager.switchAudioOutput(deviceId);
        await Promise.all([...this._videos.values()].filter(video => typeof video.setSinkId === "function").map(video => video.setSinkId(deviceId)));
      }
      if (!this._state?.active || this._state.roomId !== state.roomId) return;
      if (kind === "audioinput") this._audioInput = deviceId;
      else this._audioOutput = deviceId;
      this.dispatchEvent(new CustomEvent("grungus:call-device", { detail: { kind: kind === "audioinput" ? "audioInput" : "audioOutput", deviceId } }));
    } catch (error) {
      this._deviceError = `Could not switch ${kind === "audioinput" ? "microphone" : "speaker"}: ${error instanceof Error ? error.message : "unknown error"}`;
      if (kind === "audiooutput") this.applyAudioOutput(this._audioOutput);
    } finally { this._switching = false; this._render(); }
  }

  private _buildTile(
    key: string,
    name: string,
    stream: MediaStream | null,
    status: string,
    muted: boolean,
    extraClass = "",
    userId = name,
    showMedia = true
  ): HTMLElement {
    const resolvedUser = this._userId(userId);
    const nickname = this._client?.getUserNickname?.(resolvedUser);
    if (nickname) name = extraClass === "presentation" ? `${nickname}’s screen` : nickname;
    const tile = el("div", { class: ("call-tile " + extraClass).trim(), dataset: { speakerKey: key } });
    bindUserTile(tile, this._client, resolvedUser, name);
    tile.append(el("span", { class: "call-speaking-indicator", hidden: true, "aria-label": "Speaking", text: "Speaking" }));

    if (showMedia) {
    let video = this._videos.get(key);
    if (!video) {
      video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      this._videos.set(key, video);
      this._applyAudioOutput(video);
    }
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      /* autoplay is unreliable (backgrounded tabs observed paused) — start
         playback explicitly; muted/allowed cases resolve immediately */
      void video.play().catch(() => {
        /* autoplay policy: will start on the next user interaction */
      });
    }
    if (key === "local" || key === "screen-local") video.muted = true; /* no echo of our own media */
    tile.appendChild(video);
    }
    if (!showMedia || !this._hasVideo(stream)) {
      tile.classList.add("audio-only");
      tile.append(el("div", { class: "call-avatar" }, this._avatar(userId, 88)));
    }

    const label = el("div", { class: "call-tile-label" });
    label.append(this._avatar(userId, 24), el("span", { class: "call-tile-name", text: name }));
    label.appendChild(
      el("span", {
        class: "call-tile-status" + (status === "connected" ? " ok" : ""),
        text: key === "local" ? (muted ? "muted" : "") : status,
      })
    );
    tile.appendChild(label);
    return tile;
  }
}

customElements.define("call-view", CallView);

declare global {
  interface HTMLElementTagNameMap {
    "call-view": CallView;
  }
}
