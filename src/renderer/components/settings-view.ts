/*
 * Grungus — <settings-view>: the user settings overlay.
 *
 * Opened by the ⚙ cogwheel next to the name in the sidebar (Discord-style
 * placement, Element-style contents). Left nav, panel content on the
 * right, ✕ close — the same overlay conventions as the other views.
 *
 * Panels (Element's standard set, adapted to what Grungus speaks):
 *   My Account     — display name, avatar, password change, log out
 *   Sessions       — device list, rename this device, log out others
 *   Appearance     — theme (dark/light), font size, compact mode
 *   Preferences    — typing, read receipts, Enter-to-send, timestamps
 *   Notifications  — desktop notifications + sound
 *   Voice & Video   — microphone / camera / speaker pickers
 *   Ignored Users  — list + unignore
 *   Advanced       — access token reveal, device id, homeserver, cache
 *   Help & About   — version + stack
 */
import { el } from "./ui.ts";
import type { MatrixClient } from "../services/matrix-client.ts";
import type { SettingsStore, GrungusSettings } from "../services/settings.ts";
import type { UserInfo } from "./room-list.ts";

type PanelId =
  | "account"
  | "sessions"
  | "appearance"
  | "preferences"
  | "notifications"
  | "voice"
  | "ignored"
  | "advanced"
  | "about";

interface DeviceRow {
  deviceId: string;
  displayName: string | null;
  lastSeenTs: number | null;
  lastSeenIp: string | null;
}

export class SettingsView extends HTMLElement {
  private _client: MatrixClient | null = null;
  private _settings: SettingsStore | null = null;
  private _panel: PanelId = "account";
  private _status = "";
  private _statusError = false;
  private _devices: DeviceRow[] = [];
  private _ignored: string[] = [];
  private _token = "";
  private _avatarMxc: string | null = null;
  private _displayName = "";

  private static readonly NAV: { id: PanelId; label: string }[] = [
    { id: "account", label: "My Account" },
    { id: "sessions", label: "Sessions" },
    { id: "appearance", label: "Appearance" },
    { id: "preferences", label: "Preferences" },
    { id: "notifications", label: "Notifications" },
    { id: "voice", label: "Voice & Video" },
    { id: "ignored", label: "Ignored Users" },
    { id: "advanced", label: "Advanced" },
    { id: "about", label: "Help & About" },
  ];

  connectedCallback(): void {
    if (!this.hidden) this.classList.add("settings-overlay");
  }

  update(client: MatrixClient | null, settings: SettingsStore, user: UserInfo | null): void {
    this._client = client;
    this._settings = settings;
    this._token = client?.accessToken ?? "";
    this._avatarMxc = user?.avatarMxc ?? null;
    this._displayName = user?.displayname ?? "";
    this._render();
  }

  show(panel: PanelId = "account"): void {
    this.hidden = false;
    this.classList.add("settings-overlay");
    this._panel = panel;
    this._status = "";
    this._statusError = false;
    this._render();
    void this._loadPanelData();
  }

  hide(): void {
    /* the overlay class carries display:flex — [hidden] loses to it */
    this.classList.remove("settings-overlay");
    this.hidden = true;
    this.textContent = "";
  }

  private async _loadPanelData(): Promise<void> {
    const client = this._client;
    if (!client) return;
    try {
      this._devices = await client.getDevices();
      this._ignored = client.getIgnoredUsers();
      if (client.userId) {
        const profile = await client.getProfile(client.userId);
        this._avatarMxc = profile.avatar_url ?? this._avatarMxc;
        this._displayName = profile.displayname ?? this._displayName;
      }
      this._render();
    } catch (err) {
      console.warn("[settings] panel data load failed:", err);
    }
  }

  private _setStatus(text: string, isError = false): void {
    this._status = text;
    this._statusError = isError;
    this._render();
  }

