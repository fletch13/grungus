/*
 * Grungus — <room-list>: sidebar with rooms, direct messages, the local
 * user footer, connection indicator, and the inline "new room" form.
 * Events: "grungus:select-room" {roomId}, "grungus:create-room" {name},
 * "grungus:logout".
 */
import { el } from "./ui.ts";
import {
  mxidLocalpart,
  type ConnectionState,
  type InvitedRoom,
  type MatrixClient,
  type Room,
} from "../services/matrix-client.ts";

export interface UserInfo {
  userId: string;
  displayname: string | null;
  avatarMxc: string | null;
}

export class RoomList extends HTMLElement {
  private _rooms: Room[] = [];
  private _spaces: Room[] = [];
  private _invites: InvitedRoom[] = [];
  private _selectedRoomId: string | null = null;
  private _spaceId: string | null = null;
  private _client: MatrixClient | null = null;
  private _showForm = false;
  private _showSpaceForm = false;
  /** every joined non-DM room (for the space add-room picker) */
  private _allRooms: Room[] = [];
  private _user: UserInfo | null = null;
  private _connection: ConnectionState = "connecting";

  connectedCallback(): void {
    this._render();
  }

  update(
    rooms: Room[],
    spaces: Room[],
    selectedRoomId: string | null,
    spaceId: string | null,
    client: MatrixClient | null,
    allRooms?: Room[]
  ): void {
    this._rooms = rooms;
    this._spaces = spaces;
    this._selectedRoomId = selectedRoomId;
    this._spaceId = spaceId;
    this._client = client;
    this._allRooms = allRooms ?? rooms;
    this._render();
  }

  setUser(user: UserInfo | null): void {
    this._user = user;
    this._renderFooter();
  }

  setInvites(invites: InvitedRoom[]): void {
    this._invites = invites;
    this._render();
  }

  setConnection(state: ConnectionState): void {
    this._connection = state;
    this._renderFooter();
  }

  private _currentSpace(): Room | null {
    return this._spaces.find((space) => space.id === this._spaceId) ?? null;
  }

