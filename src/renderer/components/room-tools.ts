import { canChangeState } from "../services/room-permissions.ts";
import { el } from "./ui.ts";
import { userLabel } from "./user-menu.ts";
import { parsePoll, tallyPoll, searchLoaded } from "../services/room-features.ts";
import type { MatrixClient, Room, MessageItem } from "../services/matrix-client.ts";
import "./message-item.ts";
export class RoomTools extends HTMLElement {
  private room!: Room;
  private client!: MatrixClient;
  private mode: "search" | "pins" | "polls" | "media" = "search";
  private generation = 0;
  private busy = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private root: MessageItem | null = null;
  private content!: HTMLElement;
  private status!: HTMLElement;
  private opener: HTMLElement | null = null;
  disconnectedCallback(): void { this.stop(); }
  private stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  hide(): void { this.generation++; this.stop(); this.root = null; this.hidden = true; this.replaceChildren(); this.opener?.focus(); }
  show(room: Room, client: MatrixClient, mode: "search" | "pins" | "polls" | "media", root?: MessageItem): void {
    this.stop(); this.generation++; this.room = room; this.client = client; this.mode = mode; this.root = root ?? null; this.busy = false;
    this.opener = document.activeElement as HTMLElement | null; this.hidden = false; this.classList.add("room-creation-overlay");
    const card = el("div", { class: "settings-frame room-tools-card", role: "dialog", "aria-modal": "true", "aria-label": "Room tools" });
    const close = el("button", { type: "button", class: "call-btn", text: "Close" }); close.addEventListener("click", () => this.hide());
    card.append(el("div", { class: "room-view-heading" }, el("h2", { text: `${mode === "search" ? "Search messages" : mode === "pins" ? "Pinned messages" : mode === "media" ? "Room media gallery" : "Polls"} · ${room.title}` }), close));
    this.status = el("p", { role: "status", class: "settings-hint", "aria-live": "polite" }); this.content = el("div", { class: "room-tools-content" }); card.append(this.status, this.content); this.replaceChildren(card);
    this.onkeydown = event => {
      if (event.key === "Escape") { event.stopPropagation(); this.hide(); }
      if (event.key === "Tab") {
        const controls = [...card.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)')].filter(node => node.getClientRects().length);
        if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus(); }
      }
    };
    if (mode === "media") this.media(); else if (mode === "search") this.search(); else if (mode === "pins") void this.pins(); else { this.polls(); this.timer = setInterval(() => { if (this.root && !this.busy) void this.refreshPoll(); }, 5000); }
    close.focus();
  }
  private message(item: MessageItem): HTMLElement { const node = document.createElement("message-item"); node.update(item, { client: this.client, room: this.room, meUserId: this.client.userId }); const wrapper = el("div", { class: "tools-message" }); if (item.media) wrapper.append(el("strong", { class: "gallery-filename", text: item.media.name || item.body || "Attachment" })); wrapper.append(node);
    if (item.id) { const jump = el("button", { type: "button", class: "call-btn", text: "Jump to message" }); jump.addEventListener("click", () => { this.hide(); this.dispatchEvent(new CustomEvent("grungus:jump-message", { bubbles: true, detail: { eventId: item.id } })); }); wrapper.append(jump); } return wrapper; }
  private media(): void {
    const filter = el("select", { class: "settings-input", "aria-label": "Media type" }) as HTMLSelectElement;
    for (const [value, text] of [["", "All media and files"], ["m.image", "Images"], ["m.video", "Videos"], ["m.audio", "Audio"], ["m.file", "Documents and files"]]) filter.append(el("option", { value, text }));
    const results = el("div", { class: "media-gallery" });
    const older = el("button", { type: "button", class: "call-btn", text: "Load older media" }) as HTMLButtonElement;
    const render = () => {
      const ignored = this.client.getIgnoredUsers();
      const items = this.room.timeline.filter((item): item is MessageItem => item.kind === "message" && !!item.media && !ignored.includes(item.sender) && (!filter.value || item.msgtype === filter.value)).reverse();
      results.replaceChildren(...items.map(item => this.message(item))); older.disabled = this.busy || !this.room.historyCursor;
      this.status.textContent = `${items.length} attachments in loaded history. Load older history to find more. Encrypted media needs the room’s keys.`;
    };
    older.addEventListener("click", () => { if (this.busy) return; this.busy = true; older.disabled = true; const generation = this.generation;
      void this.client.loadOlderMessages(this.room.id).then(() => { if (generation === this.generation) { this.busy = false; render(); } }).catch(error => { if (generation === this.generation) this.status.textContent = error.message; }).finally(() => { if (generation === this.generation) { this.busy = false; older.disabled = !this.room.historyCursor; } });
    });
    filter.addEventListener("change", render); this.content.append(filter, older, results); render();
  }
  private search(): void {
    const form = el("form", { class: "tools-search-form" });
    const term = el("input", { type: "search", class: "settings-input", "aria-label": "Search message text", placeholder: "Words or filename…" }) as HTMLInputElement;
    const sender = el("input", { type: "text", class: "settings-input", "aria-label": "Search sender", placeholder: "Sender @user:server (optional)" }) as HTMLInputElement;
    const after = el("input", { type: "date", class: "settings-input", "aria-label": "Messages after" }) as HTMLInputElement;
    const before = el("input", { type: "date", class: "settings-input", "aria-label": "Messages before" }) as HTMLInputElement;
    const type = el("select", { class: "settings-input", "aria-label": "Search content type" }) as HTMLSelectElement;
    for (const [value, label] of [["", "All message types"], ["m.text", "Text"], ["m.image", "Images"], ["m.video", "Video"], ["m.audio", "Audio"], ["m.file", "Files"]]) type.append(el("option", { value, text: label }));
    const results = el("div", { class: "tools-results" });
    const render = () => {
      const items = searchLoaded(this.room, { text: term.value, sender: sender.value.trim(), after: after.value ? new Date(after.value).getTime() : undefined, before: before.value ? new Date(before.value).getTime() + 86400000 : undefined, type: type.value }, this.client.getIgnoredUsers());
      results.replaceChildren(...items.slice(0, 100).map(item => this.message(item)));
      this.status.textContent = `${items.length} matches (showing up to 100) in ${this.room.timeline.length} loaded events. Search stays on this device. Load older history to search further; encryption keys are required for encrypted messages.`;
      older.disabled = this.busy || this.room.historyCursor === null;
    };
    const older = el("button", { type: "button", class: "call-btn", text: "Load and search older messages" }) as HTMLButtonElement;
    older.addEventListener("click", () => {
      if (this.busy) return; this.busy = true; older.disabled = true; this.status.textContent = "Loading older history…"; const generation = this.generation;
      void this.client.loadOlderMessages(this.room.id).then(() => { if (generation === this.generation) render(); }).catch(error => { if (generation === this.generation) this.status.textContent = `History unavailable: ${error.message}`; }).finally(() => { if (generation === this.generation) { this.busy = false; older.disabled = this.room.historyCursor === null; } });
    });
    form.append(term, sender, el("label", {}, "From date", after), el("label", {}, "Through date", before), type, el("button", { type: "submit", class: "call-btn", text: "Search" }));
    form.addEventListener("submit", event => { event.preventDefault(); render(); }); this.content.append(form, older, results); render();
  }
  private async pins(): Promise<void> {
    const generation = this.generation; this.status.textContent = "Loading pinned messages…";
    try {
      const [ids, power] = await Promise.all([this.client.features.pins(this.room.id), this.client.getRoomPowerLevels(this.room.id)]);
      const canPin = canChangeState(power, this.client.userId ?? "", this.room.creator, "m.room.pinned_events");
      const items = await Promise.all(ids.map(async id => { try { return await this.client.getThreadRoot(this.room.id, id); } catch { return null; } }));
      if (generation !== this.generation) return;
      this.content.replaceChildren();
      for (const [index, item] of items.entries()) {
        const row = el("div", { class: "pinned-message" });
        if (item) row.append(this.message(item)); else row.append(el("p", { text: `Message unavailable or not decrypted: ${ids[index]}` }));
        const remove = el("button", { type: "button", class: "call-btn", text: "Unpin", disabled: !canPin }) as HTMLButtonElement;
        remove.addEventListener("click", () => { remove.disabled = true; void this.client.features.pin(this.room, ids[index]!, false).then(() => this.pins()).catch(error => { this.status.textContent = error.message; remove.disabled = false; }); }); row.append(remove); this.content.append(row);
      }
      this.status.textContent = `${ids.length} pinned messages. Changing pins requires room permission.`;
    } catch (error) { if (generation === this.generation) this.status.textContent = `Could not load pins: ${error instanceof Error ? error.message : "unknown error"}`; }
  }
  private polls(): void {
    if (this.root) { void this.refreshPoll(); return; }
    const form = el("form", { class: "tools-poll-form" });
    const question = el("input", { type: "text", class: "settings-input", "aria-label": "Poll question", placeholder: "What should we play?", required: true, maxlength: "500" }) as HTMLInputElement;
    const answers = el("textarea", { rows: "5", class: "settings-input", "aria-label": "Poll answers", placeholder: "One answer per line (2–20 answers)", required: true }) as HTMLTextAreaElement;
    const multiple = el("input", { type: "checkbox", "aria-label": "Allow multiple poll choices" }) as HTMLInputElement;
    const create = el("button", { type: "submit", class: "call-btn", text: "Create poll" }) as HTMLButtonElement;
    form.append(question, answers, el("label", {}, multiple, " Allow multiple choices"), create);
    form.addEventListener("submit", event => {
      event.preventDefault(); if (this.busy) return; this.busy = true; create.disabled = true; const generation = this.generation;
      void this.client.features.createPoll(this.room.id, question.value, answers.value.split("\n"), multiple.checked).then(() => { if (generation === this.generation) { this.status.textContent = "Poll sent. It will appear in chat after sync."; (form as HTMLFormElement).reset(); } }).catch(error => { if (generation === this.generation) this.status.textContent = error.message; }).finally(() => { if (generation === this.generation) { this.busy = false; create.disabled = false; } });
    });
    this.content.append(form, el("p", { class: "settings-hint", text: "Results are visible to all participants. Polls use Matrix poll events and the room’s encryption." }));
    for (const item of this.room.timeline) if (item.kind === "message" && item.pollEvent && /poll.start$/.test(item.pollEvent.type)) {
      const open = el("button", { type: "button", class: "thread-summary", text: item.body }); open.addEventListener("click", () => { this.root = item; void this.refreshPoll(); }); this.content.append(open);
    }
  }
  private async refreshPoll(): Promise<void> {
    const root = this.root; if (this.hidden || !root?.id || !root.pollEvent || this.busy) return;
    const generation = this.generation; const selections = [...this.content.querySelectorAll<HTMLInputElement>('input[name="vote"]:checked')].map(input => input.value);
    this.busy = true;
    try {
      const poll = parsePoll(root.pollEvent.content); if (!poll) throw new Error("Unsupported poll");
      const events = await this.client.features.pollRelations(this.room.id, root.id); if (generation !== this.generation) return;
      const tally = tallyPoll(root, events); const showResults = poll.disclosed || tally.ended;
      this.content.replaceChildren(el("h3", { text: poll.question }), el("p", { text: `By ${userLabel(this.client, root.sender, root.senderName)} · ${tally.ended ? "Ended" : "Open"}` }));
      const form = el("form", { class: "tools-poll-vote" });
      for (const answer of poll.answers) {
        const input = el("input", { type: poll.maxSelections > 1 ? "checkbox" : "radio", name: "vote", value: answer.id, disabled: tally.ended }) as HTMLInputElement;
        input.checked = (selections.length ? selections : tally.votes.get(this.client.userId ?? "") ?? []).includes(answer.id);
        form.append(el("label", {}, input, ` ${answer.text}${showResults ? ` — ${tally.counts.get(answer.id)} votes` : ""}`));
      }
      const castVote = () => {
        if (this.busy || tally.ended) return; this.busy = true;
        form.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input,button").forEach(control => { control.disabled = true; });
        const answers = [...form.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value);
        void this.client.features.vote(this.room.id, root, answers).then(() => { if (generation === this.generation) this.status.textContent = "Vote saved."; }).catch(error => { if (generation === this.generation) this.status.textContent = error.message; }).finally(() => { if (generation === this.generation) { this.busy = false; void this.refreshPoll(); } });
      };
      form.addEventListener("change", castVote);
      form.addEventListener("submit", event => { event.preventDefault(); castVote(); });
      const clear = el("button", { type: "button", class: "call-btn", text: "Clear selection", disabled: tally.ended });
      clear.addEventListener("click", () => { form.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.checked = false; }); castVote(); }); form.append(clear); this.content.append(form);
      if (root.sender === this.client.userId && !tally.ended) {
        const end = el("button", { type: "button", class: "call-btn danger", text: "End voting" }) as HTMLButtonElement;
        end.addEventListener("click", () => {
          if (end.textContent !== "Confirm end voting") { end.textContent = "Confirm end voting"; return; }
          this.busy = true; end.disabled = true;
          void this.client.features.endPoll(this.room.id, root).catch(error => { if (generation === this.generation) this.status.textContent = error.message; }).finally(() => { if (generation === this.generation) { this.busy = false; void this.refreshPoll(); } });
        }); this.content.append(end);
      }
      this.status.textContent = `${showResults ? `${tally.votes.size} voters. ` : "Results hidden until the poll ends. "}Results refresh every five seconds.`;
    } catch (error) { if (generation === this.generation) this.status.textContent = `Could not load poll: ${error instanceof Error ? error.message : "unknown error"}`; }
    finally { if (generation === this.generation) this.busy = false; }
  }
}
customElements.define("room-tools", RoomTools);
declare global { interface HTMLElementTagNameMap { "room-tools": RoomTools; } }
