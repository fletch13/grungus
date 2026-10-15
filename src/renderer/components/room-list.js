/*
 * Grungus — <room-list>: sidebar with rooms, direct messages, the local
 * user footer, connection indicator, and the inline "new room" form.
 * Events: "grungus:select-room" {roomId}, "grungus:create-room" {name},
 * "grungus:logout".
 */
"use strict";

class RoomList extends HTMLElement {
  constructor() {
    super();
    this._rooms = [];
    this._spaces = [];
    this._selectedRoomId = null;
    this._spaceId = null;
    this._client = null;
    this._showForm = false;
    this._user = null;
    this._connection = "connecting";
    this._sig = "";
  }

  connectedCallback() {
    this._render();
  }

  update(rooms, spaces, selectedRoomId, spaceId, client) {
    this._rooms = rooms || [];
    this._spaces = spaces || [];
    this._selectedRoomId = selectedRoomId || null;
    this._spaceId = spaceId || null;
    this._client = client || null;
    this._render();
  }

  setUser(user) {
    this._user = user || null;
    this._renderFooter();
  }

  setConnection(state) {
    this._connection = state || "connecting";
    this._renderFooter();
  }

  _currentSpace() {
    var self = this;
    return this._spaces.filter(function (s) {
      return s.id === self._spaceId;
    })[0] || null;
  }

  _render() {
    var self = this;
    var space = this._currentSpace();
    this.textContent = "";

    /* header */
    var head = el("div", { class: "sidebar-head" });
    head.appendChild(el("span", { class: "head-title", text: space ? space.title : "Home" }));
    var addBtn = el("button", {
      class: "add-btn",
      title: "Create a room",
      "aria-label": "Create a room",
      text: "+",
    });
    addBtn.addEventListener("click", function () {
      self._showForm = !self._showForm;
      self._render();
      if (self._showForm) {
        var input = self.querySelector(".new-room-form input");
        if (input) input.focus();
      }
    });
    head.appendChild(addBtn);
    this.appendChild(head);

    /* inline create-room form */
    if (this._showForm) {
      var form = el("div", { class: "new-room-form" });
      var input = el("input", {
        type: "text",
        placeholder: "new-room-name",
        maxlength: "80",
        spellcheck: "false",
      });
      var create = el("button", { text: "Create" });
      form.appendChild(input);
      form.appendChild(create);

      var submitNewRoom = function () {
        var name = input.value.trim();
        if (!name) return;
        input.value = "";
        self._showForm = false;
        self.dispatchEvent(
          new CustomEvent("grungus:create-room", { detail: { name: name }, bubbles: true })
        );
        self._render();
      };
      create.addEventListener("click", submitNewRoom);
      input.addEventListener("keydown", function (event) {
        if (event.key === "Enter") {
          event.preventDefault();
          submitNewRoom();
        }
      });
      this.appendChild(form);
    }

    /* scrollable room sections */
    var scroll = el("div", { class: "room-scroll" });
    var rooms = this._rooms;

    var roomsSection = rooms.filter(function (r) {
      return !r.isDirect;
    });
    var dmSection = rooms.filter(function (r) {
      return r.isDirect;
    });

    if (space) {
      /* inside a space: one flat section, like a Discord server */
      this._renderSection(scroll, "Rooms", roomsSection);
    } else {
      this._renderSection(scroll, "Rooms", roomsSection);
      this._renderSection(scroll, "Direct Messages", dmSection);
    }

    if (!rooms.length) {
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

    /* user footer */
    this.appendChild(this._buildFooter());
  }

  _renderSection(container, label, rooms) {
    if (!rooms.length) return;
    container.appendChild(el("div", { class: "sidebar-section", text: label }));
    rooms.forEach(
      function (room) {
        return container.appendChild(this._buildRoomRow(room));
      },
      this
    );
  }

  _buildRoomRow(room) {
    var self = this;
    var row = el("div", {
      class:
        "room-row" +
        (room.id === this._selectedRoomId ? " active" : "") +
        (room.unread ? " has-unread" : ""),
      dataset: { roomId: room.id },
    });
    var av = document.createElement("g-avatar");
    av.update({
      name: room.title,
      userId: room.directUserId || room.id,
      size: 32,
      load: this._client ? this._client.avatarSrc(room.avatarMxc, 32) : null,
    });
    row.appendChild(av);
    row.appendChild(el("span", { class: "room-name", text: room.title }));
    if (room.unread) {
      row.appendChild(el("span", { class: "unread-badge", text: String(room.unread) }));
    }
    row.addEventListener("click", function () {
      self.dispatchEvent(
        new CustomEvent("grungus:select-room", {
          detail: { roomId: room.id },
          bubbles: true,
        })
      );
    });
    return row;
  }

  _buildFooter() {
    var self = this;
    var footer = el("div", { class: "app-user" });

    var av = document.createElement("g-avatar");
    av.update({
      name: (this._user && this._user.displayname) || (this._user && this._user.userId) || "?",
      userId: (this._user && this._user.userId) || "?",
      size: 32,
      load:
        this._user && this._client && this._user.avatarMxc
          ? this._client.avatarSrc(this._user.avatarMxc, 32)
          : null,
    });
    footer.appendChild(av);

    var meta = el("div", { class: "user-meta" });
    meta.appendChild(
      el("div", {
        class: "user-name",
        text: (this._user && this._user.displayname) || "Not logged in",
      })
    );
    meta.appendChild(
      el("div", {
        class: "user-id",
        text: (this._user && this._user.userId) || "",
      })
    );
    footer.appendChild(meta);

    var dotClass = "conn-dot";
    if (this._connection === "online") dotClass += " online";
    else if (this._connection === "connecting") dotClass += " connecting";
    footer.appendChild(el("span", {
      class: dotClass,
      title: "Connection: " + this._connection,
    }));

    var logout = el("button", {
      class: "logout-btn",
      title: "Log out",
      "aria-label": "Log out",
      text: "Log out",
    });
    logout.addEventListener("click", function () {
      self.dispatchEvent(new CustomEvent("grungus:logout", { bubbles: true }));
    });
    footer.appendChild(logout);

    return footer;
  }

  _renderFooter() {
    var existing = this.querySelector(".app-user");
    if (existing) existing.replaceWith(this._buildFooter());
  }
}

customElements.define("room-list", RoomList);