  private _render(): void {
    const space = this._currentSpace();
    this.textContent = "";

    /* header */
    const head = el("div", { class: "sidebar-head" });
    head.appendChild(
      el("span", { class: "head-title", text: space ? space.title : "Home" })
    );
    const addBtn = el("button", {
      class: "add-btn",
      title: "Create a room",
      "aria-label": "Create a room",
      text: "+",
    });
    addBtn.addEventListener("click", () => {
      this._showForm = !this._showForm;
      this._showSpaceForm = false;
      this._render();
      if (this._showForm) {
        const input = this.querySelector<HTMLInputElement>(".new-room-form input");
        input?.focus();
      }
    });
    head.appendChild(addBtn);
    /* new-space toggle (space management) */
    const spaceBtn = el("button", {
      class: "add-btn",
      title: "Create a space",
      "aria-label": "Create a space",
      text: "🗂",
    });
    spaceBtn.addEventListener("click", () => {
      this._showSpaceForm = !this._showSpaceForm;
      this._showForm = false;
      this._render();
      if (this._showSpaceForm) {
        const input = this.querySelector<HTMLInputElement>(".new-space-form input");
        input?.focus();
      }
    });
    head.appendChild(spaceBtn);
    this.appendChild(head);

    /* inline create-space form */
    if (this._showSpaceForm) {
      const form = el("div", { class: "new-space-form" });
      const input = el("input", {
        type: "text",
        placeholder: "new-space-name",
        maxlength: "80",
        spellcheck: "false",
      }) as HTMLInputElement;
      const create = el("button", { text: "Create" });
      form.appendChild(input);
      form.appendChild(create);
      const submitNewSpace = (): void => {
        const name = input.value.trim();
        if (!name) return;
        input.value = "";
        this._showSpaceForm = false;
        this.dispatchEvent(
          new CustomEvent("grungus:create-space", {
            detail: { name },
            bubbles: true,
          })
        );
        this._render();
      };
      create.addEventListener("click", submitNewSpace);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submitNewSpace();
        }
      });
      this.appendChild(form);
    }

    /* inline create-room form */
    if (this._showForm) {
      const form = el("div", { class: "new-room-form" });
      const input = el("input", {
        type: "text",
        placeholder: "new-room-name",
        maxlength: "80",
        spellcheck: "false",
      }) as HTMLInputElement;
      const create = el("button", { text: "Create" });
      form.appendChild(input);
      form.appendChild(create);

      const submitNewRoom = (): void => {
        const name = input.value.trim();
        if (!name) return;
        input.value = "";
        this._showForm = false;
        this.dispatchEvent(
          new CustomEvent("grungus:create-room", {
            detail: { name },
            bubbles: true,
          })
        );
        this._render();
      };
      create.addEventListener("click", submitNewRoom);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submitNewRoom();
        }
      });
      this.appendChild(form);
    }

    /* scrollable room sections */
    const scroll = el("div", { class: "room-scroll" });

    /* space management: add/remove children (when a space is selected) */
    if (space && this._client) {
      const mgmt = el("div", { class: "space-manage" });
      mgmt.appendChild(el("div", { class: "sidebar-section", text: "Space rooms" }));

      /* current children with remove buttons */
      const children = this._rooms.filter((room) => space.children.has(room.id));
      for (const child of children) {
        const row = el("div", { class: "space-child-row" });
        row.appendChild(el("span", { class: "space-child-name", text: child.title }));
        const rm = el("button", {
          class: "space-child-remove",
          title: `Remove ${child.title} from this space`,
          text: "✕",
        });
        rm.addEventListener("click", () => {
          this.dispatchEvent(
            new CustomEvent("grungus:remove-from-space", {
              detail: { spaceId: space.id, roomId: child.id },
              bubbles: true,
            })
          );
        });
        row.appendChild(rm);
        mgmt.appendChild(row);
      }
      if (children.length === 0) {
        mgmt.appendChild(
          el("div", { class: "empty-state", text: "No rooms in this space yet." })
        );
      }

      /* add-room picker: joined rooms that are not yet children */
      const candidates = this._allRooms.filter(
        (room) => !room.isSpace && !room.isDirect && !space.children.has(room.id)
      );
      if (candidates.length > 0) {
        const picker = el("div", { class: "space-add-row" });
        const select = document.createElement("select");
        select.className = "space-add-select";
        for (const cand of candidates) {
          const opt = document.createElement("option");
          opt.value = cand.id;
          opt.textContent = cand.title;
          select.appendChild(opt);
        }
        const add = el("button", { text: "Add", class: "space-add-btn" });
        add.addEventListener("click", () => {
          const roomId = select.value;
          if (!roomId) return;
          this.dispatchEvent(
            new CustomEvent("grungus:add-to-space", {
              detail: { spaceId: space.id, roomId },
              bubbles: true,
            })
          );
        });
        picker.appendChild(select);
        picker.appendChild(add);
        mgmt.appendChild(picker);
      }
      scroll.appendChild(mgmt);
    }

    this._renderInvites(scroll);

    const roomsSection = this._rooms.filter((room) => !room.isDirect);
    const dmSection = this._rooms.filter((room) => room.isDirect);

    this._renderSection(scroll, "Rooms", roomsSection);
    if (!space) {
      this._renderSection(scroll, "Direct Messages", dmSection);
    }

    if (this._rooms.length === 0) {
      scroll.appendChild(
        el("div", {
          class: "empty-state",
          text: space
            ? "No rooms in this space yet."
            : "No rooms yet — create one with the + button.",
        })
      );
    }

    this.appendChild(scroll);
    this.appendChild(this._buildFooter());
  }

  private _renderSection(container: HTMLElement, label: string, rooms: Room[]): void {
    if (rooms.length === 0) return;
    container.appendChild(el("div", { class: "sidebar-section", text: label }));
    for (const room of rooms) container.appendChild(this._buildRoomRow(room));
  }

  /** Pending-invite rows with accept/decline buttons. */
  private _renderInvites(container: HTMLElement): void {
    if (this._invites.length === 0) return;
    container.appendChild(el("div", { class: "sidebar-section", text: "Invites" }));
    for (const invite of this._invites) {
      const row = el("div", { class: "invite-row", dataset: { roomId: invite.id } });
      const meta = el("div", { class: "invite-meta" });
      meta.appendChild(
        el("div", {
          class: "room-name",
          text: `${invite.isEncrypted ? "🔒 " : ""}${invite.name ?? "Unnamed room"}`,
        })
      );
      const inviter = invite.inviterId ? mxidLocalpart(invite.inviterId) : null;
      meta.appendChild(
        el("div", {
          class: "invite-inviter",
          text: inviter ? `invited by ${inviter}` : "you are invited",
        })
      );
      const accept = el("button", { class: "invite-accept", title: "Accept", text: "✓" });
      accept.addEventListener("click", (event) => {
        event.stopPropagation();
        this.dispatchEvent(
          new CustomEvent("grungus:accept-invite", {
            detail: { roomId: invite.id },
            bubbles: true,
          })
        );
      });
      const decline = el("button", { class: "invite-decline", title: "Decline", text: "✗" });
      decline.addEventListener("click", (event) => {
        event.stopPropagation();
        this.dispatchEvent(
          new CustomEvent("grungus:decline-invite", {
            detail: { roomId: invite.id },
            bubbles: true,
          })
        );
      });
      row.appendChild(meta);
      row.appendChild(accept);
      row.appendChild(decline);
      container.appendChild(row);
    }
  }

  private _buildRoomRow(room: Room): HTMLElement {
    const row = el("div", {
      class:
        "room-row" +
        (room.id === this._selectedRoomId ? " active" : "") +
        (room.unread > 0 ? " has-unread" : ""),
      dataset: { roomId: room.id },
    });
    const av = document.createElement("g-avatar");
    av.update({
      name: room.title,
      userId: room.directUserId ?? room.id,
      size: 32,
      load: this._client ? this._client.avatarSrc(room.avatarMxc, 32) : null,
    });
    row.appendChild(av);
    row.appendChild(
      el("span", {
        class: "room-name",
        text: `${room.isEncrypted ? "🔒 " : ""}${room.title}`,
      })
    );
    if (room.unread > 0) {
      row.appendChild(el("span", { class: "unread-badge", text: String(room.unread) }));
    }
    /* delete (leave) — hover-revealed, two-click confirm so it can't
       go off by accident */
    const del = el("button", {
      class: "room-delete",
      title: "Delete chat (leaves the room)",
      "aria-label": `Delete chat ${room.title}`,
      text: "🗑",
    });
    let armed = false;
    let armTimer: ReturnType<typeof setTimeout> | null = null;
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!armed) {
        armed = true;
        del.classList.add("armed");
        del.textContent = "sure?";
        armTimer = setTimeout(() => {
          armed = false;
          del.classList.remove("armed");
          del.textContent = "🗑";
        }, 3_000);
        return;
      }
      if (armTimer) clearTimeout(armTimer);
      this.dispatchEvent(
        new CustomEvent("grungus:delete-room", {
          detail: { roomId: room.id },
          bubbles: true,
        })
      );
    });
    row.appendChild(del);
    row.addEventListener("click", () => {
      this.dispatchEvent(
        new CustomEvent("grungus:select-room", {
          detail: { roomId: room.id },
          bubbles: true,
        })
      );
    });
    return row;
  }

  private _buildFooter(): HTMLElement {
    const footer = el("div", { class: "app-user" });

    const av = document.createElement("g-avatar");
    av.update({
      name: this._user?.displayname ?? this._user?.userId ?? "?",
      userId: this._user?.userId ?? "?",
      size: 32,
      load:
        this._user && this._client && this._user.avatarMxc
          ? this._client.avatarSrc(this._user.avatarMxc, 32)
          : null,
    });
    footer.appendChild(av);

    const meta = el("div", { class: "user-meta" });
    meta.appendChild(
      el("div", {
        class: "user-name",
        text: this._user?.displayname ?? "Not logged in",
      })
    );
    meta.appendChild(
      el("div", { class: "user-id", text: this._user?.userId ?? "" })
    );
    footer.appendChild(meta);

    let dotClass = "conn-dot";
    if (this._connection === "online") dotClass += " online";
    else if (this._connection === "connecting") dotClass += " connecting";
    footer.appendChild(
      el("span", { class: dotClass, title: `Connection: ${this._connection}` })
    );

    const logout = el("button", {
      class: "logout-btn",
      title: "Log out",
      "aria-label": "Log out",
      text: "Log out",
    });
    logout.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("grungus:logout", { bubbles: true }));
    });
    footer.appendChild(logout);

    const backup = el("button", {
      class: "backup-btn",
      title: "Key backup / restore",
      "aria-label": "Key backup",
      text: "🔑",
    });
    backup.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("grungus:open-backup", { bubbles: true }));
    });
    footer.appendChild(backup);

    const verifySession = el("button", {
      class: "backup-btn",
      title: "Verify this session against your other devices",
      "aria-label": "Verify session",
      text: "🛡",
    });
    verifySession.addEventListener("click", () => {
      this.dispatchEvent(new CustomEvent("grungus:verify-session", { bubbles: true }));
    });
    footer.appendChild(verifySession);

    return footer;
  }

  private _renderFooter(): void {
    const existing = this.querySelector(".app-user");
    if (existing) existing.replaceWith(this._buildFooter());
  }
}

customElements.define("room-list", RoomList);

declare global {
  interface HTMLElementTagNameMap {
    "room-list": RoomList;
  }
}
