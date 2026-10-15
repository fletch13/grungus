/*
 * Grungus — <login-view>: Matrix login card.
 * Emits "grungus:login" with LoginDetail. All client work happens in app.ts.
 */
import { el } from "./ui.ts";

export interface LoginDetail {
  homeserver: string;
  username: string;
  password: string;
  accessToken: string | null;
}

export class LoginView extends HTMLElement {
  private _busy = false;
  private _tokenMode = false;

  connectedCallback(): void {
    this._render();
  }

  setBusy(busy: boolean): void {
    this._busy = busy;
    const btn = this.querySelector<HTMLButtonElement>(".btn-primary");
    if (btn) btn.disabled = busy;
    this.querySelectorAll<HTMLInputElement>(".field input").forEach((input) => {
      input.disabled = busy;
    });
  }

  setStatus(message: string, isError: boolean): void {
    const status = this.querySelector<HTMLElement>(".login-status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("info", !isError);
  }

  private _render(): void {
    this.textContent = "";

    const form = el("form", { class: "login-card", novalidate: true }) as HTMLFormElement;

    form.appendChild(el("h1", { class: "login-logo", text: "Grungus" }));
    form.appendChild(
      el("p", {
        class: "login-sub",
        text: "A Discord-style chat client for the Matrix network.",
      })
    );

    const homeserverInput = el("input", {
      type: "text",
      id: "login-homeserver",
      value: "matrix.org",
      autocomplete: "url",
      spellcheck: "false",
    }) as HTMLInputElement;

    const hsField = el("div", { class: "field" });
    hsField.appendChild(el("label", { for: "login-homeserver", text: "Homeserver" }));
    hsField.appendChild(homeserverInput);
    hsField.appendChild(
      el("div", {
        class: "hint",
        text: "The Element-protocol server you log in to — e.g. matrix.org, or your own.",
      })
    );
    form.appendChild(hsField);

    const userInput = el("input", {
      type: "text",
      id: "login-username",
      autocomplete: "username",
      spellcheck: "false",
      placeholder: this._tokenMode ? "" : "e.g. alice:matrix.org or alice",
    }) as HTMLInputElement;
    const passInput = el("input", {
      type: "password",
      id: "login-password",
      autocomplete: "current-password",
      placeholder: "••••••••",
    }) as HTMLInputElement;
    const tokenInput = el("input", {
      type: "password",
      id: "login-token",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "access token (syt_… / syj_… / MDAx…)",
    }) as HTMLInputElement;

    if (!this._tokenMode) {
      const userField = el("div", { class: "field" });
      userField.appendChild(el("label", { for: "login-username", text: "Username" }));
      userField.appendChild(userInput);
      form.appendChild(userField);

      const passField = el("div", { class: "field" });
      passField.appendChild(el("label", { for: "login-password", text: "Password" }));
      passField.appendChild(passInput);
      form.appendChild(passField);
    } else {
      const tokenField = el("div", { class: "field" });
      tokenField.appendChild(el("label", { for: "login-token", text: "Access token" }));
      tokenField.appendChild(tokenInput);
      tokenField.appendChild(
        el("div", {
          class: "hint",
          text: "Find it in Element: Settings → Help & About → Access Token.",
        })
      );
      form.appendChild(tokenField);
    }

    form.appendChild(
      el("button", { class: "btn-primary", type: "submit" }, "Log In")
    );
    form.appendChild(el("div", { class: "login-status" }));

    const toggle = el("div", { class: "login-toggle" });
    const toggleLink = el("a", {
      text: this._tokenMode
        ? "Log in with password instead"
        : "Log in with an access token instead",
    });
    toggle.appendChild(toggleLink);
    form.appendChild(toggle);

    toggleLink.addEventListener("click", () => {
      this._tokenMode = !this._tokenMode;
      this._render();
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this._busy) return;
      this.dispatchEvent(
        new CustomEvent<LoginDetail>("grungus:login", {
          detail: {
            homeserver: homeserverInput.value.trim(),
            username: userInput.value.trim(),
            password: passInput.value,
            accessToken: this._tokenMode ? tokenInput.value.trim() : null,
          },
          bubbles: true,
        })
      );
    });

    this.appendChild(form);
  }
}

customElements.define("login-view", LoginView);

declare global {
  interface HTMLElementTagNameMap {
    "login-view": LoginView;
  }
}
