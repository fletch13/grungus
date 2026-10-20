import { VoiceActivityMonitor } from "../services/voice-activity.ts";
import { prepareBackground } from "../services/background.ts";
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
import { sharedKlipyApiKey } from "../services/gif-config.ts";
import { el } from "./ui.ts";
import type { MatrixClient } from "../services/matrix-client.ts";
import type { SettingsStore, GrungusSettings } from "../services/settings.ts";
import type { UserInfo } from "./room-list.ts";

type PanelId =
  | "account"
  | "sessions"
  | "security"
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
  private _deviceLogoutBusy = false;
  private _ignored: string[] = [];
  private _token = "";
  private _backgroundBusy = false;
  private _avatarMxc: string | null = null;
  private _displayName = "";
  private _query = "";
  private _opener: HTMLElement | null = null;
  private _loadSequence = 0;
  private _backupStatus = "Not checked";
  private _previewStream: MediaStream | null = null;
  private _previewSequence = 0;
  private _previewMonitor: VoiceActivityMonitor | null = null;
  private _stopPreview(): void {
    this._previewSequence++; this._previewStream?.getTracks().forEach(track => track.stop()); this._previewStream = null;
    this._previewMonitor?.stop(); this._previewMonitor = null;
  }
  disconnectedCallback(): void { this._stopPreview(); this._loadSequence++; }
  constructor() {
    super();
    this.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); this.hide(); }
      if (event.key === "Tab") {
        const controls = [...this.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')].filter(node => node.getClientRects().length);
        const target = event.shiftKey ? controls.at(-1) : controls[0];
        if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); target?.focus(); }
      }
    });
  }

  private static readonly NAV: { id: PanelId; label: string }[] = [
    { id: "account", label: "My Account" },
    { id: "sessions", label: "Sessions" },
    { id: "security", label: "Security & Privacy" },
    { id: "appearance", label: "Appearance" },
    { id: "preferences", label: "Preferences" },
    { id: "notifications", label: "Notifications" },
    { id: "voice", label: "Voice & Video" },
    { id: "ignored", label: "Ignored Users" },
    { id: "advanced", label: "Advanced" },
    { id: "about", label: "Help & About" },
  ];

  private static readonly KEYWORDS: Record<PanelId, string> = {
    account: "profile display name avatar password logout",
    sessions: "devices rename login active sessions last seen",
    security: "security privacy encryption recovery backup verify session keys",
    appearance: "theme system dark light font size compact background picture",
    preferences: "typing read receipts markdown timestamps scrolling enter gifs klipy",
    notifications: "notifications permission sound preview message desktop test",
    voice: "microphone speaker camera audio video device test preview",
    ignored: "ignored blocked users unignore",
    advanced: "access token homeserver device cache clear media",
    about: "version help about keyboard shortcuts",
  };

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
    this._opener = document.activeElement as HTMLElement | null;
    this._query = "";
    this.hidden = false;
    this.classList.add("settings-overlay");
    this._panel = panel;
    this._status = "";
    this._statusError = false;
    this._render();
    this.querySelector<HTMLButtonElement>(".settings-close-btn")?.focus();
    void this._loadPanelData();
  }

  hide(): void {
    /* the overlay class carries display:flex — [hidden] loses to it */
    this._stopPreview(); this._loadSequence++;
    this.classList.remove("settings-overlay");
    this.hidden = true;
    this.textContent = "";
    this._opener?.focus();
  }

  private async _loadPanelData(): Promise<void> {
    const client = this._client;
    if (!client) return;
    const sequence = ++this._loadSequence;
    const [devices, profile, backup] = await Promise.allSettled([
      client.getDevices(),
      client.userId ? client.getProfile(client.userId) : Promise.resolve(null),
      this._panel === "security" && client.crypto ? client.crypto.getKeyBackupVersion() : Promise.resolve(undefined),
    ]);
    if (sequence !== this._loadSequence || this.hidden || client !== this._client) return;
    if (devices.status === "fulfilled") this._devices = devices.value;
    this._ignored = client.getIgnoredUsers();
    if (profile.status === "fulfilled" && profile.value) {
      this._avatarMxc = profile.value.avatar_url ?? this._avatarMxc;
      this._displayName = profile.value.displayname ?? this._displayName;
    }
    if (this._panel === "security") this._backupStatus = !client.crypto ? "Encryption is unavailable for this session" : backup.status === "rejected" ? "Could not check the server backup" : backup.value ? "A recovery backup is available on the server" : "No recovery backup is configured";
    this._render();
  }

  private _setStatus(text: string, isError = false): void {
    this._status = text;
    this._statusError = isError;
    this._render();
  }

  private _render(): void {
    this._stopPreview();
    const active = this.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const activeLabel = active?.getAttribute("aria-label");
    const selection = active instanceof HTMLInputElement && ["text", "search", "password"].includes(active.type) ? [active.selectionStart, active.selectionEnd] : null;
    const oldPanel = this.querySelector<HTMLElement>(".settings-panel");
    const position = oldPanel?.dataset.panel === this._panel ? oldPanel.scrollTop : 0;
    const drafts = new Map<string, string>();
    if (oldPanel?.dataset.panel === this._panel) for (const input of oldPanel.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="password"]')) {
      const key = input.getAttribute("aria-label") || input.placeholder || input.id;
      if (key) drafts.set(key, input.value);
    }
    this.textContent = "";
    if (this.hidden) return;

    const wrap = el("div", { class: "settings-frame", role: "dialog", "aria-modal": "true", "aria-label": "Settings" });

    /* header */
    const header = el("div", { class: "settings-header" });
    header.appendChild(el("span", { class: "settings-title", text: "Settings" }));
    const close = el("button", { class: "overlay-close-btn settings-close-btn", text: "✕", title: "Close settings" });
    close.setAttribute("aria-label", "Close settings");
    close.addEventListener("click", () => this.hide());
    header.appendChild(close);
    const search = el("input", { class: "settings-input settings-search", type: "search", placeholder: "Search settings", "aria-label": "Search settings", value: this._query }) as HTMLInputElement;
    search.addEventListener("input", () => { this._query = search.value; this._render(); });
    header.append(search);
    wrap.appendChild(header);

    const body = el("div", { class: "settings-body" });

    /* nav */
    const nav = el("nav", { class: "settings-nav" });
    for (const item of SettingsView.NAV) {
      const btn = el("button", {
        class: "settings-nav-btn" + (this._panel === item.id ? " active" : ""),
        text: item.label,
        "aria-current": this._panel === item.id && !this._query ? "page" : undefined,
      });
      btn.addEventListener("click", () => {
        this._stopPreview(); this._query = "";
        this._panel = item.id;
        this._status = "";
        this._render();
        void this._loadPanelData();
      });
      nav.appendChild(btn);
    }
    body.appendChild(nav);

    /* panel */
    const panel = el("div", { class: "settings-panel", dataset: { panel: this._panel } });
    if (this._query.trim()) {
      const query = this._query.trim().toLocaleLowerCase();
      const matches = SettingsView.NAV.filter(item => `${item.label} ${SettingsView.KEYWORDS[item.id]}`.toLocaleLowerCase().includes(query));
      panel.append(this._section("Search results", `${matches.length} matching sections`));
      for (const item of matches) {
        const result = el("button", { type: "button", class: "settings-search-result", text: item.label });
        result.addEventListener("click", () => { this._query = ""; this._panel = item.id; this._render(); void this._loadPanelData(); });
        panel.append(result);
      }
      if (!matches.length) panel.append(el("p", { text: "No settings found. Try another word." }));
    } else switch (this._panel) {
      case "account":
        this._renderAccount(panel);
        break;
      case "sessions":
        this._renderSessions(panel);
        break;
      case "security":
        this._renderSecurity(panel);
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
        el("div", { class: "settings-status" + (this._statusError ? " error" : ""), role: "status", "aria-live": "polite", text: this._status })
      );
    }
    this.appendChild(wrap);
    panel.scrollTop = position;
    for (const input of panel.querySelectorAll<HTMLInputElement>('input[type="text"], input[type="password"]')) {
      const key = input.getAttribute("aria-label") || input.placeholder || input.id;
      if (drafts.has(key)) input.value = drafts.get(key)!;
    }
    if (activeLabel) {
      const control = [...this.querySelectorAll<HTMLElement>("[aria-label]")].find(node => node.getAttribute("aria-label") === activeLabel);
      control?.focus();
      if (selection && control instanceof HTMLInputElement) control.setSelectionRange(selection[0] ?? null, selection[1] ?? null);
    }
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
      placeholder: "Display name", "aria-label": "Display name",
    }) as HTMLInputElement;
    nameRow.appendChild(nameInput);
    const saveName = el("button", { class: "call-btn", text: "Save" });
    saveName.addEventListener("click", () => {
      const value = nameInput.value.trim();
      if (!value) return;
      void client
        .setDisplayName(value)
        .then(() => { this._displayName = value; this._setStatus("Display name saved."); })
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
      const current = currentPw.value; const replacement = newPw.value;
      currentPw.value = ""; newPw.value = ""; newPw2.value = "";
      void client
        .changePassword(current, replacement, logoutBox.checked)
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
            (device.lastSeenTs ? `  ·  ${new Date(device.lastSeenTs).toLocaleString()}` : "") + (device.lastSeenIp ? `  ·  ${device.lastSeenIp}` : ""),
        })
      );
      row.appendChild(meta);

      if (isCurrent) {
        const rename = el("button", { class: "call-btn", text: "Rename" });
        rename.addEventListener("click", () => {
          if (row.querySelector("form")) return;
          this._loadSequence++;
          const form = el("form", { class: "settings-row", "aria-label": "Rename this session" });
          const input = el("input", { class: "settings-input", value: device.displayName ?? "", required: true, maxlength: "100", "aria-label": "Session name" }) as HTMLInputElement;
          const save = el("button", { type: "submit", class: "call-btn", text: "Save session name" });
          const cancel = el("button", { type: "button", class: "call-btn", text: "Cancel" });
          cancel.addEventListener("click", () => { form.remove(); rename.focus(); });
          form.addEventListener("submit", event => {
            event.preventDefault(); const name = input.value.trim(); if (!name) return;
            form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach(control => { control.disabled = true; });
            void client.setDeviceName(device.deviceId, name).then(() => this._loadPanelData()).then(() => this._setStatus("Device renamed.")).catch(error => this._setStatus(`Rename failed: ${error instanceof Error ? error.message : "unknown error"}`, true));
          });
          form.append(input, save, cancel); row.append(form); input.focus();
        });
        row.appendChild(rename);
      } else {
        const kick = el("button", { class: "call-btn danger", text: "Log out" });
        (kick as HTMLButtonElement).disabled = this._deviceLogoutBusy;
        kick.addEventListener("click", () => {
          if (row.querySelector("form") || this._deviceLogoutBusy) return;
          this._loadSequence++;
          const form = el("form", { class: "device-logout-form", "aria-label": `Log out ${device.displayName ?? device.deviceId}` });
          const label = el("label", { text: "Account password" });
          const password = el("input", {
            class: "settings-input", type: "password", autocomplete: "current-password",
            required: true, "aria-label": "Account password",
          }) as HTMLInputElement;
          label.append(password);
          const confirm = el("button", { type: "submit", class: "call-btn danger", text: "Confirm logout" });
          const cancel = el("button", { type: "button", class: "call-btn", text: "Cancel" });
          cancel.addEventListener("click", () => { password.value = ""; form.remove(); kick.focus(); });
          form.append(label, confirm, cancel);
          form.addEventListener("submit", event => {
            event.preventDefault();
            if (this._deviceLogoutBusy || !password.value) return;
            this._deviceLogoutBusy = true;
            const value = password.value;
            password.value = "";
            form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach(control => { control.disabled = true; });
            void client.deleteDevices([device.deviceId], value).then(async () => {
              this._devices = this._devices.filter(entry => entry.deviceId !== device.deviceId);
              await this._loadPanelData();
              this._deviceLogoutBusy = false;
              this._setStatus("Device logged out.");
            }).catch((err: unknown) => {
              this._deviceLogoutBusy = false;
              this._setStatus(`Logout failed: ${err instanceof Error ? err.message : "error"}`, true);
            });
          });
          row.append(form);
          password.focus();
        });
        row.appendChild(kick);
      }
      panel.appendChild(row);
    }
  }

  private _renderSecurity(panel: HTMLElement): void {
    const client = this._client;
    panel.append(this._section("Security & Privacy", "Manage recovery and verify your other sessions."));
    panel.append(this._staticRow("Encryption", client?.crypto ? "End-to-end encryption is available. Each conversation shows its own encryption status." : "Encryption is not available for this session."));
    panel.append(this._staticRow("Recovery backup", this._backupStatus));
    const backup = el("button", { type: "button", class: "call-btn", text: "Manage recovery backup", disabled: !client?.crypto });
    backup.addEventListener("click", () => this._dispatch("grungus:open-backup"));
    const verify = el("button", { type: "button", class: "call-btn", text: "Verify this session", disabled: !client?.crypto });
    verify.addEventListener("click", () => this._dispatch("grungus:verify-session"));
    const sessions = el("button", { type: "button", class: "call-btn", text: "Review sessions" });
    sessions.addEventListener("click", () => { this._panel = "sessions"; this._render(); void this._loadPanelData(); });
    panel.append(el("div", { class: "settings-row" }, backup, verify, sessions));
    panel.append(el("p", { class: "settings-hint", text: "Recovery helps restore encrypted history. Verification confirms a device belongs to you; a server backup alone does not verify a session." }));
    const settings = this._settings!;
    panel.append(this._toggle("Read receipts", "Send read receipts", "sendReadReceipts", settings));
    panel.append(this._toggle("Typing", "Send typing notifications", "sendTypingNotifications", settings));
  }

  /* ------------------------------- appearance ----------------------------- */

  private _renderAppearance(panel: HTMLElement): void {
    const settings = this._settings!;
    panel.appendChild(this._section("Appearance"));

    /* theme */
    const themeRow = el("div", { class: "settings-row" });
    for (const theme of ["dark", "light", "system"] as const) {
      const radio = el("label", { class: "settings-check" });
      const box = el("input", { type: "radio", name: "theme", value: theme }) as HTMLInputElement;
      box.checked = settings.get("theme") === theme;
      box.addEventListener("change", () => settings.set("theme", theme));
      radio.appendChild(box);
      radio.appendChild(el("span", { text: theme === "dark" ? "Dark" : theme === "light" ? "Light" : "Use system theme" }));
      themeRow.appendChild(radio);
    }
    panel.appendChild(this._labeledRow("Theme", themeRow));
    const background = el("div", { class: "settings-col background-settings" });
    const image = settings.get("backgroundImage");
    if (image) background.append(el("img", { class: "background-preview", src: image, alt: "Your custom background" }));
    const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/avif", class: "hidden-file-input", "aria-label": "Background picture", disabled: this._backgroundBusy }) as HTMLInputElement;
    const choose = el("button", { type: "button", class: "call-btn", text: this._backgroundBusy ? "Saving picture…" : image ? "Change background picture" : "Choose background picture", disabled: this._backgroundBusy });
    choose.addEventListener("click", () => file.click());
    file.addEventListener("change", () => {
      const selected = file.files?.[0];
      if (!selected || this._backgroundBusy) return;
      this._backgroundBusy = true; this._render();
      void prepareBackground(selected).then(value => {
        settings.set("backgroundImage", value);
        this._status = "Background saved on this device."; this._statusError = false;
      }).catch(error => {
        this._status = `Could not save background: ${error instanceof Error ? error.message : "unknown error"}`; this._statusError = true;
      }).finally(() => { this._backgroundBusy = false; this._render(); });
    });
    const controls = el("div", { class: "settings-row" }, choose, file);
    if (image) {
      const remove = el("button", { type: "button", class: "call-btn", text: "Remove background", disabled: this._backgroundBusy });
      remove.addEventListener("click", () => {
        try { settings.set("backgroundImage", ""); this._setStatus("Background removed."); }
        catch { this._setStatus("Could not remove the saved background. Please try again.", true); }
      });
      controls.append(remove);
    }
    background.append(controls, el("p", { class: "settings-hint", text: "Choose a picture to enable translucent panels with clear outlines and a lightly blurred background. Saved only on this device; never uploaded. Images up to 20 MB are resized automatically." }));
    panel.append(this._labeledRow("Background picture", background));


    /* font size */
    const fontRow = el("div", { class: "settings-row" });
    const slider = el("input", { type: "range", "aria-label": "Font size", min: "85", max: "130", step: "5" }) as HTMLInputElement;
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
    const gifs = el("form", { class: "settings-row" });
    const keyLabel = el("label", { for: "klipy-api-key", text: "Personal KLIPY API key (optional override)" });
    const key = el("input", { id: "klipy-api-key", class: "settings-input", type: "password", autocomplete: "off", placeholder: sharedKlipyApiKey ? "Using the shared application key" : "Your KLIPY API key" }) as HTMLInputElement;
    key.value = settings.get("klipyApiKey");
    gifs.append(keyLabel, key, el("button", { type: "submit", class: "call-btn", text: "Save GIF settings" }));
    gifs.append(el("p", { class: "settings-hint", text: sharedKlipyApiKey ? "A shared KLIPY key is included in this build. Leave this field empty to use it. A personal override is saved on this device." : "Enter your own KLIPY key, or configure a shared key when building the app. Searches connect directly to KLIPY. Get a key at partner.klipy.com." }));
    gifs.addEventListener("submit", event => { event.preventDefault(); settings.set("klipyApiKey", key.value.trim()); });
    panel.append(gifs);


    panel.appendChild(
      this._toggle(
        "Typing",
        "Send typing notifications",
        "sendTypingNotifications",
        settings,
        "Others see when you are typing. Turning it off hides nothing on your side."
      )
    );
    panel.append(this._toggle("Typing", "Show other people’s typing indicators", "showTypingIndicator", settings));
    panel.appendChild(
      this._toggle(
        "Read receipts",
        "Send read receipts",
        "sendReadReceipts",
        settings,
        "Others can see when you have read messages."
      )
    );
    panel.appendChild(
      this._toggle("Messages", "Enter sends (Shift+Enter newline)", "enterToSend", settings)
    );
    panel.appendChild(this._toggle("Messages", "Show message timestamps", "showTimestamps", settings));
    panel.appendChild(
      this._toggle("Messages", "Render markdown formatting", "renderMarkdown", settings, "Show bold, italic, code, strikethrough, and Markdown links in messages.")
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
    panel.append(this._toggle("Privacy", "Show message previews in notifications", "notificationPreviews", settings, "Turn off to hide sender, room, and message text from desktop notifications."));
    const supported = typeof Notification !== "undefined";
    panel.append(this._staticRow("Desktop permission", supported ? Notification.permission : "Notifications are unavailable"));
    const controls = el("div", { class: "settings-row" });
    const permission = el("button", { type: "button", class: "call-btn", text: "Enable desktop permission", disabled: !supported || Notification.permission === "granted" });
    permission.addEventListener("click", () => {
      void Notification.requestPermission().then(value => this._setStatus(value === "granted" ? "Desktop notifications are allowed." : "Notifications are blocked. Enable them in your browser or operating system settings.", value !== "granted")).catch(() => this._setStatus("Could not request notification permission.", true));
    });
    const test = el("button", { type: "button", class: "call-btn", text: "Send test notification", disabled: !supported || Notification.permission !== "granted" });
    test.addEventListener("click", () => {
      try { new Notification("Grungus", { body: "Your desktop notifications are working.", silent: !settings.get("notificationSound") }); this._setStatus("Test notification sent."); }
      catch { this._setStatus("Could not show a notification. Check system permissions.", true); }
    });
    controls.append(permission, test); panel.append(controls);
  }

  /* ------------------------------ voice & video --------------------------- */

  private _renderVoice(panel: HTMLElement): void {
    const settings = this._settings!;
    panel.appendChild(this._section("Voice & Video", "Choose devices for your next call. Speaker changes also apply during an active call."));

    const groups: { kind: MediaDeviceKind; label: string; setting: "audioInput" | "audioOutput" | "videoInput" }[] = [
      { kind: "audioinput", label: "Microphone", setting: "audioInput" },
      { kind: "audiooutput", label: "Speaker", setting: "audioOutput" },
      { kind: "videoinput", label: "Camera", setting: "videoInput" },
    ];
    /* the selects are appended synchronously; device enumeration fills
       them asynchronously so a later re-render cannot orphan them */
    const selects: HTMLSelectElement[] = [];
    for (const group of groups) {
      const select = el("select", { class: "settings-input", "aria-label": group.label }) as HTMLSelectElement;
      select.appendChild(el("option", { value: "", text: `System default (${group.label})` }));
      select.value = settings.get(group.setting);
      select.addEventListener("change", () => settings.set(group.setting, select.value));
      selects.push(select);
      panel.appendChild(this._labeledRow(group.label, select));
    }
    if (!navigator.mediaDevices?.enumerateDevices) { panel.append(el("p", { class: "settings-hint", text: "Media devices are unavailable in this context." })); return; }
    const refresh = el("button", { type: "button", class: "call-btn", text: "Refresh devices" });
    refresh.addEventListener("click", () => this._render());
    const microphone = el("button", { type: "button", class: "call-btn", text: "Test microphone" });
    const camera = el("button", { type: "button", class: "call-btn", text: "Test camera" });
    const stop = el("button", { type: "button", class: "call-btn", text: "Stop preview", hidden: true });
    const status = el("p", { role: "status", class: "settings-hint", text: "Test devices here before joining a call. Nothing is sent to other users." });
    const video = el("video", { class: "settings-camera-preview", autoplay: true, playsinline: true, hidden: true }) as HTMLVideoElement;
    video.muted = true;
    stop.addEventListener("click", () => { this._stopPreview(); video.srcObject = null; video.hidden = true; stop.hidden = true; microphone.removeAttribute("disabled"); camera.removeAttribute("disabled"); status.textContent = "Preview stopped."; });
    const preview = async (kind: "microphone" | "camera"): Promise<void> => {
      this._stopPreview(); const sequence = this._previewSequence;
      microphone.setAttribute("disabled", ""); camera.setAttribute("disabled", ""); status.textContent = "Requesting device access…";
      try {
        const id = settings.get(kind === "microphone" ? "audioInput" : "videoInput");
        const constraint = id ? { deviceId: { exact: id } } : true;
        const stream = await navigator.mediaDevices.getUserMedia({ audio: kind === "microphone" ? constraint : false, video: kind === "camera" ? constraint : false });
        if (sequence !== this._previewSequence || this.hidden || !panel.isConnected) { stream.getTracks().forEach(track => track.stop()); return; }
        this._previewStream = stream; stop.hidden = false;
        if (kind === "camera") { video.hidden = false; video.srcObject = stream; await video.play(); status.textContent = "Camera preview stays on this device."; }
        else {
          this._previewMonitor = new VoiceActivityMonitor(active => { status.textContent = active.has("test") ? "Microphone activity detected" : "Listening — speak to test your microphone. Audio is not played back."; });
          this._previewMonitor.setStreams([{ key: "test", stream }]);
        }
      } catch (error) {
        if (sequence !== this._previewSequence) return;
        this._stopPreview(); video.srcObject = null; video.hidden = true; stop.hidden = true;
        microphone.removeAttribute("disabled"); camera.removeAttribute("disabled"); status.textContent = `Device test failed: ${error instanceof Error ? error.message : "unknown error"}`;
      }
    };
    microphone.addEventListener("click", () => { void preview("microphone"); }); camera.addEventListener("click", () => { void preview("camera"); });
    panel.append(el("div", { class: "settings-row" }, refresh, microphone, camera, stop), status, video);
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
          const selected = settings.get(group.setting);
          if (selected && ![...select.options].some(option => option.value === selected)) select.append(el("option", { value: selected, text: "Saved device (unavailable)" }));
          select.value = selected;
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
    const clear = el("button", { type: "button", class: "call-btn", text: "Clear downloaded media" });
    clear.addEventListener("click", () => {
      client.clearMediaCache();
      this._setStatus("Downloaded media cleared. Your session, preferences, and encryption keys were kept.");
    });
    cacheRow.append(clear);
    panel.append(this._labeledRow("Media cache", cacheRow, "Removes cached images and avatars. They download again when needed; you stay logged in."));
  }

  /* ------------------------------- help & about ---------------------------- */

  private _renderAbout(panel: HTMLElement): void {
    panel.appendChild(this._section("Help & About", "Grungus — a Discord-style chat client for the Matrix network."));
    panel.appendChild(this._staticRow("App version", (window as unknown as { GRUNGUS_VERSION?: string }).GRUNGUS_VERSION ?? "dev"));
    panel.append(this._section("Keyboard shortcuts"), this._staticRow("Send message", "Enter (or Ctrl/Cmd+Enter if Enter-to-send is off)"), this._staticRow("New line", "Shift+Enter"), this._staticRow("Close settings or pickers", "Escape"));
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
    const check = el("input", { type: "checkbox", "aria-label": text }) as HTMLInputElement;
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
