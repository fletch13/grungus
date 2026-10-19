/** Brief attack and release windows keep speech indicators from flickering between syllables. */
export class VoiceActivityGate {
  private loudSamples = 0;
  private lastLoud = -Infinity;
  speaking = false;
  update(level: number, now: number): boolean {
    if (level >= .025) {
      this.loudSamples++;
      if (this.loudSamples >= 2) { this.lastLoud = now; this.speaking = true; }
    } else {
      this.loudSamples = 0;
      if (now - this.lastLoud >= 500) this.speaking = false;
    }
    return this.speaking;
  }
}

/** Analyse real microphone/remote audio locally; never connect it to an audio output. */
export class VoiceActivityMonitor {
  private context: AudioContext | null = null;
  private entries = new Map<string, { tracks: MediaStreamTrack[]; source: MediaStreamAudioSourceNode; analyser: AnalyserNode; samples: Float32Array<ArrayBuffer>; gate: VoiceActivityGate }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private changed: (active: Set<string>) => void;
  constructor(changed: (active: Set<string>) => void) { this.changed = changed; }
  setStreams(inputs: { key: string; stream: MediaStream | null }[]): void {
    const available = inputs.map(input => ({ ...input, tracks: input.stream?.getAudioTracks().filter(track => track.enabled && track.readyState === "live") ?? [] })).filter(input => input.tracks.length);
    const keys = new Set(available.map(input => input.key));
    for (const [key, entry] of this.entries) if (!keys.has(key)) { entry.source.disconnect(); entry.analyser.disconnect(); this.entries.delete(key); }
    for (const input of available) {
      const old = this.entries.get(input.key);
      if (old && old.tracks.length === input.tracks.length && old.tracks.every((track, index) => track === input.tracks[index])) continue;
      if (old) { old.source.disconnect(); old.analyser.disconnect(); this.entries.delete(input.key); }
      try {
        this.context ??= new AudioContext();
        if (this.context.state === "suspended") void this.context.resume().catch(() => {});
        const analyser = this.context.createAnalyser(); analyser.fftSize = 512;
        const source = this.context.createMediaStreamSource(new MediaStream(input.tracks));
        source.connect(analyser);
        this.entries.set(input.key, { tracks: input.tracks, source, analyser, samples: new Float32Array(512), gate: new VoiceActivityGate() });
      } catch { /* If audio analysis is unsupported, call playback remains available. */ }
    }
    if (this.entries.size && !this.timer) this.timer = setInterval(() => this.sample(), 100);
    if (!this.entries.size && this.timer) { clearInterval(this.timer); this.timer = null; }
    this.sample();
  }
  private sample(): void {
    const active = new Set<string>();
    for (const [key, entry] of this.entries) {
      entry.analyser.getFloatTimeDomainData(entry.samples);
      const level = this.context?.state === "running" && entry.tracks.some(track => track.enabled && !track.muted && track.readyState === "live")
        ? Math.sqrt(entry.samples.reduce((sum, value) => sum + value * value, 0) / entry.samples.length) : 0;
      if (entry.gate.update(level, performance.now())) active.add(key);
    }
    this.changed(active);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer); this.timer = null;
    for (const entry of this.entries.values()) { entry.source.disconnect(); entry.analyser.disconnect(); }
    this.entries.clear();
    void this.context?.close().catch(() => {}); this.context = null;
  }
}
