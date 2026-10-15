/*
 * Grungus — <member-list>: right-hand member pane for the selected room.
 */
"use strict";

class MemberList extends HTMLElement {
  constructor() {
    super();
    this._sig = "";
  }

  update(room, client, meUserId) {
    if (!room) {
      this.textContent = "";
      this.appendChild(el("div", { class: "empty-state", text: "—" }));
      return;
    }
    var members = Array.from(room.members.values()).filter(function (m) {
      return m.membership === "join";
    });
    members.sort(function (a, b) {
      var an = (a.displayname || a.userId).toLowerCase();
      var bn = (b.displayname || b.userId).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    var sig =
      room.id + "|" + meUserId + "|" + members.map(function (m) {
        return m.userId + ":" + (m.displayname || "") + ":" + (m.avatarMxc || "");
      }).join(",");
    if (sig === this._sig) return;
    this._sig = sig;

    this.textContent = "";
    this.appendChild(
      el("div", { class: "member-head", text: "Members — " + members.length })
    );

    var self = this;
    members.forEach(function (m) {
      var row = el("div", { class: "member-row" });
      var av = document.createElement("g-avatar");
      av.update({
        name: m.displayname || m.userId,
        userId: m.userId,
        size: 32,
        load: client ? client.avatarSrc(m.avatarMxc, 32) : null,
      });
      row.appendChild(av);
      row.appendChild(
        el("span", {
          class: "member-name",
          text: m.displayname || m.userId.split(":")[0].slice(1),
        })
      );
      if (m.userId === meUserId) {
        row.appendChild(el("span", { class: "member-tag", text: "You" }));
      }
      self.appendChild(row);
    });
  }
}

customElements.define("member-list", MemberList);
