import { el } from "./ui.ts";
import { parsePoll, tallyPoll } from "../services/room-features.ts";
import type { MatrixClient, Room, MessageItem } from "../services/matrix-client.ts";
interface Draft { choices: Set<string>; dirty: boolean; }
const drafts = new WeakMap<MatrixClient, Map<string, Draft>>();
export class MessagePoll extends HTMLElement {
  private client!: MatrixClient;
  private room!: Room;
  private root!: MessageItem;
  private draft: Draft = { choices: new Set(), dirty: false };
  private events: MessageItem[] = [];
  private ready = false;
  private busy = false;
  private notice = "Loading votes…";
  private confirmingEnd = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private observer: IntersectionObserver | null = null;
  private generation = 0;
  private visible = true;
  private unsubscribe: (() => void) | null = null;
  private needsRefresh = false;
  private subscribe(): void {
    this.unsubscribe?.(); this.unsubscribe = null;
    if (this.root?.id) this.unsubscribe = this.client.features.subscribePoll(this.room.id, this.root.id, () => {
      if (this.busy) this.needsRefresh = true; else void this.refresh();
    });
  }
  update(root: MessageItem, room: Room, client: MatrixClient): void {
    this.generation++; this.busy = false; this.needsRefresh = false; this.root = root; this.room = room; this.client = client;
    let saved = drafts.get(client); if (!saved) { saved = new Map(); drafts.set(client, saved); }
    const key = `${room.id}|${root.id}`;
    if (!saved.has(key)) { saved.set(key, { choices: new Set(), dirty: false }); if (saved.size > 100) saved.delete(saved.keys().next().value!); }
    this.draft = saved.get(key)!;
    this.events = root.id ? client.features.cachedPollRelations(room.id, root.id) : [];
    this.ready = this.events.length > 0; this.notice = this.ready ? "" : "Loading votes…";
    this.render(); if (this.isConnected) { this.subscribe(); void this.refresh(); }
  }
  connectedCallback(): void {
    this.subscribe();
    this.observer = new IntersectionObserver(entries => {
      this.visible = entries[0]?.isIntersecting ?? false;
      this.stopTimer();
      if (this.visible && this.root) { void this.refresh(); this.timer = setInterval(() => { void this.refresh(); }, 5000); }
    }); this.observer.observe(this);
  }
  disconnectedCallback(): void { this.generation++; this.unsubscribe?.(); this.unsubscribe = null; this.observer?.disconnect(); this.observer = null; this.stopTimer(); }
  private stopTimer(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  private async refresh(): Promise<void> {
    if (!this.root?.id || !this.isConnected || !this.visible || this.busy) return;
    const generation = this.generation; this.busy = true;
    try {
      const events = await this.client.features.pollRelations(this.room.id, this.root.id);
      if (generation !== this.generation) return;
      this.events = events; this.ready = true; this.notice = "";
      const own = tallyPoll(this.root, events).votes.get(this.client.userId ?? "");
      if (own && own.length === this.draft.choices.size && own.every(id => this.draft.choices.has(id))) this.draft.dirty = false;
    } catch (error) { if (generation === this.generation) { this.ready = false; this.notice = `Could not load votes: ${error instanceof Error ? error.message : "unknown error"}`; } }
    finally { if (generation === this.generation) {
      this.busy = false; this.render();
      if (this.needsRefresh) { this.needsRefresh = false; void this.refresh(); }
    } }
  }
  private render(): void {
    if (!this.root?.pollEvent) return;
    const poll = parsePoll(this.root.pollEvent.content);
    if (!poll) { this.textContent = "This poll format is not supported."; return; }
    this.setAttribute("role", "group"); this.setAttribute("aria-label", `Poll: ${poll.question}`);
    const focused = this.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    const focusValue = focused instanceof HTMLInputElement ? focused.value : null;
    const focusLabel = focused?.getAttribute("aria-label");
    const tally = tallyPoll(this.root, this.events), showResults = poll.disclosed || tally.ended;
    if (this.ready && !this.draft.dirty) this.draft.choices = new Set(tally.votes.get(this.client.userId ?? "") ?? []);
    this.replaceChildren(el("h3", { class: "inline-poll-question", text: poll.question }));
    const voters = [...tally.votes.values()].filter(choices => choices.length > 0).length;
    this.append(el("p", { class: "inline-poll-meta", text: `${poll.maxSelections > 1 ? "Choose multiple answers" : "Choose one answer"} · ${tally.ended ? "Voting ended" : "Open"}${this.ready && showResults ? ` · ${voters} ${voters === 1 ? "voter" : "voters"}` : ""}` }));
    const form = el("div", { class: "inline-poll-form" });
    const castVote = () => {
      if (!this.ready || this.busy || tally.ended) return;
      const choices = [...this.draft.choices];
      void this.save(() => this.client.features.vote(this.room.id, this.root, choices), "Vote saved.");
    };
    for (const answer of poll.answers) {
      const input = el("input", { type: poll.maxSelections > 1 ? "checkbox" : "radio", name: "inline-vote", value: answer.id, disabled: !this.ready || this.busy || tally.ended, "aria-label": answer.text }) as HTMLInputElement;
      input.checked = this.draft.choices.has(answer.id);
      input.addEventListener("change", () => {
        if (poll.maxSelections === 1) this.draft.choices.clear();
        if (input.checked) this.draft.choices.add(answer.id); else this.draft.choices.delete(answer.id);
        this.draft.dirty = true; castVote();
      });
      const count = tally.counts.get(answer.id) ?? 0;
      const answerContent = el("span", { class: "inline-poll-answer-content" }, el("span", { class: "inline-poll-answer-text", text: answer.text }));
      const row = el("label", { class: "inline-poll-answer" }, input, answerContent);
      if (this.ready && showResults) {
        const share = voters ? Math.round(count / voters * 100) : 0;
        answerContent.append(el("progress", { class: "inline-poll-share", max: "100", value: String(share), "aria-label": `${answer.text}: ${share}% of voters` }));
        row.append(el("span", { class: "inline-poll-count", text: `${count} ${count === 1 ? "vote" : "votes"} · ${share}%` }));
      }
      form.append(row);
    }
    const clear = el("button", { type: "button", class: "call-btn", text: "Clear selection", disabled: !this.ready || this.busy || tally.ended });
    clear.addEventListener("click", () => { this.draft.choices.clear(); this.draft.dirty = true; castVote(); });
    form.append(el("div", { class: "inline-poll-actions" }, clear));
    if (this.draft.dirty && this.notice.startsWith("Could not save:")) {
      const retry = el("button", { type: "button", class: "call-btn", text: "Retry saving vote", disabled: this.busy }); retry.addEventListener("click", castVote); form.append(retry);
    }
    this.append(form);
    if (this.root.sender === this.client.userId && !tally.ended) {
      const end = el("button", { type: "button", class: "call-btn danger", "aria-label": "End poll voting", text: this.confirmingEnd ? "Confirm end voting" : "End voting", disabled: !this.ready || this.busy });
      end.addEventListener("click", () => {
        if (!this.confirmingEnd) { this.confirmingEnd = true; this.render(); return; }
        void this.save(() => this.client.features.endPoll(this.room.id, this.root), "Poll ended.");
      }); this.append(end);
    }
    if (!this.ready) {
      const retry = el("button", { type: "button", class: "call-btn", text: "Retry loading votes", disabled: this.busy }); retry.addEventListener("click", () => { void this.refresh(); }); this.append(retry);
    }
    this.append(el("p", { class: "inline-poll-status", role: "status", "aria-live": "polite", text: this.notice || (!showResults ? "Results are hidden until voting ends." : "Results update automatically.") }));
    if (focused) {
      const next = focusValue !== null ? [...this.querySelectorAll<HTMLInputElement>("input")].find(input => input.value === focusValue)
        : [...this.querySelectorAll<HTMLElement>("[aria-label]")].find(node => node.getAttribute("aria-label") === focusLabel);
      next?.focus({ preventScroll: true });
    }
  }
  private async save(action: () => Promise<void>, message: string): Promise<void> {
    if (this.busy) return; const generation = this.generation; let saved = false; this.busy = true; this.notice = "Saving…"; this.render();
    try { await action(); saved = true; if (generation === this.generation) { this.notice = message; } }
    catch (error) { if (generation === this.generation) this.notice = `Could not save: ${error instanceof Error ? error.message : "unknown error"}`; }
    finally { if (generation === this.generation) { this.busy = false; this.render(); if (saved) void this.refresh(); } }
  }
}
customElements.define("message-poll", MessagePoll);
declare global { interface HTMLElementTagNameMap { "message-poll": MessagePoll; } }
