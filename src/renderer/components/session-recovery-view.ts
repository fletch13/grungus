import { el } from "./ui.ts";

/** Post-login choice. Protocol work stays in the application controller. */
export class SessionRecoveryView extends HTMLElement {
  private mode: "choose" | "restore" | "reset" = "choose";
  private busy = false;
  show(): void { this.busy = false; this.hidden = false; this.render(); }
  hide(): void { this.hidden = true; this.classList.remove("call-overlay"); this.replaceChildren(); }
  private render(): void {
    this.classList.add("call-overlay");
    const card = el("form", { class: "backup-card", role: "dialog", "aria-modal": "true", "aria-label": "Recover encrypted history" });
    card.append(el("h2", { text: "Verify this session" }), el("p", { class: "verify-phase", text: "Use another signed-in device or your recovery passphrase/security key to access encrypted history." }));
    const status = el("p", { role: "status", "aria-live": "polite" });
    const button = (label: string, action: () => void): void => {
      const b = el("button", { type: "button", class: "call-btn", text: label });
      b.addEventListener("click", action); card.append(b);
    };
    if (this.mode === "choose") {
      button("Verify with another device", () => this.dispatchEvent(new CustomEvent("session-device")));
      button("Use recovery passphrase or key", () => { this.mode = "restore"; this.render(); });
      button("I cannot recover my keys", () => { this.mode = "reset"; this.render(); });
      button("Skip for now", () => this.hide());
    } else {
      const reset = this.mode === "reset";
      if (reset) card.append(el("p", { class: "verify-phase", text: "Reset deletes the current server backup and its stored backup secret. History whose keys exist only in that backup cannot be recovered. Keys on your devices remain. Your account must support password sign-in." }));
      const input = el("input", { class: "backup-pass", type: "password", required: "", autocomplete: reset ? "current-password" : "off", "aria-label": reset ? "Account password" : "Recovery passphrase or key", placeholder: reset ? "Account password" : "Recovery passphrase or key" }) as HTMLInputElement;
      card.append(input);
      if (reset) {
        const label = el("label", { text: "I understand that unrecovered history may be lost. " });
        label.append(el("input", { type: "checkbox", required: "", "aria-label": "Confirm backup deletion" })); card.append(label);
      }
      card.append(el("button", { type: "submit", class: reset ? "call-btn danger" : "call-btn", text: reset ? "Confirm password and delete backup" : "Recover history" }));
      button("Back", () => { this.mode = "choose"; this.render(); });
      card.addEventListener("submit", (event) => {
        event.preventDefault();
        if (this.busy) return;
        this.dispatchEvent(new CustomEvent(reset ? "session-reset" : "session-restore", { detail: input.value }));
        input.value = "";
      });
    }
    card.append(status); this.replaceChildren(card);
    queueMicrotask(() => card.querySelector<HTMLElement>("input, button")?.focus());
  }
  setStatus(message: string, busy = false): void {
    this.busy = busy;
    this.querySelector<HTMLElement>('[role="status"]')!.textContent = message;
    this.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach(control => { control.disabled = busy; });
  }
}
customElements.define("session-recovery-view", SessionRecoveryView);
declare global { interface HTMLElementTagNameMap { "session-recovery-view": SessionRecoveryView; } }
