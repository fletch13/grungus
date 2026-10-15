/*
 * Grungus — <message-item>: one chat message, Discord-style.
 * Handles grouped rendering (consecutive messages from the same sender),
 * pending/failed local echoes, emote/notice formatting, and image/GIF
 * media rendering via authenticated media downloads (GIFs animate
 * natively in an <img>).
 */
import { el, colorFor, formatTime } from "./ui.ts";
import type { MatrixClient, MessageItem, Room } from "../services/matrix-client.ts";

export interface MessageItemOptions {
  grouped?: boolean;
  client: MatrixClient | null;
  room: Room | null;
  meUserId?: string | null;
}

export class MessageItemElement extends HTMLElement {
  private _item: MessageItem | null = null;

  update(item: MessageItem, opts: MessageItemOptions): void {
    this._item = item;
    this._render(opts);
  }

  private _render(opts: MessageItemOptions): void {
    const item = this._item;
    if (!item) return;
    const client = opts.client;

    this.textContent = "";
    this.classList.toggle("grouped", opts.grouped === true);
    this.classList.toggle("pending", item.pending === true);
    this.classList.toggle("failed", item.failed === true);

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
      head.appendChild(el("span", { class: "msg-time", text: formatTime(item.ts) }));
      main.appendChild(head);
    }

    /* media (images, GIFs, stickers) — renders instead of the body text */
    const media = item.media;
    if (media && media.mxc) {
      main.appendChild(this._buildMedia(item, media.mxc, client));
    } else {
      main.appendChild(this._buildBody(item));
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
    return body;
  }
}

customElements.define("message-item", MessageItemElement);

declare global {
  interface HTMLElementTagNameMap {
    "message-item": MessageItemElement;
  }
}
