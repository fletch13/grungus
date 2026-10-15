/*
 * Grungus — <login-view>: two-step Matrix login.
 *
 * Step 1 asks for the homeserver domain. The app then queries the
 * server's real login flows (GET /login) and hands them to step 2 via
 * showFlows(), which renders exactly what that server offers: SSO
 * providers (e.g. a university Keycloak) as buttons, plus password and
 * access-token modes. Events: "grungus:server-chosen" {homeserver},
 * "grungus:sso" {idpId}, "grungus:login" with LoginDetail.
 */
import { el } from "./ui.ts";
import type { LoginFlow, SsoIdentityProvider } from "../services/matrix-client.ts";

export interface LoginDetail {
  homeserver: string;
  username: string;
  password: string;
  accessToken: string | null;
}

export class LoginView extends HTMLElement {
  private _busy = false;
  private _tokenMode = false;
  /** step 2 state, once the server's flows are known */
  private _flows: LoginFlow[] | null = null;
  private _baseUrl: string | null = null;
  private _homeserverInput = "matrix.org";

  connectedCallback(): void {
    this._render();
  }

  setBusy(busy: boolean): void {
    this._busy = busy;
    this._render();
  }

  setStatus(message: string, isError: boolean): void {
    const status = this.querySelector<HTMLElement>(".login-status");
    if (!status) return;
    status.textContent = message;
    status.classList.toggle("info", !isError);
  }

  /** Move to step 2 with the flows the server advertised. */
  showFlows(baseUrl: string, flows: LoginFlow[]): void {
    this._baseUrl = baseUrl;
    this._flows = flows;
    this._render();
  }

  /** Back to step 1 (e.g. after an error). */
  showServerStep(): void {
    this._flows = null;
    this._baseUrl = null;
    this._render();
  }

  private _ssoProviders(): SsoIdentityProvider[] {
    const flow = this._flows?.find((entry) => entry.type === "m.login.sso");
    return flow?.identity_providers ?? [];
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

    if (!this._flows) {
      this._renderServerStep(form);
    } else {
      this._renderCredentialStep(form);
    }

    form.appendChild(el("div", { class: "login-status" }));
    this.appendChild(form);
  }

  /* ---- step 1: which server? ---- */

  private _renderServerStep(form: HTMLFormElement): void {
    const hsInput = el("input", {
      type: "text",
      id: "login-homeserver",
      value: this._homeserverInput,
      autocomplete: "url",
      spellcheck: "false",
      disabled: this._busy ? "" : null,
    }) as HTMLInputElement;

    const hsField = el("div", { class: "field" });
    hsField.appendChild(el("label", { for: "login-homeserver", text: "Homeserver" }));
    hsField.appendChild(hsInput);
    hsField.appendChild(
      el("div", {
        class: "hint",
        text: "The Matrix server you log in to — e.g. matrix.org, or your university's.",
      })
    );
    form.appendChild(hsField);

    form.appendChild(
      el("button", { class: "btn-primary", type: "submit", disabled: this._busy ? "" : null },
        this._busy ? "Connecting…" : "Continue")
    );

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this._busy) return;
      const value = hsInput.value.trim();
      if (!value) return;
      this._homeserverInput = value;
      this.dispatchEvent(
        new CustomEvent("grungus:server-chosen", {
          detail: { homeserver: value },
          bubbles: true,
        })
      );
    });
  }

  /* ---- step 2: the modes this server offers ---- */

  private _renderCredentialStep(form: HTMLFormElement): void {
    const host = this._baseUrl
      ? new URL(this._baseUrl).host
      : "your homeserver";
    form.appendChild(
      el("p", {
        class: "login-server-title",
        text: `Sign in to ${host}`,
      })
    );

    /* SSO providers (Keycloak & friends) — each opens the redirect flow */
    const providers = this._ssoProviders();
    for (const provider of providers) {
      const btn = el("button", {
        class: "btn-sso",
        type: "button",
        disabled: this._busy ? "" : null,
        text: provider.name
          ? `Continue with ${provider.name}`
          : "Continue with single sign-on",
      });
      btn.addEventListener("click", () => {
        if (this._busy) return;
        this.dispatchEvent(
          new CustomEvent("grungus:sso", {
            detail: { idpId: provider.id },
            bubbles: true,
          })
        );
      });
      form.appendChild(btn);
    }
    if (providers.length > 0 && this._hasPasswordFlow()) {
      form.appendChild(el("div", { class: "login-divider", text: "or" }));
    }

    const userInput = el("input", {
      type: "text",
      id: "login-username",
      autocomplete: "username",
      spellcheck: "false",
      placeholder: this._tokenMode ? "" : "e.g. alice:matrix.org or alice",
      disabled: this._busy ? "" : null,
    }) as HTMLInputElement;
    const passInput = el("input", {
      type: "password",
      id: "login-password",
      autocomplete: "current-password",
      placeholder: "••••••••",
      disabled: this._busy ? "" : null,
    }) as HTMLInputElement;
    const tokenInput = el("input", {
      type: "password",
      id: "login-token",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "access token (syt_… / syj_… / MDAx…)",
      disabled: this._busy ? "" : null,
    }) as HTMLInputElement;

    if (this._tokenMode) {
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
    } else if (this._hasPasswordFlow()) {
      const userField = el("div", { class: "field" });
      userField.appendChild(el("label", { for: "login-username", text: "Username" }));
      userField.appendChild(userInput);
      form.appendChild(userField);

      const passField = el("div", { class: "field" });
      passField.appendChild(el("label", { for: "login-password", text: "Password" }));
      passField.appendChild(passInput);
      form.appendChild(passField);
    } else {
      /* server offers neither password nor SSO — a raw token is the only way */
      this._tokenMode = true;
      const tokenField = el("div", { class: "field" });
      tokenField.appendChild(el("label", { for: "login-token", text: "Access token" }));
      tokenField.appendChild(tokenInput);
      form.appendChild(tokenField);
    }

    form.appendChild(
      el("button", { class: "btn-primary", type: "submit", disabled: this._busy ? "" : null },
        this._tokenMode ? "Use Token" : "Log In")
    );

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

    const back = el("div", { class: "login-toggle" });
    const backLink = el("a", { text: "← use a different homeserver" });
    back.appendChild(backLink);
    form.appendChild(back);
    backLink.addEventListener("click", () => {
      this.showServerStep();
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this._busy) return;
      this.dispatchEvent(
        new CustomEvent<LoginDetail>("grungus:login", {
          detail: {
            homeserver: this._baseUrl ?? this._homeserverInput,
            username: userInput.value.trim(),
            password: passInput.value,
            accessToken: this._tokenMode ? tokenInput.value.trim() : null,
          },
          bubbles: true,
        })
      );
    });
  }

  private _hasPasswordFlow(): boolean {
    return !!this._flows?.some((flow) => flow.type === "m.login.password");
  }
}

customElements.define("login-view", LoginView);

declare global {
  interface HTMLElementTagNameMap {
    "login-view": LoginView;
  }
}
