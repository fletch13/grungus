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
    this._input = el("textarea", {
      rows: "1",
      placeholder: "Message…",
      disabled: true,
    }) as HTMLTextAreaElement;
    this._hint = el("div", { class: "composer-hint" });
    composer.appendChild(this._input);
    wrap.appendChild(composer);
    wrap.appendChild(this._hint);

    this._input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        this._submit();
      }
    });
    this._input.addEventListener("input", () => this._autosize());

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
