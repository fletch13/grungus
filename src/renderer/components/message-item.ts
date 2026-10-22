import { mentionedUsers } from "../services/mentions.ts";
import "./message-poll.ts";
import { youtubeVideos } from "../services/youtube.ts";
import { bindUserTile, userLabel } from "./user-menu.ts";
import { attachmentMimeType } from "../services/media-type.ts";
import { formatMessage, emojiOnlyCount } from "../services/message-format.ts";
/*
 * Grungus — <message-item>: one chat message, Discord-style.
 * Handles grouped rendering (consecutive messages from the same sender),
 * pending/failed local echoes, emote/notice formatting, image/GIF
 * media rendering via authenticated media downloads, reactions
 * (emoji chips with counts), edits (m.replace with "(edited)"),
 * and reply chains (m.in_reply_to with quoted parent).
 */
import "./emoji-picker.ts";
import { gifMessageUrl } from "../services/klipy.ts";
import { el, formatTime } from "./ui.ts";
import type { MatrixClient, MessageItem, Room } from "../services/matrix-client.ts";

export interface MessageItemOptions {
  grouped?: boolean;
  client: MatrixClient | null;
  room: Room | null;
  meUserId?: string | null;
  /** user preference: hide the per-message timestamp */
  showTimestamps?: boolean;
  renderMarkdown?: boolean;
}

export interface MessageActions {
  onReply?: (item: MessageItem) => void;
  onThread?: (item: MessageItem) => void;
  onReact?: (item: MessageItem, emoji: string) => void;
  onEdit?: (item: MessageItem) => void;
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "😮", "😢"];

export class MessageItemElement extends HTMLElement {
  private _item: MessageItem | null = null;
  private _reactionPicker: import("./emoji-picker.ts").EmojiPicker | null = null;
  disconnectedCallback(): void { this._reactionPicker?.remove(); this._reactionPicker = null; }


  update(item: MessageItem, opts: MessageItemOptions, actions?: MessageActions): void {
    this._item = item;
    this._render(opts, actions ?? {});
  }

