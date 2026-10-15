/*
 * Grungus — <member-list>: right-hand member pane for the selected room.
 */
import { el } from "./ui.ts";
import { mxidLocalpart, type MatrixClient, type Room } from "../services/matrix-client.ts";

export class MemberList extends HTMLElement {
  private _sig = "";

  update(room: Room | null, client: MatrixClient | null, meUserId: string | null): void {
    if (!room) {
      this.textContent = "";
      this.appendChild(el("div", { class: "empty-state", text: "—" }));
      return;
    }
    const members = [...room.members.values()].filter(
      (member) => member.membership === "join"
    );
    members.sort((a, b) => {
      const an = (a.displayname || a.userId).toLowerCase();
      const bn = (b.displayname || b.userId).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    const sig =
      room.id +
      "|" +
      (meUserId ?? "") +
      "|" +
      members
        .map(
          (member) =>
            `${member.userId}:${member.displayname ?? ""}:${member.avatarMxc ?? ""}`
        )
        .join(",");
    if (sig === this._sig) return;
    this._sig = sig;

    this.textContent = "";
    this.appendChild(
      el("div", { class: "member-head", text: `Members — ${members.length}` })
    );

    for (const member of members) {
      const row = el("div", { class: "member-row" });
      const av = document.createElement("g-avatar");
      av.update({
        name: member.displayname ?? member.userId,
        userId: member.userId,
        size: 32,
        load: client ? client.avatarSrc(member.avatarMxc, 32) : null,
      });
      row.appendChild(av);
      row.appendChild(
        el("span", {
          class: "member-name",
          text: member.displayname ?? mxidLocalpart(member.userId),
        })
      );
      if (member.userId === meUserId) {
        row.appendChild(el("span", { class: "member-tag", text: "You" }));
      }
      this.appendChild(row);
    }
  }
}

customElements.define("member-list", MemberList);

declare global {
  interface HTMLElementTagNameMap {
    "member-list": MemberList;
  }
}
