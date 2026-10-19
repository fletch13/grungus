import { el } from "./ui.ts";
import { searchKlipy, type KlipyGif } from "../services/klipy.ts";

export class GifPicker extends HTMLElement {
  private key = "";
  private opener: HTMLElement | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sequence = 0;
  private search!: HTMLInputElement;
  private grid!: HTMLElement;
  private status!: HTMLElement;
  private more!: HTMLButtonElement;
  private next: number | null = null;
  private outside = (event: PointerEvent): void => {
    if (!this.hidden && !this.contains(event.target as Node) && !this.opener?.contains(event.target as Node)) this.close(false);
  };
  private keyboard = (event: KeyboardEvent): void => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); this.close(); }
  };
  connectedCallback(): void {
    this.hidden = true; this.classList.add("emoji-picker", "gif-picker");
    this.setAttribute("role", "dialog"); this.setAttribute("aria-label", "Choose a GIF");
    document.addEventListener("pointerdown", this.outside);
    this.addEventListener("keydown", this.keyboard);
  }
  disconnectedCallback(): void {
    this.close(false);
    document.removeEventListener("pointerdown", this.outside);
    this.removeEventListener("keydown", this.keyboard);
  }
  setApiKey(key: string): void { if (this.key !== key) { this.key = key; this.close(false); } }
  toggle(opener: HTMLElement): void { if (this.hidden) this.open(opener); else this.close(); }
  open(opener: HTMLElement): void {
    this.opener = opener; this.hidden = false;
    opener.setAttribute("aria-expanded", "true");
    const heading = el("div", { class: "emoji-picker-header" }, el("strong", { text: "GIFs" }));
    const close = el("button", { type: "button", text: "✕", "aria-label": "Close GIF picker" });
    close.addEventListener("click", () => this.close()); heading.append(close);
    this.search = el("input", { type: "search", maxlength: "50", placeholder: "Search KLIPY…", "aria-label": "Search GIFs", autocomplete: "off" }) as HTMLInputElement;
    this.search.disabled = !this.key.trim();
    this.search.addEventListener("input", () => {
      this.cancel(); this.grid.replaceChildren(); this.more.hidden = true;
      this.status.textContent = "Searching…";
      this.timer = setTimeout(() => { void this.load(1); }, 350);
    });
    this.grid = el("div", { class: "gif-grid" });
    this.status = el("p", { role: "status", "aria-live": "polite" });
    this.more = el("button", { type: "button", class: "call-btn", text: "Load more", hidden: true }) as HTMLButtonElement;
    this.more.addEventListener("click", () => { if (this.next !== null) void this.load(this.next); });
    const attribution = el("div", { class: "klipy-attribution", text: "Powered by KLIPY" });
    this.replaceChildren(heading, this.search, this.status, this.grid, this.more, attribution);
    if (this.key.trim()) void this.load(1);
    else this.status.textContent = "Add a KLIPY API key in Settings → Preferences to search GIFs.";
    (this.search.disabled ? close : this.search).focus();
  }
  private cancel(): void {
    this.sequence++; this.controller?.abort(); this.controller = null;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
  }
  close(focus = true): void {
    this.cancel(); this.hidden = true; this.replaceChildren();
    this.opener?.setAttribute("aria-expanded", "false"); if (focus) this.opener?.focus();
  }
  private async load(pageNumber: number): Promise<void> {
    this.cancel(); const sequence = this.sequence;
    this.controller = new AbortController(); this.more.disabled = true; this.status.textContent = "Loading GIFs…";
    try {
      const page = await searchKlipy(this.key, this.search.value, pageNumber, AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]));
      if (sequence !== this.sequence || this.hidden) return;
      if (pageNumber === 1) this.grid.replaceChildren();
      for (const gif of page.gifs) this.grid.append(this.result(gif));
      this.next = page.nextPage; this.more.hidden = this.next === null;
      this.status.textContent = this.grid.childElementCount ? "Select a GIF to send it. Searches and previews connect to KLIPY." : "No GIFs found. Try another search.";
    } catch (error) {
      if (sequence === this.sequence && !this.hidden) this.status.textContent = error instanceof Error ? error.message : "Could not load GIFs.";
    } finally { if (sequence === this.sequence) this.more.disabled = false; }
  }
  private result(gif: KlipyGif): HTMLElement {
    const button = el("button", { type: "button", title: `Send ${gif.title}`, "aria-label": `Send ${gif.title}` });
    button.append(el("img", { src: gif.preview, alt: gif.title, loading: "lazy", referrerpolicy: "no-referrer" }));
    button.addEventListener("click", () => this.select(gif));
    return button;
  }
  private select(gif: KlipyGif): void {
    this.dispatchEvent(new CustomEvent("gif-select", { detail: { gif } }));
    this.close(false);
  }
}
customElements.define("gif-picker", GifPicker);
declare global { interface HTMLElementTagNameMap { "gif-picker": GifPicker; } }
