/*
 * Grungus — <call-view>: full-screen call overlay.
 * Local + remote tiles, mute toggle, hangup, connection state per peer.
 */
import { el } from "./ui.ts";
import { CallManager, type CallUiState, type CallParticipant } from "../services/calls.ts";

export class CallView extends HTMLElement {
  private _state: CallUiState | null = null;
  private _manager: CallManager | null = null;
  /** key -> video element, reused across renders to avoid flicker. */
  private _videos = new Map<string, HTMLVideoElement>();

  connectedCallback(): void {
    this._render();
  }

  update(state: CallUiState, manager: CallManager): void {
    this._state = state;
    this._manager = manager;
    this._render();
  }

  private _render(): void {
    const state = this._state;
    const manager = this._manager;
    this.textContent = "";

    if (!state || !state.active || !manager) return;

    this.classList.add("call-overlay");

    const header = el("div", { class: "call-header" });
    header.appendChild(el("span", { class: "call-title", text: "Call" }));
    if (state.notice) {
      header.appendChild(el("span", { class: "call-notice", text: state.notice }));
    }
    this.appendChild(header);

    const grid = el("div", { class: "call-grid" });

    /* local tile */
    grid.appendChild(this._buildTile("local", "You", manager.localStream, "local", state.localMuted));

    /* remote tiles */
    for (const participant of state.participants) {
      grid.appendChild(
        this._buildTile(
          participant.key,
          participant.name,
          participant.stream,
          participant.connectionState,
          false
        )
      );
    }

    if (state.participants.length === 0) {
      grid.appendChild(
        el("div", { class: "call-empty", text: "Waiting for others to join…" })
      );
    }

    this.appendChild(grid);

    const footer = el("div", { class: "call-footer" });
    const mute = el(
      "button",
      { class: "call-btn" + (state.localMuted ? " muted" : ""), text: state.localMuted ? "Unmute" : "Mute" }
    );
    mute.addEventListener("click", () => {
      manager.setMuted(!state.localMuted);
    });
    const hangUp = el("button", { class: "call-btn danger", text: "Hang up" });
    hangUp.addEventListener("click", () => {
      void manager.hangUp();
    });
    footer.appendChild(mute);
    footer.appendChild(hangUp);
    this.appendChild(footer);
  }

  private _buildTile(
    key: string,
    name: string,
    stream: MediaStream | null,
    status: string,
    muted: boolean
  ): HTMLElement {
    const tile = el("div", { class: "call-tile" });

    let video = this._videos.get(key);
    if (!video) {
      video = document.createElement("video");
      video.autoplay = true;
      video.playsInline = true;
      this._videos.set(key, video);
    }
    if (stream && video.srcObject !== stream) {
      video.srcObject = stream;
      /* autoplay is unreliable (backgrounded tabs observed paused) — start
         playback explicitly; muted/allowed cases resolve immediately */
      void video.play().catch(() => {
        /* autoplay policy: will start on the next user interaction */
      });
    }
    if (key === "local") video.muted = true; /* avoid echo of the local stream */
    tile.appendChild(video);

    const label = el("div", { class: "call-tile-label" });
    label.appendChild(el("span", { class: "call-tile-name", text: name }));
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
