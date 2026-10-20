import { el } from "./ui.ts";
import type { MatrixClient, Room, MessageItem } from "../services/matrix-client.ts";
import "./message-item.ts";

export class RoomDetails extends HTMLElement {
  private room!: Room;
  private client!: MatrixClient;
  private mode: "threads" | "info" = "info";
  private roots = new Map<string, MessageItem>();
  private replies = new Map<string, MessageItem>();
  private root: MessageItem | null = null;
  private next: string | undefined;
  private status = "";
  private loading = false;
  private sending = false;
  private request: AbortController | null = null;
  private sequence = 0;
  private drafts = new Map<string, string>();
  activate(mode: "threads" | "info", room: Room, client: MatrixClient): void {
    const changed = room.id !== this.room?.id || mode !== this.mode;
    if (room.id !== this.room?.id) { this.roots.clear(); this.replies.clear(); this.root = null; this.next = undefined; this.drafts.clear(); this.status = ""; }
    this.room = room; this.client = client; this.mode = mode; this.hidden = false;
    this.render();
    if (changed && mode === "threads") void this.load();
  }
  update(room: Room): void { if (this.room?.id === room.id) { this.room = room; if (!this.hidden) this.render(); } }
  close(): void { this.hidden = true; this.cancel(); }
  disconnectedCallback(): void { this.cancel(); }
  private cancel(): void { this.request?.abort(); this.request = null; this.sequence++; this.loading = false; }
  async openThread(item: MessageItem): Promise<void> {
    const id = item.threadRootId || item.id; if (!id) return;
    this.cancel(); const sequence = this.sequence;
    this.status = "Loading thread…"; this.loading = true; this.render();
    try {
      const root = item.threadRootId ? await this.client.getThreadRoot(this.room.id, id) : item;
      if (sequence !== this.sequence || this.hidden) return;
      if (!root) throw new Error("The thread root could not be decrypted or is unavailable");
      this.root = root; this.replies.clear(); this.next = undefined;
      await this.load();
    } catch (error) { if (sequence === this.sequence) { this.status = `Could not open thread: ${error instanceof Error ? error.message : "unknown error"}`; this.loading = false; this.render(); } }
  }
  private async load(more = false): Promise<void> {
    this.cancel(); this.request = new AbortController(); const sequence = this.sequence;
    this.loading = true; this.status = "Loading…"; this.render();
    try {
      const page = this.root?.id ? await this.client.getThreadReplies(this.room.id, this.root.id, more ? this.next : undefined, this.request.signal)
        : await this.client.getThreads(this.room.id, more ? this.next : undefined, this.request.signal);
      if (sequence !== this.sequence || this.hidden) return;
      const destination = this.root ? this.replies : this.roots;
      if (!more) destination.clear();
      for (const item of page.items) if (item.id) destination.set(item.id, item);
      this.next = page.next; this.status = page.unavailable ? "Some thread messages are unavailable or could not be decrypted yet. Try Refresh after recovering the message keys." : "";
    } catch (error) {
      if (sequence !== this.sequence || this.hidden) return;
      this.status = `Could not load threads from the server: ${error instanceof Error ? error.message : "unknown error"}. Replies already loaded in Chat are shown below.`;
    } finally { if (sequence === this.sequence) { this.loading = false; this.render(); } }
  }
  private message(item: MessageItem): HTMLElement {
    const element = document.createElement("message-item");
    element.update(item, { client: this.client, room: this.room, meUserId: this.client.userId });
    return element;
  }
  private render(): void {
    if (!this.room) return;
    const focused = this.contains(document.activeElement) && document.activeElement instanceof HTMLTextAreaElement;
    const selection = focused ? [(document.activeElement as HTMLTextAreaElement).selectionStart, (document.activeElement as HTMLTextAreaElement).selectionEnd] : null;
    this.replaceChildren();
    if (this.mode === "info") { this.renderInfo(); return; }
    const header = el("div", { class: "room-view-heading" }, el("h2", { text: this.root ? "Thread" : "Threads" }));
    if (this.root) {
      const back = el("button", { class: "call-btn", type: "button", text: "All threads", disabled: this.sending });
      back.addEventListener("click", () => { this.cancel(); this.root = null; this.next = undefined; void this.load(); }); header.append(back);
    }
    const refresh = el("button", { type: "button", class: "call-btn", text: "Refresh", disabled: this.loading });
    refresh.addEventListener("click", () => { void this.load(); }); header.append(refresh); this.append(header);
    if (this.status) this.append(el("p", { class: "settings-hint", role: "status", text: this.status }));
    const messages = this.room.timeline.filter((item): item is MessageItem => item.kind === "message");
    if (this.root?.id) {
      this.append(this.message(this.root));
      const replies = new Map(this.replies);
      for (const item of messages) if (item.threadRootId === this.root.id && item.id) replies.set(item.id, item);
      const ordered = [...replies.values()].sort((a, b) => a.ts - b.ts);
      for (const reply of ordered) this.append(this.message(reply));
      if (!ordered.length && !this.loading) this.append(el("p", { class: "empty-state", text: "No replies yet. Start the conversation below." }));
      const rootId = this.root.id;
      const form = el("form", { class: "thread-composer" });
      const input = el("textarea", { rows: "3", "aria-label": "Thread reply", placeholder: "Reply in thread…", required: true, disabled: this.sending }) as HTMLTextAreaElement;
      input.value = this.drafts.get(rootId) ?? "";
      input.addEventListener("input", () => this.drafts.set(rootId, input.value));
      form.append(input, el("button", { type: "submit", class: "call-btn", text: this.sending ? "Sending…" : "Send thread reply", disabled: this.sending }));
      form.addEventListener("submit", event => {
        event.preventDefault(); const body = input.value; if (!body.trim() || this.sending) return;
        this.sending = true; this.render(); const roomId = this.room.id;
        void this.client.sendThreadReply(roomId, rootId, body, ordered.at(-1)?.id || rootId).then(async () => {
          this.drafts.delete(rootId);
          if (this.room.id === roomId && this.root?.id === rootId) await this.load();
        }).catch(error => { if (this.room.id === roomId) this.status = `Could not send thread reply: ${error instanceof Error ? error.message : "unknown error"}`; }).finally(() => { this.sending = false; this.render(); });
      });
      this.append(form);
      if (selection) { input.focus(); input.setSelectionRange(selection[0]!, selection[1]!); }
    } else {
      const roots = new Map(this.roots);
      for (const item of messages) {
        if (item.threadReplyCount && item.id) roots.set(item.id, item);
        if (item.threadRootId) {
          const root = messages.find(root => root.id === item.threadRootId); if (root?.id) roots.set(root.id, root);
        }
      }
      for (const root of [...roots.values()].sort((a, b) => b.ts - a.ts)) {
        const localCount = messages.filter(item => item.threadRootId === root.id).length;
        const button = el("button", { type: "button", class: "thread-summary", "aria-label": `Open thread: ${root.body.slice(0, 60)}` },
          el("strong", { text: root.senderName }), el("p", { text: root.body }),
          el("small", { text: `${Math.max(localCount, root.threadReplyCount ?? 0)} replies` }));
        button.addEventListener("click", () => { void this.openThread(root); }); this.append(button);
      }
      if (!roots.size && !this.loading) this.append(el("p", { class: "empty-state", text: "No threads found. Use Reply in thread on a message in Chat to start one." }));
    }
    if (this.next) {
      const more = el("button", { type: "button", class: "call-btn", text: "Load more", disabled: this.loading });
      more.addEventListener("click", () => { void this.load(true); }); this.append(more);
    }
  }
  private renderInfo(): void {
    const room = this.room;
    const header = el("div", { class: "room-view-heading" }, el("h2", { text: "Room info" }));
    const settings = el("button", { type: "button", class: "call-btn", text: "Room settings" });
    settings.addEventListener("click", () => this.dispatchEvent(new CustomEvent("grungus:room-settings", { detail: { roomId: room.id }, bubbles: true }))); header.append(settings); this.append(header);
    const avatar = document.createElement("g-avatar"); avatar.update({ name: room.title, userId: room.id, size: 72, load: this.client.avatarSrc(room.avatarMxc, 72) });
    this.append(avatar, el("h3", { text: room.title }), el("p", { text: room.topic || "No topic set." }));
    for (const [label, value] of [["Room ID", room.id], ["Address", room.canonicalAlias || "No address"], ["Encryption", room.isEncrypted ? "End-to-end encrypted" : "Not end-to-end encrypted"], ["Access", room.joinRule || "Not reported"]]) this.append(el("div", { class: "room-info-row" }, el("strong", { text: label }), el("span", { text: value })));
    this.append(el("h3", { text: "Members" }));
    for (const member of room.members.values()) if (["join", "invite"].includes(member.membership)) {
      const av = document.createElement("g-avatar"); av.update({ name: member.displayname || member.userId, userId: member.userId, size: 32, presence: this.client.getPresence?.(member.userId), load: this.client.avatarSrc(member.avatarMxc, 32) });
      this.append(el("div", { class: "room-info-member" }, av, el("span", { text: `${member.displayname || member.userId} · ${member.userId}${member.membership === "invite" ? " (invited)" : ""}` })));
    }
  }
}
customElements.define("room-details", RoomDetails);
declare global { interface HTMLElementTagNameMap { "room-details": RoomDetails; } }
