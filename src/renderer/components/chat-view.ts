/*
 * Grungus — <chat-view>: room header, message timeline, composer.
 * Emits "grungus:send" with { roomId, body }. Timeline updates arrive as
 * incremental appends (live events, local echoes) or trigger full
 * re-renders (echo reconciliation markers).
 */
import { icon } from "./icons.ts";
import { el, formatDay, sameDay } from "./ui.ts";
import type { MatrixClient, MessageItem, Room, RoomEvent, TimelineItem } from "../services/matrix-client.ts";

export class ChatView extends HTMLElement {
  private _room: Room | null = null;
  private _client: MatrixClient | null = null;
  private _meUserId: string | null = null;
  private _lastItem: TimelineItem | null = null;
  private _noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private _header!: HTMLElement;
  private _scroll!: HTMLElement;
  private _historyControls!: HTMLElement;
  private _windowAnchor: string | null = null;
  private _windowStart = 0;
  private _input!: HTMLTextAreaElement;
  private _hint!: HTMLElement;
  private _typingBar!: HTMLElement;
  private _callOngoing = false;
  private _callJoined = false;
  private _typingSentAt = 0;
  private _typingStopTimer: ReturnType<typeof setTimeout> | null = null;
  /* user preferences (settings overlay) */
  private _enterToSend = true;
  private _sendTyping = true;
  private _showTimestamps = true;
  /** the DM "Seen" indicator bar (below the timeline) */
  private _seenBar: HTMLElement | null = null;
  private _replyTarget: { eventId: string; sender: string; senderName: string; body: string } | null = null;
  private _replyBar: HTMLElement | null = null;
  private _editTarget: MessageItem | null = null;

  connectedCallback(): void {
    this._renderSkeleton();
  }

