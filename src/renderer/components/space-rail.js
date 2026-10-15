/*
 * Grungus — <space-rail>: the Discord "server rail".
 * Matrix Spaces map onto Discord servers; Home shows all joined rooms.
 * Emits "grungus:select-space" with { spaceId: string | null }.
 */
"use strict";

class SpaceRail extends HTMLElement {
  constructor() {
    super();
    this._sig = "";
  }

  connectedCallback() {
    this._render();
  }

  /**
   * @param {Array} spaces  joined m.space rooms
   * @param {string|null} selectedId  currently selected space id (null=Home)
   * @param {MatrixClient} client
   */
  update(spaces, selectedId, client) {
    var sig =
      (selectedId || "null") +
      "|" +
      spaces
        .map(function (s) {
          return [s.id, s.title, s.avatarMxc || ""].join(":");
        })
        .join(",");
    if (sig === this._sig) return;
    this._sig = sig;
    this._spaces = spaces;
    this._selectedId = selectedId;
    this._client = client;
    this._render();
  }

  _render() {
    var self = this;
    var spaces = this._spaces || [];
    var client = this._client;
    this.textContent = "";

    var home = el("button", {
      class: "rail-btn" + (this._selectedId ? "" : " active"),
      title: "Home — all rooms",
      "aria-label": "Home",
    });
    home.appendChild(el("span", { class: "rail-indicator" }));
    home.appendChild(el("span", { text: "G" }));
    home.addEventListener("click", function () {
      self._select(null);
    });
    this.appendChild(home);

    this.appendChild(el("div", { class: "rail-sep" }));

    spaces.forEach(function (space) {
      var btn = el("button", {
        class: "rail-btn" + (self._selectedId === space.id ? " active" : ""),
        title: space.title,
        "aria-label": space.title,
      });
      btn.appendChild(el("span", { class: "rail-indicator" }));
      var av = document.createElement("g-avatar");
      av.update({
        name: space.title,
        userId: space.id,
        size: 48,
        square: true,
        load: client ? client.avatarSrc(space.avatarMxc, 48) : null,
      });
      btn.appendChild(av);
      btn.addEventListener("click", function () {
        self._select(space.id);
      });
      self.appendChild(btn);
    });
  }

  _select(spaceId) {
    if (spaceId === (this._selectedId || null)) return;
    this.dispatchEvent(
      new CustomEvent("grungus:select-space", {
        detail: { spaceId: spaceId },
        bubbles: true,
      })
    );
  }
}

customElements.define("space-rail", SpaceRail);