  private _render(): void {
    this.textContent = "";
    if (this.hidden) return;

    const wrap = el("div", { class: "settings-frame" });

    /* header */
    const header = el("div", { class: "settings-header" });
    header.appendChild(el("span", { class: "settings-title", text: "Settings" }));
    const close = el("button", { class: "overlay-close-btn settings-close-btn", text: "✕", title: "Close settings" });
    close.addEventListener("click", () => this.hide());
    header.appendChild(close);
    wrap.appendChild(header);

    const body = el("div", { class: "settings-body" });

    /* nav */
    const nav = el("nav", { class: "settings-nav" });
    for (const item of SettingsView.NAV) {
      const btn = el("button", {
        class: "settings-nav-btn" + (this._panel === item.id ? " active" : ""),
        text: item.label,
      });
      btn.addEventListener("click", () => {
        this._panel = item.id;
        this._status = "";
        this._render();
        void this._loadPanelData();
      });
      nav.appendChild(btn);
    }
    body.appendChild(nav);

    /* panel */
    const panel = el("div", { class: "settings-panel" });
    switch (this._panel) {
      case "account":
        this._renderAccount(panel);
        break;
      case "sessions":
        this._renderSessions(panel);
        break;
      case "appearance":
        this._renderAppearance(panel);
        break;
      case "preferences":
        this._renderPreferences(panel);
        break;
      case "notifications":
        this._renderNotifications(panel);
        break;
      case "voice":
        this._renderVoice(panel);
        break;
      case "ignored":
        this._renderIgnored(panel);
        break;
      case "advanced":
        this._renderAdvanced(panel);
        break;
      case "about":
        this._renderAbout(panel);
        break;
    }
    body.appendChild(panel);
    wrap.appendChild(body);

    if (this._status) {
      wrap.appendChild(
        el("div", { class: "settings-status" + (this._statusError ? " error" : ""), text: this._status })
      );
    }
    this.appendChild(wrap);
  }

  /* ------------------------------ my account ----------------------------- */

