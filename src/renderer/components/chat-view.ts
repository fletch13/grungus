import "./room-details.ts";
import { isVideoRoom } from "../services/room-kind.ts";
/*
 * Grungus — <chat-view>: room header, message timeline, composer.
 * Emits "grungus:send" with { roomId, body }. Timeline updates arrive as
 * incremental appends (live events, local echoes) or trigger full
 * re-renders (echo reconciliation markers).
 */
import "./emoji-picker.ts";
import "./gif-picker.ts";
import { icon } from "./icons.ts";
import { el, formatDay, sameDay } from "./ui.ts";
import type { MatrixClient, MessageItem, Room, RoomEvent, TimelineItem } from "../services/matrix-client.ts";

export class ChatView extends HTMLElement {
  private _gifPicker!: import("./gif-picker.ts").GifPicker;
  setKlipyApiKey(key: string): void { this._gifPicker.setApiKey(key); }
  private _emojiPicker!: import("./emoji-picker.ts").EmojiPicker;
  private _room: Room | null = null;
  private _client: MatrixClient | null = null;
  private _meUserId: string | null = null;
  private _lastItem: TimelineItem | null = null;
  private _noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private _header!: HTMLElement;
  private _tabs!: HTMLElement;
  private _details!: import("./room-details.ts").RoomDetails;
  private _composerWrap!: HTMLElement;
  private _tab: "chat" | "threads" | "info" = "chat";
  private selectTab(tab: "chat" | "threads" | "info"): void {
    this._tab = tab;
    this._scroll.hidden = tab !== "chat"; this._historyControls.hidden = tab !== "chat"; this._composerWrap.hidden = tab !== "chat";
    this._tabs.replaceChildren();
    for (const [id, title] of [["chat", "Chat"], ["threads", "Threads"], ["info", "Info"]] as const) {
      const button = el("button", { type: "button", role: "tab", "aria-selected": String(tab === id), tabindex: tab === id ? "0" : "-1", "aria-controls": id === "chat" ? "room-chat-content" : "room-details-content", text: title });
      button.addEventListener("click", () => this.selectTab(id)); this._tabs.append(button);
    }
    if (tab !== "chat" && this._room && this._client) this._details.activate(tab, this._room, this._client);
    else this._details.close();
  }
  private _scroll!: HTMLElement;
  private _historyControls!: HTMLElement;
  private _windowAnchor: string | null = null;
  private _windowStart = 0;
  private _input!: HTMLTextAreaElement;
  private _hint!: HTMLElement;
  private _encryptionStatus!: HTMLElement;
  private _typingBar!: HTMLElement;
  private _callOngoing = false;
  private _callConnecting = false;
  private _callJoined = false;
  private _typingSentAt = 0;
  private _typingStopTimer: ReturnType<typeof setTimeout> | null = null;
  /* user preferences (settings overlay) */
  private _enterToSend = true;
  private _sendTyping = true;
  private _showTimestamps = true;
  private _renderMarkdown = true;
  private _autoScroll = true;
  private _showTyping = true;
  private _typingUsers: string[] = [];
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
    this._composerWrap = wrap;
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
    const emojiButton = el("button", { type: "button", class: "attach-btn emoji-toggle", text: "☺", title: "Choose an emoji", "aria-label": "Choose an emoji", "aria-haspopup": "dialog", "aria-expanded": "false" });
    this._emojiPicker = document.createElement("emoji-picker");
    emojiButton.addEventListener("click", () => {
      if (this._room && !this._input.disabled) { this._gifPicker.close(false); this._emojiPicker.toggle(emojiButton); }
    });
    this._emojiPicker.addEventListener("emoji-select", event => {
      if (!this._room || this._input.disabled) return;
      const emoji = (event as CustomEvent<{ emoji: string }>).detail.emoji;
      this._input.setRangeText(emoji, this._input.selectionStart, this._input.selectionEnd, "end");
      this._input.dispatchEvent(new Event("input"));
      this._input.focus();
    });
    composer.appendChild(emojiButton);
    wrap.appendChild(this._emojiPicker);
    const gifButton = el("button", { type: "button", class: "attach-btn gif-toggle", text: "GIF", title: "Choose a GIF", "aria-label": "Choose a GIF", "aria-haspopup": "dialog", "aria-expanded": "false" });
    this._gifPicker = document.createElement("gif-picker");
    gifButton.addEventListener("click", () => {
      if (this._room && !this._input.disabled) { this._emojiPicker.close(false); this._gifPicker.toggle(gifButton); }
    });
    this._gifPicker.addEventListener("gif-select", event => {
      if (!this._room || this._input.disabled) return;
      const { gif } = (event as CustomEvent<{ gif: import("../services/klipy.ts").KlipyGif }>).detail;
      this.dispatchEvent(new CustomEvent("grungus:send-gif", { detail: { roomId: this._room.id, url: gif.url }, bubbles: true }));
      this._input.focus();
    });
    composer.appendChild(gifButton); wrap.appendChild(this._gifPicker);