  private _renderSkeleton(): void {
    this.textContent = "";
    this._header = el("div", { class: "chat-header" });
    this._historyControls = el("nav", { class: "history-controls", "aria-label": "Message history" });
    this._scroll = el("div", { class: "chat-scroll" });
    this._scroll.appendChild(
      el("div", {
        class: "empty-state",
        text: "Pick a room on the left, or log in to get started.",
      })
    );

    const wrap = el("div", { class: "composer-wrap" });
    const composer = el("div", { class: "composer" });
    const attach = el("button", { class: "attach-btn", title: "Send an image", "aria-label": "Send an image" });
    attach.appendChild(icon("plus", 20));
    const fileInput = el("input", {
      type: "file",
      accept: "image/*,image/gif",
      class: "hidden-file-input",
    }) as HTMLInputElement;
    this._typingBar = el("div", { class: "typing-bar" });
    this._seenBar = el("div", { class: "seen-bar" });
    this._replyBar = el("div", { class: "reply-bar" });
    this._replyBar.style.display = "none";
    this._input = el("textarea", {
      rows: "1",
      placeholder: "Message…",
      disabled: true,
    }) as HTMLTextAreaElement;
    this._hint = el("div", { class: "composer-hint" });
    composer.appendChild(attach);
    composer.appendChild(fileInput);
    composer.appendChild(this._input);
    wrap.appendChild(this._replyBar);
    wrap.appendChild(this._typingBar);
    wrap.appendChild(this._seenBar);
    wrap.appendChild(composer);
    wrap.appendChild(this._hint);

    this._input.addEventListener("keydown", (event) => {
      const wantsSend = this._enterToSend
        ? event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey
        : event.key === "Enter" && (event.ctrlKey || event.metaKey);
      if (wantsSend) {
        event.preventDefault();
        this._submit();
        this._typingStop();
      }
    });
    this._input.addEventListener("input", () => {
      this._autosize();
      this._typingPulse();
    });

    attach.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
      fileInput.value = "";
      if (!file || !this._room) return;
      this.dispatchEvent(
        new CustomEvent("grungus:send-media", {
          detail: { roomId: this._room.id, file },
          bubbles: true,
        })
      );
    });

    this.appendChild(this._header);
    this.appendChild(this._historyControls);
    this.appendChild(this._scroll);
    this.appendChild(wrap);
  }

  setRoom(room: Room | null, client: MatrixClient | null, meUserId: string | null): void {
    const changedRoom = room?.id !== this._room?.id;
    const previousScroll = this._scroll.scrollTop;
    const pinned = this._windowAnchor === null && this._nearBottom();
    if (changedRoom) this._windowAnchor = null;
    this._room = room;
    this._client = client;
    this._meUserId = meUserId;

    this._renderHeader();
    if (!room) {
      this._clearTimeline();
      this._historyControls.textContent = "";
      this._input.disabled = true;
      this._input.placeholder = "Message…";
      return;
    }
    this._input.disabled = false;
    this._input.placeholder = `Message ${room.title}`;
    this._renderTimeline();
    if (changedRoom || pinned) this._scrollToBottom();
    else this._scroll.scrollTop = previousScroll;
    this.refreshSeenState();
  }

  clearRoom(): void {
    this.setRoom(null, this._client, this._meUserId);
  }

  private _renderHeader(): void {
    const room = this._room;
    this._header.textContent = "";
    const mobileRooms = el("button", { class: "mobile-room-toggle", "aria-label": "Show conversations", title: "Show conversations" }, icon("folder"));
    mobileRooms.addEventListener("click", () => this.closest("app-shell")?.classList.toggle("show-rooms"));
    this._header.appendChild(mobileRooms);
    if (!room) {
      this._header.appendChild(el("span", { class: "title", text: "Grungus" }));
      return;
    }
    this._header.appendChild(el("span", { class: "channel-symbol" }, icon(room.isDirect ? "bubble" : "hash", 22)));
    this._header.appendChild(
      el("span", {
        class: "title",
        text: room.title,
        title: room.isEncrypted ? "End-to-end encrypted (megolm)" : undefined,
      })
    );
    if (room.isEncrypted) this._header.appendChild(el("span", { class: "encryption-label", title: "End-to-end encrypted" }, icon("shield", 13), "Encrypted"));
    const sub = room.topic
      ? `${room.topic}  ·  ${room.joinedMemberCount} members`
      : `${room.joinedMemberCount} members`;
    this._header.appendChild(el("span", { class: "topic", text: sub }));

    /* call controls */
    const controls = el("div", { class: "header-call-controls" });
    if (this._callJoined) {
      controls.appendChild(el("span", { class: "call-live", text: "● in call" }));
    } else {
      const callBtn = el("button", {
        class: "call-btn-header",
        text: this._callOngoing ? "Join call" : undefined,
        "aria-label": this._callOngoing ? "Join call" : "Start a call",
        title: this._callOngoing ? "Join the ongoing call" : "Start a call",
      });
      if (!this._callOngoing) callBtn.appendChild(icon("phone"));
      callBtn.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("grungus:start-call", {
            detail: { roomId: room.id },
            bubbles: true,
          })
        );
      });
      controls.appendChild(callBtn);
      /* video call: the offer carries a camera m-line (and screenshare
         needs one to ride) */
      if (!this._callOngoing) {
        const videoBtn = el("button", {
          class: "call-btn-header",
          "aria-label": "Start a video call",
          title: "Start a video call",
        });
        videoBtn.appendChild(icon("video"));
        videoBtn.addEventListener("click", () => {
          this.dispatchEvent(
            new CustomEvent("grungus:start-call", {
              detail: { roomId: room.id, video: true },
              bubbles: true,
            })
          );
        });
        controls.appendChild(videoBtn);
      }
    }
    if (room.isEncrypted) {
      const verifyBtn = el("button", {
        class: "call-btn-header",
        "aria-label": "Verify devices",
        title: "Verify other members' devices (SAS)",
      });
      verifyBtn.appendChild(icon("shield"));
      verifyBtn.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("grungus:verify-devices", { bubbles: true })
        );
      });
      controls.appendChild(verifyBtn);
    }
    this._header.appendChild(controls);
  }

  /** Re-render the header's call controls (call state changed). */
  setCallState(ongoing: boolean, joined: boolean): void {
    this._callOngoing = ongoing;
    this._callJoined = joined;
    if (this._room) this._renderHeader();
  }

  private _clearTimeline(): void {
    this._scroll.textContent = "";
    this._lastItem = null;
    this._scroll.appendChild(
      el("div", { class: "empty-state", text: "No room selected." })
    );
  }

  /** Rebuild the timeline from room.timeline (echo reconciliation etc). */
  private _renderTimeline(): void {
    const room = this._room;
    if (!room) {
      this._clearTimeline();
      return;
    }
    this._scroll.textContent = "";
    this._lastItem = null;
    const anchor = this._windowAnchor ? room.timeline.findIndex(item => item.id === this._windowAnchor) : -1;
    this._windowStart = this._windowAnchor ? Math.max(0, anchor) : Math.max(0, room.timeline.length - 100);
    const end = Math.min(room.timeline.length, this._windowStart + 100);
    for (const item of room.timeline.slice(this._windowStart, end)) this._appendItem(item);
    this._renderHistoryControls();
  }

  private _renderHistoryControls(): void {
    const room = this._room;
    this._historyControls.textContent = "";
    if (!room) return;
    const older = el("button", { text: room.historyLoading ? "Loading…" : "Earlier messages", disabled: room.historyLoading || (this._windowStart === 0 && !room.historyCursor) });
    older.addEventListener("click", () => {
      void (async () => {
        if (this._windowStart > 0) {
          this._windowAnchor = room.timeline[Math.max(0, this._windowStart - 100)]?.id ?? null;
        } else {
          const first = room.timeline[0]?.id;
          await this._client?.loadOlderMessages(room.id);
          if (this._room !== room) return;
          const previousStart = room.timeline.findIndex(item => item.id === first);
          this._windowAnchor = room.timeline[Math.max(0, previousStart - 100)]?.id ?? null;
        }
        this._renderTimeline();
        this._scroll.scrollTop = 0;
      })().catch(error => this.setNotice(`Could not load history: ${error instanceof Error ? error.message : "unknown error"}`));
    });
    const newer = el("button", { text: "Newer messages", disabled: this._windowStart + 100 >= room.timeline.length });
    newer.addEventListener("click", () => {
      const next = this._windowStart + 100;
      this._windowAnchor = next + 100 >= room.timeline.length ? null : room.timeline[next]?.id ?? null;
      this._renderTimeline();
      this._scroll.scrollTop = 0;
    });
    const latest = el("button", { text: "Latest messages", disabled: room.historyLoading });
    latest.addEventListener("click", () => {
      void (async () => {
        if (room.atLiveEdge === false) await this._client?.loadLatestMessages(room.id);
        if (this._room !== room) return;
        this._windowAnchor = null;
        this._renderTimeline();
        this._scrollToBottom();
      })().catch(error => this.setNotice(`Could not load messages: ${error instanceof Error ? error.message : "unknown error"}`));
    });
    this._historyControls.append(older, newer, latest);
  }

  /**
   * Incremental updates from the sync loop. Batches containing an echo
   * marker trigger a full re-render instead of appending (the client's
   * room.timeline already holds the reconciled state).
   */
  appendEvents(room: Room, events: RoomEvent[]): void {
    if (!this._room || room.id !== this._room.id) return;
    if (events.length === 0) { this._renderHistoryControls(); return; }
    const pinned = this._nearBottom() && this._windowAnchor === null;
    if (!pinned && !this._windowAnchor) this._windowAnchor = room.timeline[this._windowStart]?.id ?? null;
    const position = this._scroll.scrollTop;
    this._renderTimeline();
    if (pinned) this._scrollToBottom();
    else this._scroll.scrollTop = position;
  }

  private _appendItem(item: TimelineItem): void {
    const last = this._lastItem;

    /* day divider */
    if (!last || !sameDay(last.ts, item.ts)) {
      this._scroll.appendChild(
        el("div", { class: "day-divider", text: formatDay(item.ts) })
      );
    }

    if (item.kind === "system") {
      this._scroll.appendChild(el("sys-line", { text: item.text }));
      this._lastItem = item;
      return;
    }

    const grouped =
      last !== null &&
      last.kind === "message" &&
      last.sender === item.sender &&
      !last.failed &&
      item.ts - last.ts < 7 * 60 * 1000;

    const node = document.createElement("message-item");
    node.update(item, {
      grouped,
      client: this._client,
      room: this._room,
      meUserId: this._meUserId,
      showTimestamps: this._showTimestamps,
    }, {
      onReply: (msg) => this._startReply(msg),
      onReact: (msg, emoji) => {
        this.dispatchEvent(
          new CustomEvent("grungus:react", {
            detail: { roomId: this._room?.id, eventId: msg.id, emoji },
            bubbles: true,
          })
        );
      },
      onEdit: (msg) => this._startEdit(msg),
    });
    this._scroll.appendChild(node);
    this._lastItem = item;
  }

  /* ------------------------- reply / edit state ------------------------- */

  /** Show the reply bar and prefill the composer for a reply. */
  private _startReply(msg: MessageItem): void {
    if (!msg.id || !this._replyBar) return;
    this._replyTarget = {
      eventId: msg.id,
      sender: msg.sender,
      senderName: msg.senderName,
      body: msg.body.slice(0, 120),
    };
    this._editTarget = null;
    this._renderReplyBar();
    this._input.placeholder = `Reply to ${msg.senderName}…`;
    this._input.focus();
  }

  /** Pre-fill the composer for editing one of your own messages. */
  private _startEdit(msg: MessageItem): void {
    if (!msg.id) return;
    this._editTarget = msg;
    this._replyTarget = null;
    this._replyBar!.style.display = "none";
    this._input.value = msg.body;
    this._input.placeholder = "Edit message…";
    this._autosize();
    this._input.focus();
  }

  private _clearReplyEdit(): void {
    this._replyTarget = null;
    this._editTarget = null;
    if (this._replyBar) this._replyBar.style.display = "none";
    this._input.placeholder = "Message…";
  }

  private _renderReplyBar(): void {
    if (!this._replyBar || !this._replyTarget) return;
    this._replyBar.style.display = "";
    this._replyBar.textContent = "";
    this._replyBar.appendChild(
      el("span", { class: "reply-bar-sender", text: this._replyTarget.senderName })
    );
    this._replyBar.appendChild(
      el("span", { class: "reply-bar-text", text: this._replyTarget.body })
    );
    const close = el("button", { class: "reply-bar-close", text: "✕" });
    close.addEventListener("click", () => this._clearReplyEdit());
    this._replyBar.appendChild(close);
  }

  /** Update the "X is typing…" bar from the room's ephemeral state. */
  setTypingUsers(users: string[]): void {
    if (!this._typingBar) return;
    this._typingBar.textContent =
      users.length === 0
        ? ""
        : users.length === 1
          ? `${users[0]} is typing…`
          : `${users.slice(0, 2).join(", ")}${users.length > 2 ? " and others" : ""} are typing…`;
  }

  /**
   * Receipts changed (someone read our messages) — update the DM
   * "Seen" indicator without a full timeline re-render.
   */
  refreshSeenState(): void {
    const room = this._room;
    const client = this._client;
    const me = this._meUserId;
    const prev = this._seenBar;
    if (!room || !client || !me || !prev) {
      if (prev) prev.textContent = "";
      return;
    }
    /* DMs only; the indicator sits under OUR latest message */
    if (!room.isDirect) {
      prev.textContent = "";
      return;
    }
    const peer = room.directUserId;
    if (!peer) {
      prev.textContent = "";
      return;
    }
    /* our last message in the timeline */
    let lastMine: string | null = null;
    for (let i = room.timeline.length - 1; i >= 0; i--) {
      const item = room.timeline[i]!;
      if (item.kind === "message" && item.sender === me && item.id) {
        lastMine = item.id;
        break;
      }
    }
    if (!lastMine) {
      prev.textContent = "";
      return;
    }
    prev.textContent = client.receiptCoversEvent(room.id, peer, lastMine)
      ? "👁 Seen"
      : "";
  }

  /** Apply user preferences from the settings overlay. */
  applyPreferences(prefs: {
    enterToSend: boolean;
    sendTyping: boolean;
    showTimestamps: boolean;
  }): void {
    const timestampsChanged = this._showTimestamps !== prefs.showTimestamps;
    this._enterToSend = prefs.enterToSend;
    this._sendTyping = prefs.sendTyping;
    this._showTimestamps = prefs.showTimestamps;
    if (timestampsChanged && this._room) this._renderTimeline();
  }

  private _typingPulse(): void {
    if (!this._sendTyping) return;
    this.dispatchEvent(new CustomEvent("grungus:typing", { bubbles: true }));
    if (this._typingStopTimer) clearTimeout(this._typingStopTimer);
    this._typingStopTimer = setTimeout(() => this._typingStop(), 12_000);
  }

  private _typingStop(): void {
    if (this._typingStopTimer) {
      clearTimeout(this._typingStopTimer);
      this._typingStopTimer = null;
    }
    this.dispatchEvent(
      new CustomEvent("grungus:typing-stop", { bubbles: true })
    );
  }

  private _autosize(): void {
    const input = this._input;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
  }

  private _submit(): void {
    const body = this._input.value;
    if (!body.trim() || !this._room) return;

    /* edit mode: dispatch an edit event instead of a new message */
    if (this._editTarget && this._editTarget.id) {
      const editId = this._editTarget.id;
      this._clearReplyEdit();
      this._input.value = "";
      this._autosize();
      this.dispatchEvent(
        new CustomEvent("grungus:edit", {
          detail: { roomId: this._room.id, eventId: editId, body },
          bubbles: true,
        })
      );
      setTimeout(() => this._input.focus(), 0);
      return;
    }

    /* reply mode: include the parent context */
    if (this._replyTarget) {
      const rt = this._replyTarget;
      this._clearReplyEdit();
      this._input.value = "";
      this._autosize();
      this.dispatchEvent(
        new CustomEvent("grungus:send-reply", {
          detail: {
            roomId: this._room.id,
            parentEventId: rt.eventId,
            parentSender: rt.sender,
            parentBody: rt.body,
            body,
          },
          bubbles: true,
        })
      );
      setTimeout(() => this._input.focus(), 0);
      return;
    }

    this.dispatchEvent(
      new CustomEvent("grungus:send", {
        detail: { roomId: this._room.id, body },
        bubbles: true,
      })
    );
    this._input.value = "";
    this._autosize();
    /* keep focus for fast follow-ups */
    setTimeout(() => this._input.focus(), 0);
  }

  setNotice(text: string): void {
    this._hint.textContent = text;
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    if (text) {
      this._noticeTimer = setTimeout(() => {
        this._hint.textContent = "";
      }, 4000);
    }
  }

  private _nearBottom(): boolean {
    const s = this._scroll;
    return s.scrollHeight - s.scrollTop - s.clientHeight < 140;
  }

  private _scrollToBottom(): void {
    const s = this._scroll;
    s.scrollTop = s.scrollHeight;
  }
}

customElements.define("chat-view", ChatView);

declare global {
  interface HTMLElementTagNameMap {
    "chat-view": ChatView;
  }
}