  private _renderAccount(panel: HTMLElement): void {
    const client = this._client;
    if (!client || !client.userId) {
      panel.appendChild(el("div", { class: "settings-empty", text: "Not logged in." }));
      return;
    }

    panel.appendChild(this._section("My Account", `${client.userId}`));

    /* display name */
    const nameRow = el("div", { class: "settings-row" });
    const nameInput = el("input", {
      class: "settings-input",
      type: "text",
      value: this._displayName,
      placeholder: "Display name",
    }) as HTMLInputElement;
    nameRow.appendChild(nameInput);
    const saveName = el("button", { class: "call-btn", text: "Save" });
    saveName.addEventListener("click", () => {
      const value = nameInput.value.trim();
      if (!value) return;
      void client
        .setDisplayName(value)
        .then(() => this._setStatus("Display name saved."))
        .catch((err: unknown) =>
          this._setStatus(`Could not save: ${err instanceof Error ? err.message : "error"}`, true)
        );
    });
    nameRow.appendChild(saveName);
    panel.appendChild(this._labeledRow("Display name", nameRow));

    /* avatar */
    const avatarRow = el("div", { class: "settings-row" });
    const file = el("input", { type: "file", accept: "image/*", class: "hidden-file-input" }) as HTMLInputElement;
    const pick = el("button", { class: "call-btn", text: "Upload avatar" });
    pick.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const f = file.files?.[0];
      if (!f) return;
      void f
        .arrayBuffer()
        .then((buf) => client.uploadMedia(f.name, f.type, new Uint8Array(buf)))
        .then((mxc) => client.setAvatarUrl(mxc))
        .then(() => this._setStatus("Avatar updated."))
        .catch((err: unknown) =>
          this._setStatus(`Could not upload: ${err instanceof Error ? err.message : "error"}`, true)
        );
    });
    avatarRow.appendChild(pick);
    avatarRow.appendChild(file);
    panel.appendChild(this._labeledRow("Avatar", avatarRow));

    /* change password */
    panel.appendChild(this._section("Change password"));
    const pwForm = el("div", { class: "settings-col" });
    const currentPw = el("input", {
      class: "settings-input",
      type: "password",
      placeholder: "Current password",
    }) as HTMLInputElement;
    const newPw = el("input", {
      class: "settings-input",
      type: "password",
      placeholder: "New password",
    }) as HTMLInputElement;
    const newPw2 = el("input", {
      class: "settings-input",
      type: "password",
      placeholder: "Repeat new password",
    }) as HTMLInputElement;
    const logoutOthers = el("label", { class: "settings-check" });
    const logoutBox = el("input", { type: "checkbox" }) as HTMLInputElement;
    logoutBox.checked = true; /* Element's default for password changes */
    logoutOthers.appendChild(logoutBox);
    logoutOthers.appendChild(el("span", { text: "Log out all other sessions" }));
    const changeBtn = el("button", { class: "call-btn", text: "Change password" });
    changeBtn.addEventListener("click", () => {
      if (!newPw.value || newPw.value !== newPw2.value) {
        this._setStatus("The new passwords do not match.", true);
        return;
      }
      void client
        .changePassword(currentPw.value, newPw.value, logoutBox.checked)
        .then(() => this._setStatus("Password changed."))
        .catch((err: unknown) =>
          this._setStatus(`Could not change: ${err instanceof Error ? err.message : "error"}`, true)
        );
    });
    pwForm.appendChild(currentPw);
    pwForm.appendChild(newPw);
    pwForm.appendChild(newPw2);
    pwForm.appendChild(logoutOthers);
    pwForm.appendChild(changeBtn);
    panel.appendChild(pwForm);

    /* log out */
    panel.appendChild(this._section("Log out"));
    const logout = el("button", { class: "call-btn danger", text: "Log out" });
    logout.addEventListener("click", () => {
      this._dispatch("grungus:logout");
    });
    panel.appendChild(logout);
  }

  /* -------------------------------- sessions ------------------------------ */

  private _renderSessions(panel: HTMLElement): void {
    const client = this._client;
    if (!client) return;
    panel.appendChild(
      this._section("Sessions", `Devices logged into this account (${this._devices.length})`)
    );

    for (const device of this._devices) {
      const row = el("div", { class: "settings-row device-row" });
      const isCurrent = device.deviceId === client.deviceId;
      const meta = el("div", { class: "settings-col" });
      meta.appendChild(
        el("div", {
          class: "device-name",
          text: (device.displayName ?? "(unnamed)") + (isCurrent ? "  (this device)" : ""),
        })
      );
      meta.appendChild(
        el("div", {
          class: "device-meta",
          text:
            `${device.deviceId}` +
            (device.lastSeenTs ? `  ·  ${new Date(device.lastSeenTs).toLocaleString()}` : ""),
        })
      );
      row.appendChild(meta);

      if (isCurrent) {
        const rename = el("button", { class: "call-btn", text: "Rename" });
        rename.addEventListener("click", () => {
          const name = window.prompt("New name for this device", device.displayName ?? "");
          if (!name) return;
          void client
            .setDeviceName(device.deviceId, name)
            .then(() => this._loadPanelData())
            .then(() => this._setStatus("Device renamed."))
            .catch((err: unknown) =>
              this._setStatus(`Rename failed: ${err instanceof Error ? err.message : "error"}`, true)
            );
        });
        row.appendChild(rename);
      } else {
        const kick = el("button", { class: "call-btn danger", text: "Log out" });
        kick.addEventListener("click", () => {
          const pw = window.prompt("Account password (to log out the device)", "");
          if (!pw) return;
          void client
            .deleteDevices([device.deviceId], pw)
            .then(() => this._loadPanelData())
            .then(() => this._setStatus("Device logged out."))
            .catch((err: unknown) =>
              this._setStatus(`Failed: ${err instanceof Error ? err.message : "error"}`, true)
            );
        });
        row.appendChild(kick);
      }
      panel.appendChild(row);
    }
  }

  /* ------------------------------- appearance ----------------------------- */

  private _renderAppearance(panel: HTMLElement): void {
    const settings = this._settings!;
    panel.appendChild(this._section("Appearance"));

    /* theme */
    const themeRow = el("div", { class: "settings-row" });
    for (const theme of ["dark", "light"] as const) {
      const radio = el("label", { class: "settings-check" });
      const box = el("input", { type: "radio", name: "theme", value: theme }) as HTMLInputElement;
      box.checked = settings.get("theme") === theme;
      box.addEventListener("change", () => settings.set("theme", theme));
      radio.appendChild(box);
      radio.appendChild(el("span", { text: theme === "dark" ? "Dark" : "Light" }));
      themeRow.appendChild(radio);
    }
    panel.appendChild(this._labeledRow("Theme", themeRow));

    /* font size */
    const fontRow = el("div", { class: "settings-row" });
    const slider = el("input", { type: "range", min: "85", max: "130", step: "5" }) as HTMLInputElement;
    slider.value = String(Math.round(settings.get("fontScale") * 100));
    const fontLabel = el("span", { class: "settings-hint", text: `${slider.value}%` });
    slider.addEventListener("input", () => {
      fontLabel.textContent = `${slider.value}%`;
      settings.set("fontScale", Number(slider.value) / 100);
    });
    fontRow.appendChild(slider);
    fontRow.appendChild(fontLabel);
    panel.appendChild(this._labeledRow("Font size", fontRow));

    /* compact */
    panel.appendChild(
      this._toggle("Message display", "Compact mode (denser messages)", "compact", settings)
    );
  }

  /* ------------------------------ preferences ----------------------------- */

  private _renderPreferences(panel: HTMLElement): void {
    const settings = this._settings!;
    panel.appendChild(this._section("Preferences"));

    panel.appendChild(
      this._toggle(
        "Typing",
        "Send typing notifications",
        "sendTypingNotifications",
        settings,
        "Others see when you are typing. Turning it off hides nothing on your side."
      )
    );
    panel.appendChild(
      this._toggle(
        "Read receipts",
        "Send read receipts",
        "sendReadReceipts",
        settings,
        "m.read receipts + the fully-read marker — others see when you have read a DM."
      )
    );
    panel.appendChild(
      this._toggle("Messages", "Enter sends (Shift+Enter newline)", "enterToSend", settings)
    );
    panel.appendChild(this._toggle("Messages", "Show message timestamps", "showTimestamps", settings));
    panel.appendChild(
      this._toggle("Messages", "Render markdown formatting", "renderMarkdown", settings)
    );
    panel.appendChild(
      this._toggle("Scrolling", "Auto-scroll to the newest message", "autoScroll", settings)
    );
  }

  /* ------------------------------ notifications --------------------------- */

  private _renderNotifications(panel: HTMLElement): void {
    const settings = this._settings!;
    panel.appendChild(this._section("Notifications"));
    panel.appendChild(
      this._toggle(
        "Desktop notifications",
        "Notify for new messages in unfocused rooms",
        "desktopNotifications",
        settings,
        "Uses the OS notification centre (works in the desktop app and in the browser)."
      )
    );
    panel.appendChild(this._toggle("Sounds", "Play a sound with notifications", "notificationSound", settings));
  }

  /* ------------------------------ voice & video --------------------------- */

  private _renderVoice(panel: HTMLElement): void {
    const settings = this._settings!;
    panel.appendChild(this._section("Voice & Video", "Media devices Grungus uses in calls."));

    const groups: { kind: MediaDeviceKind; label: string; setting: "audioInput" | "audioOutput" | "videoInput" }[] = [
      { kind: "audioinput", label: "Microphone", setting: "audioInput" },
      { kind: "audiooutput", label: "Speaker", setting: "audioOutput" },
      { kind: "videoinput", label: "Camera", setting: "videoInput" },
    ];
    /* the selects are appended synchronously; device enumeration fills
       them asynchronously so a later re-render cannot orphan them */
    const selects: HTMLSelectElement[] = [];
    for (const group of groups) {
      const select = el("select", { class: "settings-input" }) as HTMLSelectElement;
      select.appendChild(el("option", { value: "", text: `System default (${group.label})` }));
      select.value = settings.get(group.setting);
      select.addEventListener("change", () => settings.set(group.setting, select.value));
      selects.push(select);
      panel.appendChild(this._labeledRow(group.label, select));
    }
    void navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        for (let i = 0; i < groups.length; i++) {
          const group = groups[i]!;
          const select = selects[i]!;
          for (const device of devices.filter((d) => d.kind === group.kind)) {
            select.appendChild(
              el("option", {
                value: device.deviceId,
                text: device.label || `${group.label} ${device.deviceId.slice(0, 8)}`,
              })
            );
          }
          select.value = settings.get(group.setting);
        }
        if (devices.every((d) => !d.label)) {
          panel.appendChild(
            el("div", {
              class: "settings-hint",
              text: "Device names appear after camera/microphone permission is granted.",
            })
          );
        }
      })
      .catch(() => {
        panel.appendChild(
          el("div", { class: "settings-hint", text: "Media devices are unavailable in this context." })
        );
      });
  }

  /* ------------------------------ ignored users --------------------------- */

  private _renderIgnored(panel: HTMLElement): void {
    panel.appendChild(
      this._section("Ignored Users", `${this._ignored.length} ignored`)
    );
    if (this._ignored.length === 0) {
      panel.appendChild(el("div", { class: "settings-empty", text: "You have not ignored anyone." }));
      return;
    }
    const client = this._client!;
    for (const userId of this._ignored) {
      const row = el("div", { class: "settings-row" });
      row.appendChild(el("span", { text: userId }));
      const un = el("button", { class: "call-btn danger", text: "Unignore" });
      un.addEventListener("click", () => {
        void client
          .unignoreUser(userId)
          .then(() => this._loadPanelData())
          .then(() => this._setStatus(`${userId} unignored.`))
          .catch((err: unknown) =>
            this._setStatus(`Failed: ${err instanceof Error ? err.message : "error"}`, true)
          );
      });
      row.appendChild(un);
      panel.appendChild(row);
    }
  }

  /* --------------------------------- advanced ----------------------------- */

  private _renderAdvanced(panel: HTMLElement): void {
    const client = this._client;
    if (!client) return;
    panel.appendChild(this._section("Advanced"));

    const tokenRow = el("div", { class: "settings-row" });
    const tokenSpan = el("span", { class: "settings-token", text: "•••••••••••••••• (hidden)" });
    const reveal = el("button", { class: "call-btn", text: "Reveal access token" });
    let revealed = false;
    reveal.addEventListener("click", () => {
      revealed = !revealed;
      tokenSpan.textContent = revealed ? this._token : "•••••••••••••••• (hidden)";
      reveal.textContent = revealed ? "Hide access token" : "Reveal access token";
    });
    tokenRow.appendChild(tokenSpan);
    tokenRow.appendChild(reveal);
    panel.appendChild(this._labeledRow("Access token", tokenRow, "Grants full access to the account — never share it."));

    panel.appendChild(this._staticRow("Device ID", client.deviceId ?? ""));
    panel.appendChild(this._staticRow("Homeserver", client.baseUrl));

    const cacheRow = el("div", { class: "settings-row" });
    const clear = el("button", {
      class: "call-btn danger",
      text: "Reset device data & log out",
    });
    clear.addEventListener("click", () => {
      /*
       * The device's olm identity and the logged-in session are ONE unit:
       * wiping the identity while keeping the session leaves a device the
       * server still maps to the OLD keys (every self-share fails with
       * OLM.BAD_MESSAGE_KEY_ID and the sender's own messages turn UTD).
       * So this ALWAYS drops the session too — the next login mints a
       * fresh device id with a matching identity.
       */
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("grungus-crypto:")) localStorage.removeItem(key);
      }
      localStorage.removeItem("grungus-session");
      location.reload();
    });
    cacheRow.appendChild(clear);
    panel.appendChild(
      this._labeledRow(
        "Reset device data",
        cacheRow,
        "Clears the device's encryption keys and logs you out. Log back in to get a fresh device (old rooms re-sync; encrypted history returns via key backup or forwarded keys)."
      )
    );
  }

  /* ------------------------------- help & about ---------------------------- */

  private _renderAbout(panel: HTMLElement): void {
    panel.appendChild(this._section("Help & About", "Grungus — a Discord-style chat client for the Matrix network."));
    panel.appendChild(this._staticRow("App version", (window as unknown as { GRUNGUS_VERSION?: string }).GRUNGUS_VERSION ?? "dev"));
    panel.appendChild(this._staticRow("Electron/Chrome", `${navigator.userAgent}`));
    panel.appendChild(
      this._staticRow(
        "Crypto",
        "Olm/Megolm end-to-end encryption, cross-signing, SSSS key backup, E2EE media"
      )
    );
    panel.appendChild(
      el("div", {
        class: "settings-hint",
        text: "Report problems through the project repository. Settings live in the ⚙ next to your name.",
      })
    );
  }

  /* -------------------------------- helpers ------------------------------- */

  private _section(title: string, subtitle?: string): HTMLElement {
    const head = el("div", { class: "settings-section" });
    head.appendChild(el("h2", { text: title }));
    if (subtitle) head.appendChild(el("div", { class: "settings-subtitle", text: subtitle }));
    return head;
  }

  private _labeledRow(label: string, content: HTMLElement, hint?: string): HTMLElement {
    const row = el("div", { class: "settings-labeled" });
    row.appendChild(el("div", { class: "settings-label", text: label }));
    row.appendChild(content);
    if (hint) row.appendChild(el("div", { class: "settings-hint", text: hint }));
    return row;
  }

  private _staticRow(label: string, value: string): HTMLElement {
    return this._labeledRow(label, el("div", { class: "settings-static", text: value }));
  }

  private _toggle(
    label: string,
    text: string,
    key: keyof GrungusSettings,
    settings: SettingsStore,
    hint?: string
  ): HTMLElement {
    const row = el("div", { class: "settings-row" });
    const check = el("input", { type: "checkbox" }) as HTMLInputElement;
    check.checked = Boolean(settings.get(key));
    check.addEventListener("change", () => {
      (settings.set as (k: keyof GrungusSettings, v: unknown) => void)(key, check.checked);
    });
    row.appendChild(check);
    row.appendChild(el("span", { class: "settings-toggle-text", text }));
    const labeled = this._labeledRow(label, row);
    if (hint) labeled.appendChild(el("div", { class: "settings-hint", text: hint }));
    return labeled;
  }

  private _dispatch(type: string): void {
    this.dispatchEvent(new CustomEvent(type, { bubbles: true }));
  }
}

if (!customElements.get("settings-view")) {
  customElements.define("settings-view", SettingsView);
}
