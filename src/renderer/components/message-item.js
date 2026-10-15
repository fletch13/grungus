/*
 * Grungus — <message-item>: one chat message, Discord-style.
 * Handles grouped rendering (consecutive messages from the same sender),
 * pending/failed local echoes, and emote/notice formatting.
 */
"use strict";

class MessageItem extends HTMLElement {
  constructor() {
    super();
    this._item = null;
  }

  update(item, opts) {
    this._item = item;
    this._opts = opts || {};
    this._render();
  }

  _render() {
    var item = this._item;
    if (!item || item.kind !== "message") return;
    var opts = this._opts;
    var client = opts.client;

    this.textContent = "";
    this.classList.toggle("grouped", !!opts.grouped);
    this.classList.toggle("pending", !!item.pending);
    this.classList.toggle("failed", !!item.failed);

    /* avatar column (kept for alignment when grouped) */
    var avatarCol = el("div", { class: "avatar-col" });
    if (!opts.grouped) {
      var av = document.createElement("g-avatar");
      av.update({
        name: item.senderName,
        userId: item.sender,
        size: 40,
        load:
          client && item.sender
            ? client.avatarSrc(
                (opts.room && opts.room.members.get(item.sender) || {}).avatarMxc,
                40
              )
            : null,
      });
      avatarCol.appendChild(av);
    }
    this.appendChild(avatarCol);

    var main = el("div", { class: "msg-main" });

    if (!opts.grouped) {
      var head = el("div", { class: "msg-head" });
      var author = el("span", {
        class: "msg-author",
        text: item.senderName || "unknown",
      });
      author.style.color = colorFor(item.sender);
      head.appendChild(author);
      head.appendChild(el("span", { class: "msg-time", text: formatTime(item.ts) }));
      main.appendChild(head);
    }

    var body = el("div", { class: "msg-body" });
    if (item.msgtype === "m.emote") {
      body.textContent = "* " + item.senderName + " " + item.body;
      body.style.fontStyle = "italic";
    } else if (item.msgtype === "m.notice") {
      body.textContent = item.body;
      body.style.color = "var(--text-muted)";
    } else {
      body.textContent = item.body;
    }
    if (item.failed) {
      body.appendChild(document.createTextNode("  — failed to send"));
    } else if (item.pending) {
      body.appendChild(document.createTextNode("  (sending…)"));
    }
    main.appendChild(body);

    this.appendChild(main);
  }
}

customElements.define("message-item", MessageItem);
