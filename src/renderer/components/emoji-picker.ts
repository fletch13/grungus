import { el } from "./ui.ts";

import { EMOJIS, EMOJI_GROUPS } from "../services/emoji-catalog.ts";

export class EmojiPicker extends HTMLElement {
  private category = "All";
  private limit = 192;
  private search!: HTMLInputElement;
  private grid!: HTMLElement;
  private opener: HTMLElement | null = null;
  private outside = (event: PointerEvent): void => {
    if (!this.hidden && !this.contains(event.target as Node) && !this.opener?.contains(event.target as Node)) this.close(false);
  };
  connectedCallback(): void {
    this.hidden = true;
    this.classList.add("emoji-picker");
    this.setAttribute("role", "dialog");
    this.setAttribute("aria-label", "Choose an emoji");
    document.addEventListener("pointerdown", this.outside);
    this.addEventListener("keydown", this.onKey);
  }
  disconnectedCallback(): void {
    document.removeEventListener("pointerdown", this.outside);
    this.removeEventListener("keydown", this.onKey);
  }
  private onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); }
  };
  toggle(opener: HTMLElement): void { if (this.hidden) this.open(opener); else this.close(); }
  open(opener: HTMLElement): void {
    this.opener = opener;
    this.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    this.category = "All"; this.limit = 192;
    const header = el("div", { class: "emoji-picker-header" });
    header.append(el("strong", { text: "Emoji" }));
    const close = el("button", { type: "button", text: "✕", "aria-label": "Close emoji picker" });
    close.addEventListener("click", () => this.close()); header.append(close);
    this.search = el("input", { type: "search", placeholder: "Search emojis…", "aria-label": "Search emojis", autocomplete: "off" }) as HTMLInputElement;
    this.search.addEventListener("input", () => { this.limit = 192; this.results(); });
    const categories = el("div", { class: "emoji-categories", "aria-label": "Emoji categories" });
    for (const name of ["All", ...EMOJI_GROUPS]) {
      const button = el("button", { type: "button", text: name, "aria-pressed": name === this.category ? "true" : "false" });
      button.addEventListener("click", () => {
        this.category = name; this.limit = 192;
        categories.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b === button)));
        this.results();
      }); categories.append(button);
    }
    this.grid = el("div", { class: "emoji-grid", "aria-label": "Emojis" });
    this.replaceChildren(header, this.search, categories, this.grid);
    this.results(); this.search.focus();
  }
  close(focus = true): void {
    this.hidden = true;
    this.opener?.setAttribute("aria-expanded", "false");
    if (focus) this.opener?.focus();
  }
  private results(): void {
    const query = this.search.value.toLocaleLowerCase().trim().replaceAll(":", "");
    const entries = EMOJIS.filter(entry => (this.category === "All" || entry.category === this.category) && `${entry.emoji} ${entry.search}`.includes(query));
    this.grid.replaceChildren(...entries.slice(0, this.limit).map(entry => {
      const button = el("button", { type: "button", text: entry.emoji, title: entry.name, "aria-label": entry.name });
      button.addEventListener("click", () => {
        this.dispatchEvent(new CustomEvent("emoji-select", { detail: { emoji: entry.emoji } }));
        this.close(false);
      }); return button;
    }));
    if (entries.length > this.limit) {
      const more = el("button", { type: "button", class: "emoji-more", text: "More emojis", "aria-label": "Load more emojis" });
      more.addEventListener("click", () => { this.limit += 192; this.results(); });
      this.grid.append(more);
    }
    if (!entries.length) this.grid.append(el("p", { class: "emoji-empty", role: "status", text: "No matching emojis." }));
  }
}
customElements.define("emoji-picker", EmojiPicker);
declare global { interface HTMLElementTagNameMap { "emoji-picker": EmojiPicker; } }
