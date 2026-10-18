/*
 * Grungus — <message-item>: one chat message, Discord-style.
 * Handles grouped rendering (consecutive messages from the same sender),
 * pending/failed local echoes, emote/notice formatting, image/GIF
 * media rendering via authenticated media downloads, reactions
 * (emoji chips with counts), edits (m.replace with "(edited)"),
 * and reply chains (m.in_reply_to with quoted parent).
 */
import { el, colorFor, formatTime } from "./ui.ts";
import type { MatrixClient, MessageItem, Room } from "../services/matrix-client.ts";

export interface MessageItemOptions {
  grouped?: boolean;
  client: MatrixClient | null;
  room: Room | null;
  meUserId?: string | null;
  /** user preference: hide the per-message timestamp */
  showTimestamps?: boolean;
}

export interface MessageActions {
  onReply?: (item: MessageItem) => void;
  onReact?: (item: MessageItem, emoji: string) => void;
  onEdit?: (item: MessageItem) => void;
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢"];

export class MessageItemElement extends HTMLElement {
  private _item: MessageItem | null = null;

  update(item: MessageItem, opts: MessageItemOptions, actions?: MessageActions): void {
    this._item = item;
    this._render(opts, actions ?? {});
  }

  private _render(opts: MessageItemOptions, actions: MessageActions): void {
    const item = this._item;
    if (!item) return;
    const client = opts.client;

    this.textContent = "";
    this.classList.toggle("grouped", opts.grouped === true);
    this.classList.toggle("pending", item.pending === true);
    this.classList.toggle("failed", item.failed === true);

    /* hover toolbar (reply / react / edit) */
    const toolbar = el("div", { class: "msg-toolbar" });
    if (actions.onReply) {
      const replyBtn = el("button", { class: "msg-toolbar-btn", title: "Reply", text: "↩" });
      replyBtn.addEventListener("click", () => actions.onReply?.(item));
      toolbar.appendChild(replyBtn);
    }
    /* quick reactions */
    for (const emoji of QUICK_REACTIONS.slice(0, 3)) {
      const rBtn = el("button", { class: "msg-toolbar-btn", title: `React ${emoji}`, text: emoji });
      rBtn.addEventListener("click", () => actions.onReact?.(item, emoji));
      toolbar.appendChild(rBtn);
    }
    if (actions.onEdit && item.sender === opts.meUserId && item.id && !item.pending) {
      const editBtn = el("button", { class: "msg-toolbar-btn", title: "Edit", text: "✏️" });
      editBtn.addEventListener("click", () => actions.onEdit?.(item));
      toolbar.appendChild(editBtn);
    }
    this.appendChild(toolbar);

    /* avatar column (kept for alignment when grouped) */
    const avatarCol = el("div", { class: "avatar-col" });
    if (!opts.grouped) {
      const av = document.createElement("g-avatar");
      av.update({
        name: item.senderName,
        userId: item.sender,
        size: 40,
        load:
          client && item.sender && opts.room
            ? client.avatarSrc(
                opts.room.members.get(item.sender)?.avatarMxc ?? null,
                40
              )
            : null,
      });
      avatarCol.appendChild(av);
    }
    this.appendChild(avatarCol);

    const main = el("div", { class: "msg-main" });

    if (!opts.grouped) {
      const head = el("div", { class: "msg-head" });
      const author = el("span", {
        class: "msg-author",
        text: item.senderName || "unknown",
      });
      author.style.color = colorFor(item.sender);
      head.appendChild(author);
      if (opts.showTimestamps !== false) {
        head.appendChild(el("span", { class: "msg-time", text: formatTime(item.ts) }));
      }
      main.appendChild(head);
    }

    /* reply context (quoted parent) */
    if (item.replyTo) {
      const quote = el("div", { class: "msg-reply" });
      const line = el("div", { class: "msg-reply-line" });
      quote.appendChild(line);
      const replyBody = el("div", { class: "msg-reply-body" });
      replyBody.appendChild(
        el("span", { class: "msg-reply-sender", text: item.replyTo.senderName })
      );
      replyBody.appendChild(
        el("span", { class: "msg-reply-text", text: item.replyTo.body })
      );
      quote.appendChild(replyBody);
      main.appendChild(quote);
    }

    /* media (images, GIFs, stickers) — renders instead of the body text */
    const media = item.media;
    if (media && media.mxc) {
      main.appendChild(this._buildMedia(item, media.mxc, client));
    } else {
      main.appendChild(this._buildBody(item));
    }

    /* reactions (emoji chips with counts) */
    if (item.reactions && item.reactions.size > 0) {
      const reactions = el("div", { class: "msg-reactions" });
      for (const [emoji, senders] of item.reactions) {
        if (senders.size === 0) continue;
        const chip = el("button", {
          class: "msg-reaction-chip" +
            (senders.has(opts.meUserId ?? "") ? " mine" : ""),
        });
        chip.appendChild(el("span", { class: "msg-reaction-emoji", text: emoji }));
        chip.appendChild(
          el("span", { class: "msg-reaction-count", text: String(senders.size) })
        );
        chip.addEventListener("click", () => {
          actions.onReact?.(item, emoji);
        });
        reactions.appendChild(chip);
      }
      if (reactions.children.length > 0) {
        main.appendChild(reactions);
      }
    }

    if (item.failed === true) {
      main.appendChild(
        el("div", { class: "msg-error", text: "— failed to send" })
      );
    } else if (item.pending === true) {
      main.appendChild(el("div", { class: "msg-error", text: "sending…" }));
    }

    this.appendChild(main);
  }

  private _buildMedia(item: MessageItem, mxc: string, client: MatrixClient | null): HTMLElement {
    const holder = el("div", { class: "msg-media" });
    const loading = el("span", { class: "msg-media-loading", text: "loading image…" });
    holder.appendChild(loading);

    if (client) {
      void client.mediaSrc(mxc).then((src) => {
        /* the timeline may have re-rendered under us — only paint if we are
           still attached and still the same item */
        if (!src || !this.isConnected) return;
        holder.textContent = "";
        const img = document.createElement("img");
        img.className = "msg-media-img";
        img.alt = item.media?.name ?? "image";
        img.title = img.alt;
        img.src = src;
        holder.appendChild(img);

        const caption = item.media?.name;
        if (caption && caption !== item.body) {
          holder.appendChild(
            el("div", { class: "msg-media-caption", text: caption })
          );
        }
      });
    }
    return holder;
  }

  private _buildBody(item: MessageItem): HTMLElement {
    const body = el("div", { class: "msg-body" });
    if (item.msgtype === "m.emote") {
      body.textContent = `* ${item.senderName} ${item.body}`;
      body.style.fontStyle = "italic";
    } else if (item.msgtype === "m.notice") {
      body.textContent = item.body;
      body.style.color = "var(--text-muted)";
    } else {
      body.textContent = item.body;
    }
    /* "(edited)" indicator for m.replace'd messages */
    if (item.edited) {
      body.appendChild(
        el("span", {
          class: "msg-edited",
          text: " (edited)",
          title: item.editTs ? formatTime(item.editTs) : undefined,
        })
      );
    }
    return body;
  }
}

customElements.define("message-item", MessageItemElement);

declare global {
  interface HTMLElementTagNameMap {
    "message-item": MessageItemElement;
  }
}