    wrap.appendChild(this._replyBar);
    wrap.appendChild(this._typingBar);
    wrap.appendChild(this._seenBar);
    wrap.appendChild(composer);
    this._encryptionStatus = el("div", { class: "chat-encryption-status", role: "status", "aria-live": "polite", hidden: true });
    wrap.appendChild(this._encryptionStatus);
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

    this._tabs = el("nav", { class: "room-tabs", role: "tablist", "aria-label": "Room views", hidden: true });
    this._tabs.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      const ids = ["chat", "threads", "info"] as const;
      const index = ids.indexOf(this._tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowRight" ? 1 : 2)) % 3;
      event.preventDefault(); this.selectTab(ids[next]!); this._tabs.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    });
    this._details = document.createElement("room-details"); this._details.id = "room-details-content"; this._details.hidden = true;
    this._scroll.id = "room-chat-content";
    this.appendChild(this._header);
    this.appendChild(this._tabs);
    this.appendChild(this._details);
    this.appendChild(this._historyControls);
    this.appendChild(this._scroll);
    this.appendChild(wrap);
  }

  setRoom(room: Room | null, client: MatrixClient | null, meUserId: string | null): void {
    const changedRoom = room?.id !== this._room?.id;
    const previousScroll = this._scroll.scrollTop;
    const pinned = this._windowAnchor === null && this._nearBottom();
    if (changedRoom) { this._windowAnchor = null; this._emojiPicker.close(false); this._gifPicker.close(false); }
    this._room = room;
    this._client = client;
    this._meUserId = meUserId;

    this._renderHeader();
    this._tabs.hidden = !room;
    if (changedRoom) this._tab = "chat";
    this.selectTab(this._tab);
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
    if (changedRoom || (pinned && this._autoScroll)) this._scrollToBottom();
    else this._scroll.scrollTop = previousScroll;
    this.refreshSeenState();
  }

  clearRoom(): void {
    this.setRoom(null, this._client, this._meUserId);
  }

  private _renderHeader(): void {
    const room = this._room;
    this._header.textContent = "";
    this._encryptionStatus.hidden = !room;
    this._encryptionStatus.replaceChildren();
    if (room) {
      this._encryptionStatus.classList.toggle("unencrypted", !room.isEncrypted);
      this._encryptionStatus.append(icon("shield", 14), el("span", {
        text: room.isEncrypted ? "New messages are end-to-end encrypted." : "Messages are not end-to-end encrypted.",
      }));
      this._encryptionStatus.title = room.isEncrypted
        ? "Only participants’ devices can read new messages. Device verification is managed separately. Earlier messages may have been sent before encryption was enabled."
        : "This conversation does not use end-to-end encryption. The homeserver can read messages.";
    }
    const mobileRooms = el("button", { class: "mobile-room-toggle", "aria-label": "Show conversations", title: "Show conversations" }, icon("folder"));
    mobileRooms.addEventListener("click", () => this.closest("app-shell")?.classList.toggle("show-rooms"));
    this._header.appendChild(mobileRooms);
    if (!room) {
      this._header.appendChild(el("span", { class: "title", text: "Grungus" }));
      return;
    }
    this._header.appendChild(el("span", { class: "channel-symbol" }, icon(room.isDirect ? "bubble" : isVideoRoom(room) ? "video" : "hash", 22)));
    this._header.appendChild(
      el("span", {
        class: "title",
        text: room.title,
        title: room.isEncrypted ? "End-to-end encrypted (megolm)" : undefined,
      })
    );
    this._header.appendChild(el("span", {
      class: `encryption-label${room.isEncrypted ? "" : " unencrypted"}`,
      title: room.isEncrypted ? "New messages are end-to-end encrypted. This does not indicate device verification." : "Messages are not end-to-end encrypted. The homeserver can read them.",
    }, icon("shield", 13), room.isEncrypted ? "End-to-end encrypted" : "Not encrypted"));
    const sub = room.topic
      ? `${room.topic}  ·  ${room.joinedMemberCount} members`
      : `${room.joinedMemberCount} members`;
    this._header.appendChild(el("span", { class: "topic", text: sub }));

    /* call controls */
    const controls = el("div", { class: "header-call-controls" });
    if (this._callConnecting) {
      controls.append(el("button", { class: "call-btn-header", disabled: true, text: "Connecting…", "aria-label": "Connecting to call" }));
    } else if (this._callJoined) {
      controls.appendChild(el("span", { class: "call-live", text: "● in call" }));
    } else if (isVideoRoom(room)) {
      const join = el("button", { class: "call-btn-header", text: this._callOngoing ? "Join call" : "Start call", "aria-label": this._callOngoing ? "Join persistent call" : "Start room call", title: this._callOngoing ? "Join this room’s active call" : "Start a call in this video room" }, icon("video", 16));
      join.addEventListener("click", () => this.dispatchEvent(new CustomEvent("grungus:join-room-call", { detail: { roomId: room.id }, bubbles: true })));
      controls.appendChild(join);
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
  setCallConnecting(connecting: boolean): void {
    this._callConnecting = connecting;
    if (this._room) this._renderHeader();
  }
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
    this._details.update(room);
    if (events.length === 0) { this._renderHistoryControls(); return; }
    const pinned = this._autoScroll && this._nearBottom() && this._windowAnchor === null;
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
      if (item.callActivity) {
        const card = el("div", { class: "timeline-call-card" }, icon("video", 22),
          el("div", {}, el("strong", { text: item.text }), el("small", { text: new Date(item.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })));
        if (item.callActivity === "started" || item.callActivity === "joined") {
          const open = el("button", { type: "button", class: "call-btn-header", text: "Open call", "aria-label": "Open room call" });
          open.addEventListener("click", () => {
            if (this._room && !this._callConnecting && !this._callJoined) this.dispatchEvent(new CustomEvent("grungus:join-room-call", { detail: { roomId: this._room.id }, bubbles: true }));
          });
          card.append(open);
        }
        this._scroll.append(card);
      } else this._scroll.appendChild(el("sys-line", { text: item.text }));
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
      renderMarkdown: this._renderMarkdown,
    }, {
      onReply: (msg) => this._startReply(msg),
      onThread: (msg) => { this.selectTab("threads"); void this._details.openThread(msg); },
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
    this._typingUsers = users;
    if (!this._typingBar) return;
    if (!this._showTyping) { this._typingBar.textContent = ""; return; }
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
    renderMarkdown?: boolean;
    autoScroll?: boolean;
    showTyping?: boolean;
  }): void {
    const timestampsChanged = this._showTimestamps !== prefs.showTimestamps || this._renderMarkdown !== (prefs.renderMarkdown ?? true);
    const stopTyping = this._sendTyping && !prefs.sendTyping;
    this._renderMarkdown = prefs.renderMarkdown ?? true;
    this._autoScroll = prefs.autoScroll ?? true;
    this._showTyping = prefs.showTyping ?? true;
    this._enterToSend = prefs.enterToSend;
    this._sendTyping = prefs.sendTyping;
    this._showTimestamps = prefs.showTimestamps;
    if (stopTyping) this._typingStop();
    this.setTypingUsers(this._typingUsers);
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

  setNotice(text: string, persistent = false): void {
    this._hint.textContent = text;
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    if (text && !persistent) {
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
