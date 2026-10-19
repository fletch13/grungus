import { el } from "./ui.ts";
import type { MatrixClient } from "../services/matrix-client.ts";

export class NewDmView extends HTMLElement {
  private client: MatrixClient | null = null;
  private search!: HTMLInputElement;
  private status!: HTMLElement;
  private results!: HTMLElement;
  private direct!: HTMLButtonElement;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private sequence = 0;
  private busy = false;
  private opener: HTMLElement | null = null;
  constructor() {
    super();
    this.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); this.hide(); } });
  }
  show(client: MatrixClient): void {
    if (this.busy) return;
    this.cancelSearch();
    this.client = client; this.opener = document.activeElement as HTMLElement | null;
    this.hidden = false; this.classList.add("call-overlay");
    const card = el("div", { class: "backup-card new-dm-card", role: "dialog", "aria-modal": "true", "aria-label": "New direct message" });
    const close = el("button", { type: "button", class: "call-btn", text: "Close" });
    close.addEventListener("click", () => this.hide());
    const heading = el("div", { class: "emoji-picker-header" }, el("h2", { text: "New direct message" }), close);
    this.search = el("input", { type: "search", class: "settings-input", placeholder: "Name or @user:homeserver", "aria-label": "Search users", autocomplete: "off" }) as HTMLInputElement;
    this.status = el("p", { role: "status", "aria-live": "polite", text: "Search your homeserver’s user directory, or enter a full Matrix ID." });
    this.results = el("div", { class: "dm-search-results" });
    this.direct = el("button", { type: "button", class: "call-btn", hidden: true }) as HTMLButtonElement;
    this.direct.addEventListener("click", () => { void this.start(this.search.value.trim()); });
    this.search.addEventListener("input", () => {
      this.cancelSearch(); this.results.replaceChildren();
      const query = this.search.value.trim();
      this.direct.hidden = !/^@[^:\s]+:[^\s]+$/.test(query) || query === client.userId;
      this.direct.textContent = `Start chat with ${query}`;
      this.status.textContent = query ? "Searching…" : "Enter a name or full Matrix ID.";
      if (query) this.timer = setTimeout(() => { void this.find(query); }, 300);
    });
    card.append(heading, this.search, this.status, this.direct, this.results, el("p", { class: "settings-hint", text: "New conversations are encrypted. Search visibility depends on your homeserver." }));
    this.replaceChildren(card); this.search.focus();
  }
  private cancelSearch(): void {
    this.sequence++; this.controller?.abort(); this.controller = null;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
  }
  hide(): void {
    if (this.busy) return;
    this.cancelSearch(); this.hidden = true; this.classList.remove("call-overlay"); this.replaceChildren(); this.opener?.focus();
  }
  disconnectedCallback(): void { this.cancelSearch(); }
  private async find(query: string): Promise<void> {
    const sequence = this.sequence; this.controller = new AbortController();
    try {
      const page = await this.client!.searchUsers(query, this.controller.signal);
      if (sequence !== this.sequence || this.hidden) return;
      this.status.textContent = page.results.length ? page.limited ? "More users match. Refine your search." : "Select a person to start chatting." : "No users found. You can still enter a full Matrix ID.";
      this.results.replaceChildren(...page.results.map(user => {
        const button = el("button", { type: "button", class: "dm-search-result", "aria-label": `Message ${user.user_id}` });
        const avatar = document.createElement("g-avatar");
        avatar.update({ name: user.display_name || user.user_id, userId: user.user_id, size: 36, load: this.client!.avatarSrc(user.avatar_url, 36) });
        button.append(avatar, el("span", {}, el("strong", { text: user.display_name || user.user_id }), el("small", { text: user.user_id })));
        button.addEventListener("click", () => { void this.start(user.user_id); }); return button;
      }));
    } catch (error) {
      if (sequence === this.sequence && !this.hidden) this.status.textContent = `Search failed: ${error instanceof Error ? error.message : "unknown error"}. You can enter a full Matrix ID instead.`;
    }
  }
  private async start(userId: string): Promise<void> {
    if (this.busy || !this.client) return;
    this.busy = true; this.cancelSearch(); this.status.textContent = "Opening conversation…";
    this.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach(control => { control.disabled = true; });
    try {
      const roomId = await this.client.startDirectMessage(userId);
      this.busy = false; this.hide();
      this.dispatchEvent(new CustomEvent("grungus:dm-created", { detail: { roomId } }));
    } catch (error) {
      this.busy = false;
      this.status.textContent = `Could not start conversation: ${error instanceof Error ? error.message : "unknown error"}`;
      this.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach(control => { control.disabled = false; });
    }
  }
}
customElements.define("new-dm-view", NewDmView);
declare global { interface HTMLElementTagNameMap { "new-dm-view": NewDmView; } }
