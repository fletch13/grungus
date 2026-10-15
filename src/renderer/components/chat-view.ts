/*
 * Grungus — <chat-view>: room header, message timeline, composer.
 * Emits "grungus:send" with { roomId, body }. Timeline updates arrive as
 * incremental appends (live events, local echoes) or trigger full
 * re-renders (echo reconciliation markers).
 */
import { el, formatDay, sameDay } from "./ui.ts";
import type { MatrixClient, Room, RoomEvent, TimelineItem } from "../services/matrix-client.ts";

function isTimelineItem(event: RoomEvent): event is TimelineItem {
  return event.kind === "message" || event.kind === "system";
}

export class ChatView extends HTMLElement {
  private _room: Room | null = null;
  private _client: MatrixClient | null = null;
  private _meUserId: string | null = null;
  private _lastItem: TimelineItem | null = null;
  private _noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private _header!: HTMLElement;
  private _scroll!: HTMLElement;
  private _input!: HTMLTextAreaElement;
  private _hint!: HTMLElement;
  private _typingBar!: HTMLElement;
  private _callOngoing = false;
  private _callJoined = false;
  private _typingSentAt = 0;
  private _typingStopTimer: ReturnType<typeof setTimeout> | null = null;

  connectedCallback(): void {
    this._renderSkeleton();
  }

  private _renderSkeleton(): void {
    this.textContent = "";
    this._header = el("div", { class: "chat-header" });
    this._scroll = el("div", { class: "chat-scroll" });
    this._scroll.appendChild(
      el("div", {
        class: "empty-state",
        text: "Pick a room on the left, or log in to get started.",
      })
    );

    const wrap = el("div", { class: "composer-wrap" });
    const composer = el("div", { class: "composer" });
    const attach = el("button", { class: "attach-btn", title: "Send an image", text: "📎" });
    const fileInput = el("input", {
      type: "file",
      accept: "image/*,image/gif",
      class: "hidden-file-input",
    }) as HTMLInputElement;
    this._typingBar = el("div", { class: "typing-bar" });
    this._input = el("textarea", {
      rows: "1",
      placeholder: "Message…",
      disabled: true,
    }) as HTMLTextAreaElement;
    this._hint = el("div", { class: "composer-hint" });
    composer.appendChild(attach);
    composer.appendChild(fileInput);
    composer.appendChild(this._input);
    wrap.appendChild(this._typingBar);
    wrap.appendChild(composer);
    wrap.appendChild(this._hint);

    this._input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
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
    this.appendChild(this._scroll);
    this.appendChild(wrap);
  }

  setRoom(room: Room | null, client: MatrixClient | null, meUserId: string | null): void {
    this._room = room;
    this._client = client;
    this._meUserId = meUserId;

    this._renderHeader();
    if (!room) {
      this._clearTimeline();
      this._input.disabled = true;
      this._input.placeholder = "Message…";
      return;
    }
    this._input.disabled = false;
    this._input.placeholder = `Message ${room.title}`;
    this._renderTimeline();
    this._scrollToBottom();
  }

  clearRoom(): void {
    this.setRoom(null, this._client, this._meUserId);
  }

  private _renderHeader(): void {
    const room = this._room;
    this._header.textContent = "";
    if (!room) {
      this._header.appendChild(el("span", { class: "title", text: "Grungus" }));
      return;
    }
    this._header.appendChild(
      el("span", {
        class: "title",
        text: `${room.isEncrypted ? "🔒 " : ""}${room.title}`,
        title: room.isEncrypted ? "End-to-end encrypted (megolm)" : undefined,
      })
    );
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
        text: this._callOngoing ? "Join call" : "📞",
        title: this._callOngoing ? "Join the ongoing call" : "Start a call",
      });
      callBtn.addEventListener("click", () => {
        this.dispatchEvent(
          new CustomEvent("grungus:start-call", {
            detail: { roomId: room.id },
            bubbles: true,
          })
        );
      });
      controls.appendChild(callBtn);
    }
    if (room.isEncrypted) {
      const verifyBtn = el("button", {
        class: "call-btn-header",
        text: "🛡",
        title: "Verify other members' devices (SAS)",
      });
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
    for (const item of room.timeline) {
      this._appendItem(item);
    }
  }

  /**
   * Incremental updates from the sync loop. Batches containing an echo
   * marker trigger a full re-render instead of appending (the client's
   * room.timeline already holds the reconciled state).
   */
  appendEvents(room: Room, events: RoomEvent[]): void {
    if (!this._room || room.id !== this._room.id) return;
    const hasMarker = events.some(
      (event) => event.kind === "echo-replaced" || event.kind === "echo-failed"
    );
    if (hasMarker) {
      const pinned = this._nearBottom();
      this._renderTimeline();
      if (pinned) this._scrollToBottom();
      return;
    }
    const pinned = this._nearBottom();
    const items = events.filter(isTimelineItem);
    const fromMe = items.some(
      (item) => item.kind === "message" && item.sender === this._meUserId
    );
    for (const item of items) this._appendItem(item);
    if (pinned || fromMe) this._scrollToBottom();
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
    });
    this._scroll.appendChild(node);
    this._lastItem = item;
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

  private _typingPulse(): void {
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
