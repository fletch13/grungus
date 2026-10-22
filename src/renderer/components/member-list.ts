import { userPowerLevel } from "../services/room-permissions.ts";
import { bindUserTile, userLabel } from "./user-menu.ts";
/*
 * Grungus — <member-list>: right-hand member pane for the selected room.
 */
import { icon } from "./icons.ts";
import { el } from "./ui.ts";
import { mxidLocalpart, type MatrixClient, type Room } from "../services/matrix-client.ts";

export class MemberList extends HTMLElement {
  private _sig = "";
  private _client: MatrixClient | null = null;

  update(room: Room | null, client: MatrixClient | null, meUserId: string | null, space: Room | null = null): void {
    if (!room) {
      this._sig = "";
      this.textContent = "";
      this.appendChild(el("div", { class: "empty-state", text: "—" }));
      return;
    }
    const scope = space ?? room;
    const role = (userId: string): "admin" | "moderator" | "member" => {
      const level = userPowerLevel(scope.powerLevels ?? {}, userId, scope.creator);
      return level >= 100 ? "admin" : level >= 50 ? "moderator" : "member";
    };
    const members = [...room.members.values()].filter(
      (member) => member.membership === "join"
    );
    members.sort((a, b) => {
      const an = (a.displayname || a.userId).toLowerCase();
      const bn = (b.displayname || b.userId).toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    const sig =
      room.id + "|" + scope.id + "|" + JSON.stringify(scope.powerLevels ?? {}) + "|" + (scope.creator ?? "") +
      "|" +
      (meUserId ?? "") +
      "|" +
      members
        .map(
          (member) =>
            `${member.userId}:${member.displayname ?? ""}:${member.avatarMxc ?? ""}:${client?.getUserNickname?.(member.userId) ?? ""}:${client?.getPresence?.(member.userId) ?? "unknown"}`
        )
        .join(",");
    if (sig === this._sig && client === this._client) return;
    this._client = client;
    this._sig = sig;

    this.textContent = "";
    this.appendChild(
      el("div", { class: "member-head" }, icon("users", 16), "Members", el("span", { class: "member-count", text: String(members.length) }))
    );

    if (space) this.append(el("p", { class: "member-role-scope", text: `Space roles · ${scope.title}` }));

    for (const group of ["admin", "moderator", "member"] as const) {
      const grouped = members.filter(member => role(member.userId) === group);
      if (!grouped.length) continue;
      this.append(el("h3", { class: `member-role-heading ${group}`, text: `${group === "admin" ? "Admins" : group === "moderator" ? "Moderators" : "Members"} — ${grouped.length}`, title: `${space ? "Space" : "Room"} roles: ${scope.title}` }));
      for (const member of grouped) {
        const row = el("div", { class: `member-row member-role-${group}`, dataset: { userId: member.userId, role: group } });
        const av = document.createElement("g-avatar");
        av.update({
          name: member.displayname ?? member.userId,
          userId: member.userId,
          size: 32,
          presence: client?.getPresence?.(member.userId) ?? null,
          load: client ? client.avatarSrc(member.avatarMxc, 32) : null,
        });
        row.appendChild(av);
        row.appendChild(
          el("span", {
            class: "member-name",
            text: userLabel(client, member.userId, member.displayname ?? mxidLocalpart(member.userId)),
          })
        );
        if (space?.creator === member.userId) row.append(el("span", { class: "member-owner-crown", role: "img", "aria-label": "Space owner", title: "Space owner (creator)" }, icon("crown", 14)));
        if (group !== "member") row.append(el("span", { class: `member-role-badge ${group}`, text: group === "admin" ? "Admin" : "Mod", title: `${space ? "Space" : "Room"} ${group === "admin" ? "administrator" : "moderator"} · ${scope.title}` }));
        if (member.userId === meUserId) {
          row.appendChild(el("span", { class: "member-tag", text: "You" }));
        }
        bindUserTile(row, client, member.userId, member.displayname || member.userId);
        this.appendChild(row);
      }
    }
  }
}

customElements.define("member-list", MemberList);

declare global {
  interface HTMLElementTagNameMap {
    "member-list": MemberList;
  }
}