  private _render(opts: MessageItemOptions, actions: MessageActions): void {
    const item = this._item;
    if (!item) return;
    this._reactionPicker?.remove(); this._reactionPicker = null;
    const client = opts.client;
    this.hidden = client?.getIgnoredUsers?.().includes(item.sender) ?? false;
    if (this.hidden) { this.replaceChildren(); return; }

    this.textContent = "";
    this.classList.toggle("grouped", opts.grouped === true);
    this.classList.toggle("pending", item.pending === true);
    this.classList.toggle("failed", item.failed === true);
    const me = opts.meUserId ?? client?.userId;
    const mentionsMe = !!me && (item.mentions?.includes(me) || item.roomMention || mentionedUsers(item.body, [me]).length > 0);
    this.classList.toggle("mentions-me", !!mentionsMe);

    /* hover toolbar (reply / react / edit) */
    const toolbar = el("div", { class: "msg-toolbar" });
    if (actions.onReply) {
      const replyBtn = el("button", { class: "msg-toolbar-btn", title: "Reply", text: "↩" });
      replyBtn.addEventListener("click", () => actions.onReply?.(item));
      toolbar.appendChild(replyBtn);
    }
    if (actions.onThread && item.id && !item.pending && !item.failed) {
      const thread = el("button", { type: "button", class: "msg-toolbar-btn", text: "Thread", "aria-label": "Reply in thread", title: "Reply in thread" });
      thread.addEventListener("click", () => actions.onThread?.(item)); toolbar.append(thread);
    }
    /* quick reactions */
    for (const emoji of actions.onReact && item.id && !item.pending && !item.failed ? QUICK_REACTIONS.slice(0, 3) : []) {
      const rBtn = el("button", { class: "msg-toolbar-btn", title: `React ${emoji}`, text: emoji });
      rBtn.addEventListener("click", () => actions.onReact?.(item, emoji));
      toolbar.appendChild(rBtn);
    }
    if (actions.onReact && item.id && !item.pending && !item.failed) {
      const choose = el("button", { type: "button", class: "msg-toolbar-btn", title: "Choose a reaction", "aria-label": "Choose a reaction", "aria-haspopup": "dialog", "aria-expanded": "false", text: "☺+" });
      choose.addEventListener("click", () => {
        if (!this._reactionPicker) {
          const picker = document.createElement("emoji-picker");
          picker.classList.add("reaction-emoji-picker");
          picker.addEventListener("emoji-select", event => { actions.onReact?.(item, (event as CustomEvent<{ emoji: string }>).detail.emoji); choose.focus(); });
          document.body.append(picker); this._reactionPicker = picker;
        }
        const rect = choose.getBoundingClientRect();
        this._reactionPicker.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 376))}px`;
        this._reactionPicker.style.top = `${Math.max(8, Math.min(rect.bottom + 8, innerHeight - 440))}px`;
        this._reactionPicker.toggle(choose);
      });
      toolbar.append(choose);
    }
    if (actions.onEdit && item.sender === opts.meUserId && item.id && !item.pending) {
      const editBtn = el("button", { class: "msg-toolbar-btn", title: "Edit", text: "✏️" });
      editBtn.addEventListener("click", () => actions.onEdit?.(item));
      toolbar.appendChild(editBtn);
    }
    if (client?.features && opts.room && item.id && !item.pending) {
      const pin = el("button", { type: "button", class: "msg-toolbar-btn", title: "Pin or unpin message", "aria-label": "Pin or unpin message", text: "⌖" }) as HTMLButtonElement;
      pin.addEventListener("click", () => {
        pin.disabled = true;
        void client.features.pins(opts.room!.id).then(async ids => { const pinned = !ids.includes(item.id!); await client.features.pin(opts.room!, item.id!, pinned); pin.title = pinned ? "Message pinned" : "Message unpinned"; })
          .catch(error => { this.append(el("p", { role: "status", class: "msg-error", text: error.message })); }).finally(() => { pin.disabled = false; });
      }); toolbar.append(pin);
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
      bindUserTile(av, client, item.sender, item.senderName || item.sender);
      avatarCol.appendChild(av);
    }
    this.appendChild(avatarCol);

    const main = el("div", { class: "msg-main" });

    if (!opts.grouped) {
      const head = el("div", { class: "msg-head" });
      const author = el("span", {
        class: "msg-author",
        text: userLabel(client, item.sender, item.senderName || "unknown"),
      });

      bindUserTile(author, client, item.sender, item.senderName || item.sender);
      head.appendChild(author);
      if (opts.showTimestamps !== false) {
        head.appendChild(el("span", { class: "msg-time", text: formatTime(item.ts) }));
      }
      main.appendChild(head);
    }

    /* reply context (quoted parent) */
    if (item.replyTo) {
      const quote = el("button", { type: "button", class: "msg-reply", title: "Jump to original message" });
      quote.addEventListener("click", () => { this.dispatchEvent(new CustomEvent("grungus:jump-message", { bubbles: true, detail: { eventId: item.replyTo!.eventId } })); });
      const line = el("div", { class: "msg-reply-line" });
      quote.appendChild(line);
      const replyBody = el("div", { class: "msg-reply-body" });
      replyBody.appendChild(
        el("span", { class: "msg-reply-sender", text: userLabel(client, item.replyTo.sender, item.replyTo.senderName) })
      );
      replyBody.appendChild(
        el("span", { class: "msg-reply-text", text: client?.getIgnoredUsers?.().includes(item.replyTo.sender) ? "Blocked message" : item.replyTo.body })
      );
      quote.appendChild(replyBody);
      main.appendChild(quote);
    }

    if (item.pollEvent && /poll.start$/.test(item.pollEvent.type) && client && opts.room) {
      const poll = document.createElement("message-poll"); poll.update(item, opts.room, client); main.append(poll);
    } else {
      /* Attachments replace ordinary body text. */
      const media = item.media;
      if (media?.mxc) main.appendChild(this._buildMedia(item, media.mxc, client));
      else {
        const body = this._buildBody(item, opts.renderMarkdown !== false);
        this.highlightMentions(body, item, opts);
        main.appendChild(body);
      }
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

  private highlightMentions(body: HTMLElement, item: MessageItem, opts: MessageItemOptions): void {
    const client = opts.client;
    const ids = new Set([...(item.mentions ?? []), ...(opts.room?.members.keys() ?? []), ...(opts.meUserId ? [opts.meUserId] : [])]);
    const candidates = mentionedUsers(item.body, ids).map(id => ({ token: id, id, identity: true }));
    for (const id of item.mentions ?? []) {
      const name = opts.room?.members.get(id)?.displayname;
      if (name) for (const token of [name, `@${name}`]) candidates.push({ token, id, identity: false });
    }
    candidates.sort((a, b) => b.token.length - a.token.length);
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.parentElement?.closest("a,code,pre,button,iframe,.youtube-embed")) nodes.push(node);
    }
    for (const node of nodes) {
      const text = node.textContent ?? "";
      const spans: { start: number; end: number; id: string }[] = [];
      for (const { token, id, identity } of candidates) {
        let start = text.indexOf(token);
        while (start >= 0) {
          const before = text[start - 1], after = text[start + token.length];
          const matches = identity ? mentionedUsers(text.slice(Math.max(0, start - 1), start + token.length + 2), [id]).length > 0 : (!before || !/[\p{L}\p{N}_@]/u.test(before)) && (!after || !/[\p{L}\p{N}_]/u.test(after));
          if (matches && !spans.some(span => start < span.end && start + token.length > span.start)) spans.push({ start, end: start + token.length, id });
          start = text.indexOf(token, start + token.length);
        }
      }
      if (item.roomMention) for (const match of text.matchAll(/(?:^|\s)(@room)(?=$|[\s.,!?])/g)) {
        const start = match.index! + match[0].indexOf("@room"); spans.push({ start, end: start + 5, id: "@room" });
      }
      if (!spans.length) continue;
      const fragment = document.createDocumentFragment(); let position = 0;
      for (const span of spans.sort((a, b) => a.start - b.start)) {
        fragment.append(document.createTextNode(text.slice(position, span.start)));
        const member = opts.room?.members.get(span.id);
        const label = span.id === "@room" ? "room" : userLabel(client, span.id, member?.displayname || span.id.slice(1, span.id.indexOf(":")));
        const pill = el("span", { class: `message-mention${span.id === (opts.meUserId ?? client?.userId) || span.id === "@room" ? " mine" : ""}`, title: span.id, text: label.startsWith("@") ? label : `@${label}` });
        if (span.id !== "@room") bindUserTile(pill, client, span.id, member?.displayname || span.id);
        fragment.append(pill); position = span.end;
      }
      fragment.append(document.createTextNode(text.slice(position))); node.replaceWith(fragment);
    }
  }

  private _buildMedia(item: MessageItem, mxc: string, client: MatrixClient | null): HTMLElement {
    const holder = el("div", { class: "msg-media" });
    const mimeType = attachmentMimeType(item.media?.name || item.body, item.media?.mimetype);
    const kind = item.msgtype === "m.video" || mimeType.startsWith("video/") ? "video"
      : item.msgtype === "m.audio" || mimeType.startsWith("audio/") ? "audio"
      : item.msgtype === "m.file" ? "file" : "image";
    const loading = el("span", { class: "msg-media-loading", text: `Loading ${kind}…` });
    holder.appendChild(loading);
    if (client) {
      const load = async (): Promise<void> => {
        holder.replaceChildren(loading);
        let src: string | null = null;
        try { src = await client.mediaSrc(mxc, item.media?.file, mimeType); } catch { /* Offer retry after download or decryption failure. */ }
        if (!this.isConnected || !this.contains(holder)) return;
        holder.replaceChildren();
        const retry = () => {
          const button = el("button", { class: "msg-media-retry", text: `${kind[0]!.toUpperCase()}${kind.slice(1)} unavailable — retry` });
          button.addEventListener("click", () => { void load(); }); return button;
        };
        if (!src) { holder.append(retry()); return; }
        const name = item.media?.name || item.body || "attachment";
        if (kind === "image") {
          const img = document.createElement("img"); img.className = "msg-media-img"; img.alt = name; img.title = name; img.src = src;
          img.addEventListener("error", () => img.replaceWith(retry())); holder.append(img);
        } else if (kind === "video" || kind === "audio") {
          const player = document.createElement(kind); player.className = "msg-media-player"; player.controls = true; player.preload = "metadata";
          if (player instanceof HTMLVideoElement) player.playsInline = true;
          player.src = src;
          player.addEventListener("error", () => player.replaceWith(el("span", { class: "settings-hint", text: "This media format could not be played. Download it to open in another player." })));
          holder.append(player);
        }
        const download = el("a", { class: "msg-media-download", href: src, download: name, text: `Download ${name}` });
        holder.append(download);
      };
      void load();
    }
    return holder;
  }

  private _buildBody(item: MessageItem, markdown: boolean): HTMLElement {
    const body = el("div", { class: "msg-body" });
    if (item.msgtype === "m.text" && emojiOnlyCount(item.body)) body.classList.add("msg-big-emoji");
    if (item.msgtype === "m.emote") {
      body.textContent = `* ${item.senderName} ${item.body}`;
      body.style.fontStyle = "italic";
    } else if (item.msgtype === "m.notice") {
      body.textContent = item.body;
      body.style.color = "var(--text-muted)";
    } else {
      if (markdown) body.append(formatMessage(item.body));
      else body.textContent = item.body;
    }
    const gifUrl = item.msgtype === "m.text" ? gifMessageUrl(item.body) : null;
    if (gifUrl) {
      body.replaceChildren();
      const link = el("a", { href: gifUrl, target: "_blank", rel: "noopener noreferrer", text: "KLIPY GIF" });
      const retry = el("button", { type: "button", class: "call-btn", text: "Retry GIF" });
      const media = el("div");
      const load = (): void => {
        const image = el("img", { class: "remote-gif", src: gifUrl, alt: "GIF from KLIPY", loading: "lazy", decoding: "async", referrerpolicy: "no-referrer" });
        image.addEventListener("error", () => image.replaceWith(retry));
        media.replaceChildren(image);
      };
      retry.addEventListener("click", load);
      load();
      body.append(media, link);
    }
    if (item.msgtype === "m.text") for (const video of youtubeVideos(item.body)) {
      const frame = el("iframe", { class: "youtube-player", src: video.embedUrl, title: "YouTube video player", loading: "lazy", referrerpolicy: "strict-origin-when-cross-origin", allow: "autoplay; encrypted-media; picture-in-picture; fullscreen", allowfullscreen: true, sandbox: "allow-scripts allow-same-origin allow-presentation" });
      const reload = el("button", { type: "button", class: "msg-media-retry", text: "Reload YouTube player" });
      reload.addEventListener("click", () => { frame.setAttribute("src", video.embedUrl); });
      body.append(el("div", { class: "youtube-embed" }, frame, el("div", { class: "youtube-player-actions" }, reload, el("a", { href: video.watchUrl, target: "_blank", rel: "noopener noreferrer", text: "Open on YouTube" }))));
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
