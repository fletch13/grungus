/*
 * Grungus — <space-rail>: the Discord "server rail".
 * Matrix Spaces map onto Discord servers; Home shows all joined rooms.
 * Emits "grungus:select-space" with { spaceId: string | null }.
 */
import { el } from "./ui.ts";
import type { MatrixClient, Room } from "../services/matrix-client.ts";

export class SpaceRail extends HTMLElement {
  private _spaces: Room[] = [];
  private _selectedId: string | null = null;
  private _client: MatrixClient | null = null;
  private _sig = "";

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
    if (sig === this._sig) return;
    this._sig = sig;
    this._spaces = spaces;
    this._selectedId = selectedId;
    this._client = client;
    this._render();
  }

  private _render(): void {
    const spaces = this._spaces;
    const client = this._client;
    this.textContent = "";

    const home = el("button", {
      class: "rail-btn" + (this._selectedId ? "" : " active"),
      title: "Home — all rooms",
      "aria-label": "Home",
    });
    home.appendChild(el("span", { class: "rail-indicator" }));
    home.appendChild(el("span", { text: "G" }));
    home.addEventListener("click", () => this._select(null));
    this.appendChild(home);

    this.appendChild(el("div", { class: "rail-sep" }));

    for (const space of spaces) {
      const btn = el("button", {
        class: "rail-btn" + (this._selectedId === space.id ? " active" : ""),
        title: space.title,
        "aria-label": space.title,
      });
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
