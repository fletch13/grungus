/*
 * Grungus — <chat-view>: room header, message timeline, composer.
 * Emits "grungus:send" with { roomId, body }. Timeline updates come in two
 * flavors: incremental appends (live events, local echoes) and full
 * re-renders (echo reconciliation — markers "echo-replaced"/"echo-failed").
 */
"use strict";

class ChatView extends HTMLElement {
  constructor() {
    super();
    this._room = null;
    this._client = null;
    this._meUserId = null;
    this._lastItem = null; /* last rendered item, for grouping/dividers */
    this._noticeTimer = null;
  }

  connectedCallback() {
    this._renderSkeleton();
  }

  _renderSkeleton() {
    this.textContent = "";
    this._header = el("div", { class: "chat-header" });
    this._scroll = el("div", { class: "chat-scroll" });
    this._scroll.appendChild(
      el("div", {
        class: "empty-state",
        text: "Pick a room on the left, or log in to get started.",
      })
    );

    var wrap = el("div", { class: "composer-wrap" });
    var composer = el("div", { class: "composer" });
    this._input = el("textarea", {
      rows: "1",
      placeholder: "Message…",
      disabled: true,
    });
    this._hint = el("div", { class: "composer-hint" });
    composer.appendChild(this._input);
    wrap.appendChild(composer);
    wrap.appendChild(this._hint);

    var self = this;
    this._input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        self._submit();
      }
    });
    this._input.addEventListener("input", function () {
      self._autosize();
    });

    this.appendChild(this._header);
    this.appendChild(this._scroll);
    this.appendChild(wrap);
  }

  setRoom(room, client, meUserId) {
    this._room = room || null;
    this._client = client || null;
    this._meUserId = meUserId || null;

    this._renderHeader();
    if (!room) {
      this._clearTimeline();
      this._input.disabled = true;
      this._input.placeholder = "Message…";
      return;
    }
    this._input.disabled = false;
    this._input.placeholder = "Message " + room.title;
    this._renderTimeline();
    this._scrollToBottom();
  }

  clearRoom() {
    this.setRoom(null, this._client, this._meUserId);
  }

  _renderHeader() {
    var room = this._room;
    this._header.textContent = "";
    if (!room) {
      this._header.appendChild(el("span", { class: "title", text: "Grungus" }));
      return;
    }
    this._header.appendChild(el("span", { class: "title", text: room.title }));
    var sub = room.topic
      ? room.topic + "  ·  " + room.joinedMemberCount + " members"
      : room.joinedMemberCount + " members";
    this._header.appendChild(el("span", { class: "topic", text: sub }));
  }

  _clearTimeline() {
    this._scroll.textContent = "";
    this._lastItem = null;
    this._scroll.appendChild(
      el("div", { class: "empty-state", text: "No room selected." })
    );
  }

  /** Rebuild the timeline from room.timeline (echo reconciliation etc). */
  _renderTimeline() {
    var room = this._room;
    if (!room) return this._clearTimeline();
    this._scroll.textContent = "";
    this._lastItem = null;
    var self = this;
    room.timeline.forEach(function (item) {
      self._appendItem(item);
    });
  }

  /**
   * Incremental updates from the sync loop. If the batch contains an echo
   * marker, do a full re-render instead of appending (the timeline in the
   * client already holds the reconciled state).
   */
  appendEvents(room, events) {
    if (!this._room || !room || room.id !== this._room.id) return;
    events = events || [];
    var hasMarker = events.some(function (e) {
      return e && (e.kind === "echo-replaced" || e.kind === "echo-failed");
    });
    if (hasMarker) {
      var pinned = this._nearBottom();
      this._renderTimeline();
      if (pinned) this._scrollToBottom();
      return;
    }
    var pinned = this._nearBottom();
    var self = this;
    events.forEach(function (e) {
      self._appendItem(e);
    });
    if (pinned || events.some(isFromMe)) {
      this._scrollToBottom();
    }

    function isFromMe(e) {
      return e && e.sender === self._meUserId;
    }
  }

  _appendItem(item) {
    if (!item) return;
    var scroll = this._scroll;

    /* day divider */
    var last = this._lastItem;
    if (!last || !sameDay(last.ts, item.ts)) {
      scroll.appendChild(
        el("div", { class: "day-divider", text: formatDay(item.ts) })
      );
    }

    if (item.kind === "system") {
      scroll.appendChild(el("sys-line", { text: item.text }));
      this._lastItem = item;
      return;
    }

    if (item.kind !== "message") {
      this._lastItem = item;
      return;
    }

    var grouped =
      last &&
      last.kind === "message" &&
      last.sender === item.sender &&
      !last.failed &&
      item.ts - last.ts < 7 * 60 * 1000;

    var node = document.createElement("message-item");
    node.update(item, {
      grouped: grouped,
      client: this._client,
      room: this._room,
      meUserId: this._meUserId,
    });
    scroll.appendChild(node);
    this._lastItem = item;
  }

  _autosize() {
    var input = this._input;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 144) + "px";
  }

  _submit() {
    var self = this;
    var body = this._input.value;
    if (!body.trim() || !this._room) return;
    this.dispatchEvent(
      new CustomEvent("grungus:send", {
        detail: { roomId: this._room.id, body: body },
        bubbles: true,
      })
    );
    this._input.value = "";
    this._autosize();
    /* keep focus for fast follow-ups */
    setTimeout(function () {
      self._input.focus();
    }, 0);
  }

  setNotice(text) {
    var self = this;
    this._hint.textContent = text || "";
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    if (text) {
      this._noticeTimer = setTimeout(function () {
        self._hint.textContent = "";
      }, 4000);
    }
  }

  _nearBottom() {
    var s = this._scroll;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
  }

  _scrollToBottom() {
    var s = this._scroll;
    s.scrollTop = s.scrollHeight;
  }
}

customElements.define("chat-view", ChatView);
