/*
 * Grungus — <incoming-call>: the ring. A fixed banner card when someone
 * starts a call in one of our rooms ("X is calling"), with a two-tone
 * WebAudio ring (no audio assets needed), Join / Dismiss buttons, and
 * a 45s missed-call timeout.
 */
import { el } from "./ui.ts";

export class IncomingCall extends HTMLElement {
  private _roomId: string | null = null;
  private _roomTitle: string | null = null;
  private _audioCtx: AudioContext | null = null;
  private _ringTimer: ReturnType<typeof setInterval> | null = null;
  private _ringing = false;
  private _timeoutTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    this._render();
  }

  /** Ring for a call in the given room. */
  show(roomId: string, roomTitle: string): void {
    if (this._roomId === roomId) return; /* already ringing */
    this.dismiss();
    this._roomId = roomId;
    this._roomTitle = roomTitle;
    this._startRing();
    this._timeoutTimer = setTimeout(() => this.dismiss(), 45_000);
    this._render();
  }

  dismiss(): void {
    if (this._timeoutTimer) clearTimeout(this._timeoutTimer);
    this._timeoutTimer = null;
    this._stopRing();
    this._roomId = null;
    this._roomTitle = null;
    this._render();
  }

  get ringingRoomId(): string | null {
    return this._roomId;
  }

  private _render(): void {
    this.textContent = "";
    if (!this._roomId) {
      this.classList.remove("incoming-call-visible");
      return;
    }
    this.classList.add("incoming-call-visible");
    const card = el("div", { class: "incoming-call-card" });
    card.appendChild(
      el("span", {
        class: "incoming-call-title",
        text: `📞 Incoming call — ${this._roomTitle ?? this._roomId}`,
      })
    );
    const join = el("button", { class: "call-btn", text: "Join" });
    join.addEventListener("click", () => {
      const roomId = this._roomId;
      this.dismiss();
      if (roomId) {
        this.dispatchEvent(
          new CustomEvent("grungus:join-incoming", { detail: { roomId }, bubbles: true })
        );
      }
    });
    const dismissBtn = el("button", { class: "call-btn danger", text: "Dismiss" });
    dismissBtn.addEventListener("click", () => this.dismiss());
    const buttons = el("div", { class: "incoming-call-buttons" });
    buttons.appendChild(join);
    buttons.appendChild(dismissBtn);
    card.appendChild(buttons);
    this.appendChild(card);
  }

  /* ------------------------------ ring tone ------------------------------ */

  private _startRing(): void {
    this._stopRing();
    this._ringing = false;
    /* the classic two-tone ring: 440+480 Hz for 2s, 1s of silence */
    this._ringTimer = setInterval(() => {
      this._ringing = !this._ringing;
      if (this._ringing) this._toneOn();
      else this._toneOff();
    }, 1_500);
    this._ringing = true;
    this._toneOn();
  }

  private _stopRing(): void {
    if (this._ringTimer) clearInterval(this._ringTimer);
    this._ringTimer = null;
    this._toneOff();
    if (this._audioCtx) {
      void this._audioCtx.close().catch(() => {});
      this._audioCtx = null;
    }
  }

  private _toneOn(): void {
    this._toneOff();
    try {
      if (!this._audioCtx) this._audioCtx = new AudioContext();
      void this._audioCtx.resume().catch(() => {});
      const ctx = this._audioCtx;
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      osc1.frequency.value = 440;
      osc2.frequency.value = 480;
      gain.gain.value = 0.08; /* audible, not obnoxious */
      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);
      osc1.start();
      osc2.start();
      (this as unknown as { _liveOscs: OscillatorNode[] })._liveOscs = [osc1, osc2];
      (this as unknown as { _liveGain: GainNode })._liveGain = gain;
    } catch {
      /* no audio (headless / autoplay policy) — the banner still shows */
    }
  }

  private _toneOff(): void {
    const self = this as unknown as {
      _liveOscs?: OscillatorNode[];
      _liveGain?: GainNode;
    };
    if (self._liveOscs) {
      for (const osc of self._liveOscs) {
        try {
          osc.stop();
        } catch {
          /* already stopped */
        }
      }
      self._liveOscs = undefined;
      self._liveGain = undefined;
    }
  }
}

customElements.define("incoming-call", IncomingCall);

declare global {
  interface HTMLElementTagNameMap {
    "incoming-call": IncomingCall;
  }
}
