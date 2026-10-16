/*
 * Grungus — <verify-view>: SAS verification overlay.
 * One card per active transaction: emoji once ready, "They match" /
 * "Reject" buttons, live phase status. Incoming requests are accepted
 * automatically (the emoji comparison is still the human checkpoint).
 */
import { el } from "./ui.ts";
import type { SasUiState, VerificationManager } from "../services/sas.ts";
import { mxidLocalpart } from "../services/matrix-client.ts";

export class VerifyView extends HTMLElement {
  private _states: SasUiState[] = [];
  private _manager: VerificationManager | null = null;
  private _sessionMode = false;
  private _sessionRequested = false;

  update(states: SasUiState[], manager: VerificationManager): void {
    this._states = states;
    this._manager = manager;
    this._render();
  }

  /** Show the "verify this session" entry card (footer 🛡). */
  setSessionMode(on: boolean): void {
    this._sessionMode = on;
    this._render();
  }

  markSessionRequested(): void {
    this._sessionRequested = true;
    this._render();
  }

  private _render(): void {
    const manager = this._manager;
    this.textContent = "";
    const hasCards = this._states.length > 0 || (this._sessionMode && !this._sessionRequested);
    if (!manager || !hasCards) return;

    this.classList.add("call-overlay");

    const header = el("div", { class: "call-header" });
    header.appendChild(el("span", { class: "call-title", text: "Verify devices" }));
    header.appendChild(
      el("span", {
        class: "call-notice",
        text: "Compare the emoji with the other device",
      })
    );
    this.appendChild(header);

    /* session-verification entry card (opened from the sidebar) */
    if (this._sessionMode && !this._sessionRequested) {
      const card = el("div", { class: "verify-card" });
      card.appendChild(el("div", { class: "verify-peer", text: "This device" }));
      card.appendChild(
        el("div", {
          class: "verify-phase",
          text: "Ask your other devices to verify this session (emoji comparison).",
        })
      );
      const buttons = el("div", { class: "call-footer" });
      const go = el("button", { class: "call-btn", text: "Verify my other devices" });
      go.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("grungus:request-session-verify", { bubbles: true })
        );
      });
      buttons.appendChild(go);
      card.appendChild(buttons);
      this.appendChild(card);
    }

    for (const state of this._states) {
      const card = el("div", { class: "verify-card" });
      const peer = `${mxidLocalpart(state.peerUserId)} (${state.peerDeviceId.slice(0, 10)}…)`;

      card.appendChild(el("div", { class: "verify-peer", text: peer }));
      card.appendChild(
        el("div", { class: "verify-phase", text: this._phaseText(state.phase, state.error) })
      );

      /* an incoming request waits for THIS user to accept — never
         auto-accept silently; the human decides */
      if (state.phase === "requested" && !state.initiatedByMe) {
        card.appendChild(
          el("div", {
            class: "verify-phase",
            text: "wants to be verified",
          })
        );
        const buttons = el("div", { class: "call-footer" });
        const accept = el("button", { class: "call-btn", text: "Verify" });
        accept.addEventListener("click", () => {
          this.dispatchEvent(
            new CustomEvent("grungus:accept-verify", {
              detail: { transactionId: state.transactionId },
              bubbles: true,
            })
          );
        });
        const ignore = el("button", { class: "call-btn danger", text: "Ignore" });
        ignore.addEventListener("click", () => {
          this.dispatchEvent(
            new CustomEvent("grungus:decline-verify", {
              detail: { transactionId: state.transactionId },
              bubbles: true,
            })
          );
        });
        buttons.appendChild(accept);
        buttons.appendChild(ignore);
        card.appendChild(buttons);
        this.appendChild(card);
        continue;
      }

      if (state.emoji.length > 0 && state.phase === "show-emoji") {
        card.appendChild(el("div", { class: "verify-emoji", text: state.emoji.join(" ") }));
        const buttons = el("div", { class: "call-footer" });
        const match = el("button", { class: "call-btn", text: "They match" });
        match.addEventListener("click", () => {
          this.dispatchEvent(
            new CustomEvent("grungus:confirm-sas", {
              detail: { transactionId: state.transactionId },
              bubbles: true,
            })
          );
        });
        const reject = el("button", { class: "call-btn danger", text: "They don't match" });
        reject.addEventListener("click", () => {
          this.dispatchEvent(
            new CustomEvent("grungus:decline-verify", {
              detail: { transactionId: state.transactionId },
              bubbles: true,
            })
          );
        });
        buttons.appendChild(match);
        buttons.appendChild(reject);
        card.appendChild(buttons);
      }

      this.appendChild(card);
    }
  }

  private _phaseText(phase: SasUiState["phase"], error: string | null): string {
    if (error) return error;
    switch (phase) {
      case "requested":
        return "Waiting for the other device…";
      case "started":
        return "Exchanging keys…";
      case "keys-exchanged":
      case "show-emoji":
        return "Compare the emoji:";
      case "mac-sent":
        return "Waiting for their confirmation…";
      case "verified":
        return "✅ Device verified";
      case "cancelled":
        return "Cancelled";
      default:
        return phase;
    }
  }
}

customElements.define("verify-view", VerifyView);

declare global {
  interface HTMLElementTagNameMap {
    "verify-view": VerifyView;
  }
}
