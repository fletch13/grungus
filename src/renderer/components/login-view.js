/*
 * Grungus — <login-view>: Matrix login card.
 * Emits "grungus:login" with { homeserver, username, password, accessToken }.
 * All actual client work happens in app.js.
 */
"use strict";

class LoginView extends HTMLElement {
  constructor() {
    super();
    this._busy = false;
    this._tokenMode = false;
  }

  connectedCallback() {
    this._render();
  }

  setBusy(busy) {
    this._busy = busy;
    var btn = this.querySelector(".btn-primary");
    if (btn) btn.disabled = busy;
    this.querySelectorAll(".field input").forEach(function (input) {
      input.disabled = busy;
    });
  }

  setStatus(message, isError) {
    var status = this.querySelector(".login-status");
    if (!status) return;
    status.textContent = message || "";
    status.classList.toggle("info", !isError);
  }

  _render() {
    var self = this;
    this.textContent = "";
    this.classList.add("login-root");

    var form = el("form", { class: "login-card", novalidate: true });

    form.appendChild(el("h1", { class: "login-logo", text: "Grungus" }));
    form.appendChild(
      el("p", {
        class: "login-sub",
        text: "A Discord-style chat client for the Matrix network.",
      })
    );

    var homeserverInput = el("input", {
      type: "text",
      id: "login-homeserver",
      value: "matrix.org",
      autocomplete: "url",
      spellcheck: "false",
    });
    var hsField = el("div", { class: "field" });
    hsField.appendChild(el("label", { for: "login-homeserver", text: "Homeserver" }));
    hsField.appendChild(homeserverInput);
    hsField.appendChild(
      el("div", {
        class: "hint",
        text: "The Element-protocol server you log in to — e.g. matrix.org, or your own.",
      })
    );
    form.appendChild(hsField);

    var userInput = el("input", {
      type: "text",
      id: "login-username",
      autocomplete: "username",
      spellcheck: "false",
      placeholder: this._tokenMode ? "" : "e.g. alice:matrix.org or alice",
    });
    var passInput = el("input", {
      type: "password",
      id: "login-password",
      autocomplete: "current-password",
      placeholder: "••••••••",
    });
    var tokenInput = el("input", {
      type: "password",
      id: "login-token",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "access token (syt_… / syj_… / MDAx…)",
    });

    if (!this._tokenMode) {
      var userField = el("div", { class: "field" });
      userField.appendChild(el("label", { for: "login-username", text: "Username" }));
      userField.appendChild(userInput);
      form.appendChild(userField);

      var passField = el("div", { class: "field" });
      passField.appendChild(el("label", { for: "login-password", text: "Password" }));
      passField.appendChild(passInput);
      form.appendChild(passField);
    } else {
      var tokenField = el("div", { class: "field" });
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

    var submit = el(
      "button",
      { class: "btn-primary", type: "submit", disabled: this._busy },
      "Log In"
    );
    form.appendChild(submit);
    form.appendChild(el("div", { class: "login-status" }));

    var toggle = el("div", { class: "login-toggle" });
    var toggleLink = el(
      "a",
      { text: this._tokenMode ? "Log in with password instead" : "Log in with an access token instead" }
    );
    toggle.appendChild(toggleLink);
    form.appendChild(toggle);

    toggleLink.addEventListener("click", function () {
      self._tokenMode = !self._tokenMode;
      self._render();
    });

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      if (self._busy) return;
      self.dispatchEvent(
        new CustomEvent("grungus:login", {
          detail: {
            homeserver: homeserverInput.value.trim(),
            username: userInput.value.trim(),
            password: passInput.value,
            accessToken: self._tokenMode ? tokenInput.value.trim() : null,
          },
          bubbles: true,
        })
      );
    });

    this.appendChild(form);
  }
}

customElements.define("login-view", LoginView);
