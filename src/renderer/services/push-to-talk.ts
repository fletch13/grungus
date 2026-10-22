/** App-focused hold-to-talk. Releasing the key, focus, or visibility always mutes. */
export class PushToTalk {
  private held = false;
  private enabled = false;
  private code = "Space";
  private setMuted: ((muted: boolean) => void) | null = null;
  private listeners: AbortController | null = null;
  configure(enabled: boolean, code: string, setMuted: (muted: boolean) => void): void {
    this.stop(); this.enabled = enabled; this.code = code; this.setMuted = setMuted;
    if (!enabled) return;
    this.listeners = new AbortController(); const options = { capture: true, signal: this.listeners.signal };
    window.addEventListener("keydown", this.down, options); window.addEventListener("keyup", this.up, options);
    window.addEventListener("blur", this.release, options); document.addEventListener("visibilitychange", this.visibility, options); document.addEventListener("focusin", this.focus, options);
    this.setMuted(true);
  }
  stop(): void { this.listeners?.abort(); this.listeners = null; this.release(); this.enabled = false; this.setMuted = null; }
  private release = (): void => { if (this.held) { this.held = false; this.setMuted?.(true); } };
  private visibility = (): void => { if (document.hidden) this.release(); };
  private focus = (event: FocusEvent): void => { if ((event.target as HTMLElement | null)?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="dialog"]')) this.release(); };
  private down = (event: KeyboardEvent): void => {
    if (!this.enabled || event.code !== this.code || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="dialog"]')) return;
    event.preventDefault(); this.held = true; this.setMuted?.(false);
  };
  private up = (event: KeyboardEvent): void => { if (event.code === this.code) { if (this.held) event.preventDefault(); this.release(); } };
}
