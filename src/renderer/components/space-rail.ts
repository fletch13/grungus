/*
 * Grungus — <space-rail>: the Discord "server rail".
 * Matrix Spaces map onto Discord servers; Home shows all joined rooms.
 * Emits "grungus:select-space" with { spaceId: string | null }.
 */
import { icon } from "./icons.ts";
import { el } from "./ui.ts";
import type { MatrixClient, Room } from "../services/matrix-client.ts";

export class SpaceRail extends HTMLElement {
  private _spaces: Room[] = [];
  private _selectedId: string | null = null;
  private _client: MatrixClient | null = null;
  private _sig = "";

  private _menu: HTMLElement | null = null;
  private _menuOpener: HTMLElement | null = null;
  private _outside = (event: PointerEvent) => { if (!this._menu?.contains(event.target as Node)) this._closeMenu(false); };
  disconnectedCallback(): void { this._closeMenu(false); }
  private _closeMenu(restore = true): void {
    this._menu?.remove(); this._menu = null;
    document.removeEventListener("pointerdown", this._outside, true);
    this._menuOpener?.setAttribute("aria-expanded", "false");
    if (restore) this._menuOpener?.focus(); this._menuOpener = null;
  }
  private _openMenu(space: Room, opener: HTMLElement, x: number, y: number): void {
    this._closeMenu(false); this._menuOpener = opener; opener.setAttribute("aria-expanded", "true");
    const menu = el("div", { class: "space-context-menu", role: "menu", "aria-label": `${space.title} actions` });
    this._menu = menu;
    menu.append(el("div", { class: "space-menu-title", text: space.title, role: "presentation" }));
    for (const [action, label] of [["settings", "Space settings"], ["invite", "Invite people"], ["create-room", "Create a room"], ["browse", "Browse space rooms"], ["create-space", "Create a space"], ["new-dm", "New direct message"]]) {
      const button = el("button", { type: "button", role: "menuitem", text: label });
      button.addEventListener("click", () => {
        this._closeMenu();
        this.dispatchEvent(new CustomEvent("grungus:space-action", { detail: { spaceId: space.id, action }, bubbles: true }));
      }); menu.append(button);
    }
    menu.addEventListener("keydown", event => {
      const items = [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); this._closeMenu(); }
      else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }
    });
    document.body.append(menu);
    const bounds = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    document.addEventListener("pointerdown", this._outside, true);
  }

  connectedCallback(): void {
    this._render();
  }

  update(spaces: Room[], selectedId: string | null, client: MatrixClient | null): void {
    const sig =
      (selectedId ?? "null") +
      "|" +
      spaces
        .map((space) => [space.id, space.title, space.avatarMxc ?? ""].join(":"))
        .join(",");
    if (sig === this._sig && client === this._client) return;
    this._sig = sig;
    this._spaces = spaces;
    this._selectedId = selectedId;
    this._client = client;
    this._render();
  }

  private _render(): void {
    const spaces = this._spaces;
    const client = this._client;
    this._closeMenu(false);
    this.textContent = "";
    this.setAttribute("role", "navigation");
    this.setAttribute("aria-label", "Spaces");

    const home = el("button", {
      class: "rail-btn" + (this._selectedId ? "" : " active"),
      title: "Home — all rooms",
      "aria-label": "Home",
    });
    home.appendChild(el("span", { class: "rail-indicator" }));
    home.appendChild(icon("bubble", 23));
    home.setAttribute("aria-pressed", String(!this._selectedId));
    home.addEventListener("click", () => this._select(null));
    this.appendChild(home);

    this.appendChild(el("div", { class: "rail-sep" }));

    for (const space of spaces) {
      const btn = el("button", {
        class: "rail-btn" + (this._selectedId === space.id ? " active" : ""),
        title: space.title,
        "aria-label": space.title,
      });
      btn.setAttribute("aria-pressed", String(this._selectedId === space.id));
      btn.appendChild(el("span", { class: "rail-indicator" }));
      const av = document.createElement("g-avatar");
      av.update({
        name: space.title,
        userId: space.id,
        size: 48,
        square: true,
        load: client ? client.avatarSrc(space.avatarMxc, 48) : null,
      });
      btn.appendChild(av);
      btn.addEventListener("click", () => this._select(space.id));
      btn.setAttribute("aria-haspopup", "menu"); btn.setAttribute("aria-expanded", "false");
      btn.addEventListener("contextmenu", event => { event.preventDefault(); this._openMenu(space, btn, event.clientX, event.clientY); });
      btn.addEventListener("keydown", event => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault(); const rect = btn.getBoundingClientRect(); this._openMenu(space, btn, rect.right + 8, rect.top);
        }
      });
      this.appendChild(btn);
    }
  }

  private _select(spaceId: string | null): void {
    if (spaceId === (this._selectedId ?? null)) return;
    this.dispatchEvent(
      new CustomEvent("grungus:select-space", {
        detail: { spaceId },
        bubbles: true,
      })
    );
  }
}

customElements.define("space-rail", SpaceRail);

declare global {
  interface HTMLElementTagNameMap {
    "space-rail": SpaceRail;
  }
}
