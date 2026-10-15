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

  update(states: SasUiState[], manager: VerificationManager): void {
    this._states = states;
    this._manager = manager;
    this._render();
  }

  private _render(): void {
    const manager = this._manager;
    this.textContent = "";
    if (!manager || this._states.length === 0) return;

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

    for (const state of this._states) {
      const card = el("div", { class: "verify-card" });
      const peer = `${mxidLocalpart(state.peerUserId)} (${state.peerDeviceId.slice(0, 10)}…)`;

      card.appendChild(el("div", { class: "verify-peer", text: peer }));
      card.appendChild(
        el("div", { class: "verify-phase", text: this._phaseText(state.phase, state.error) })
      );

      if (state.emoji.length > 0 && state.phase === "show-emoji") {
        card.appendChild(el("div", { class: "verify-emoji", text: state.emoji.join(" ") }));
        const buttons = el("div", { class: "call-footer" });
        const match = el("button", { class: "call-btn", text: "They match" });
        match.addEventListener("click", () => {
          void manager.transactions
            .find((txn) => txn.transactionId === state.transactionId)
            ?.confirmEmojiMatch();
        });
        const reject = el("button", { class: "call-btn danger", text: "They don't match" });
        reject.addEventListener("click", () => {
          card.replaceChildren(
            el("div", { class: "verify-phase", text: "Rejected — devices not verified." })
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
