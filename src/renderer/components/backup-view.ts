/*
 * Grungus — <backup-view>: key backup create/restore overlay.
 *
 * One card, two modes: create a passphrase-protected server-side backup
 * of this device's megolm sessions, or restore an existing backup (e.g.
 * after an SSO login on a fresh machine) to recover encrypted history.
 */
import { el } from "./ui.ts";
import type { E2eeCrypto } from "../services/e2ee.ts";

export class BackupView extends HTMLElement {
  private _crypto: E2eeCrypto | null = null;
  private _serverHasBackup: boolean | null = null;
  private _mode: "choose" | "create" | "restore" | "status" = "choose";
  private _status = "";
  private _statusError = false;

  update(crypto: E2eeCrypto | null, serverHasBackup: boolean | null): void {
    this._crypto = crypto;
    this._serverHasBackup = serverHasBackup;
    this._render();
  }

  show(): void {
    this.hidden = false;
    this._mode = "choose";
    this._status = "";
    this._render();
  }

  hide(): void {
    this.hidden = true;
  }

  private _render(): void {
    this.textContent = "";
    if (this.hidden) return;
    this.classList.add("call-overlay");

    const card = el("div", { class: "backup-card" });
    card.appendChild(el("div", { class: "verify-peer", text: "🔑 Key backup" }));

    if (this._mode === "choose") {
      card.appendChild(
        el("div", {
          class: "verify-phase",
          text:
            this._serverHasBackup === null
              ? "Checking the server for an existing backup…"
              : "Encrypted room history can be backed up to the server, protected by a passphrase you choose.",
        })
      );
      if (this._serverHasBackup === null) {
        this._renderStatus(card);
        this.appendChild(card);
        return;
      }
      const buttons = el("div", { class: "call-footer" });
      if (!this._serverHasBackup) {
        const createBtn = el("button", { class: "call-btn", text: "Create a backup" });
        createBtn.addEventListener("click", () => {
          this._mode = "create";
          this._render();
        });
        buttons.appendChild(createBtn);
      } else {
        const restoreBtn = el("button", { class: "call-btn", text: "Restore history" });
        restoreBtn.addEventListener("click", () => {
          this._mode = "restore";
          this._render();
        });
        buttons.appendChild(restoreBtn);
      }
      const closeBtn = el("button", { class: "call-btn danger", text: "Close" });
      closeBtn.addEventListener("click", () => this.hide());
      buttons.appendChild(closeBtn);
      card.appendChild(buttons);
      this._renderStatus(card);
      this.appendChild(card);
      return;
    }

    if (this._mode === "create" || this._mode === "restore") {
      const isCreate = this._mode === "create";
      const label = isCreate
        ? "Choose a passphrase (8+ characters) — it protects your backed-up keys and is needed to restore on other devices."
        : "Enter the passphrase this backup was created with.";
      card.appendChild(el("div", { class: "verify-phase", text: label }));

      const pass = el("input", {
        type: "password",
        class: "backup-pass",
        placeholder: "passphrase",
        autocomplete: "off",
      }) as HTMLInputElement;
      const confirm = el("input", {
        type: "password",
        class: "backup-pass2",
        placeholder: isCreate ? "repeat passphrase" : "",
        autocomplete: "off",
      }) as HTMLInputElement;
      card.appendChild(pass);
      if (isCreate) card.appendChild(confirm);

      const buttons = el("div", { class: "call-footer" });
      const go = el("button", { class: "call-btn", text: isCreate ? "Create backup" : "Restore" });
      go.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("grungus:backup-" + (isCreate ? "create" : "restore"), {
            detail: { passphrase: pass.value, confirm: confirm.value },
            bubbles: true,
          })
        );
      });
      const back = el("button", { class: "call-btn", text: "Back" });
      back.addEventListener("click", () => {
        this._mode = "choose";
        this._status = "";
        this._render();
      });
      buttons.appendChild(go);
      buttons.appendChild(back);
      card.appendChild(buttons);
      this._renderStatus(card);
      this.appendChild(card);
      return;
    }

    /* status mode */
    card.appendChild(
      el("div", { class: "verify-phase", text: this._status || "Done." })
    );
    const buttons = el("div", { class: "call-footer" });
    const closeBtn = el("button", { class: "call-btn", text: "Close" });
    closeBtn.addEventListener("click", () => this.hide());
    buttons.appendChild(closeBtn);
    card.appendChild(buttons);
    this._renderStatus(card);
    this.appendChild(card);
  }

  setStatus(message: string, isError: boolean): void {
    this._status = message;
    this._statusError = isError;
    this._render();
  }

  private _renderStatus(card: HTMLElement): void {
    if (!this._status) return;
    card.appendChild(
      el("div", {
        class: this._statusError ? "verify-phase" : "verify-phase",
        text: (this._statusError ? "⚠ " : "✓ ") + this._status,
      })
    );
  }
}

customElements.define("backup-view", BackupView);

declare global {
  interface HTMLElementTagNameMap {
    "backup-view": BackupView;
  }
}
