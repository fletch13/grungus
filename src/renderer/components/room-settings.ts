import "./room-creation.ts";
import { el } from "./ui.ts";
import type { MatrixClient, Room } from "../services/matrix-client.ts";
import { HttpError } from "../services/matrix-client.ts";
import { canChangeState, type RoomPowerLevels } from "../services/room-permissions.ts";

export class RoomSettings extends HTMLElement {
  private room!: Room;
  private client!: MatrixClient;
  private power: RoomPowerLevels = {};
  private status!: HTMLElement;
  private busy = false;
  private saving = false;
  private sequence = 0;
  private opener: HTMLElement | null = null;
  private creator: import("./room-creation.ts").RoomCreation | null = null;
  disconnectedCallback(): void { this.creator?.remove(); this.creator = null; }
  constructor() { super(); this.addEventListener("keydown", event => { if (event.key === "Escape") this.hide(); }); }
  show(room: Room, client: MatrixClient): void {
    if (this.saving) return;
    this.room = room; this.client = client; this.opener = document.activeElement as HTMLElement | null;
    this.hidden = false; this.classList.add("settings-overlay"); this.busy = true;
    const sequence = ++this.sequence;
    this.replaceChildren(el("p", { role: "status", text: "Loading room permissions…" }));
    const close = el("button", { class: "call-btn", text: "Close" }); close.addEventListener("click", () => this.hide()); this.append(close);
    void Promise.all([client.getRoomPowerLevels(room.id), this.state("m.room.join_rules"), this.state("m.room.history_visibility")]).then(([power, access, history]) => {
      if (sequence !== this.sequence || this.hidden) return;
      this.power = power; this.busy = false; this.render(access, history);
    }).catch(error => { if (sequence === this.sequence && !this.hidden) this.replaceChildren(el("p", { role: "alert", text: `Could not load settings: ${error instanceof Error ? error.message : "unknown error"}` }), close); });
  }
  hide(): void { this.sequence++; this.hidden = true; this.classList.remove("settings-overlay"); this.replaceChildren(); this.opener?.focus(); }
  private async state(type: string): Promise<Record<string, unknown>> {
    try { return await this.client.api("GET", `/_matrix/client/v3/rooms/${encodeURIComponent(this.room.id)}/state/${type}`); }
    catch (error) { if (error instanceof HttpError && error.errcode === "M_NOT_FOUND") return {}; throw error; }
  }
  private can(type: string): boolean { return canChangeState(this.power, this.client.userId ?? "", this.room.creator, type); }
  private async authorized(type: string, room: Room, client: MatrixClient): Promise<void> {
    const power = await client.getRoomPowerLevels(room.id);
    if (!canChangeState(power, client.userId ?? "", room.creator, type)) throw new Error("Your permissions no longer allow this change");
  }
  private setBusy(value: boolean): void { this.busy = value; this.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>("[data-editable]").forEach(control => { control.disabled = value; }); }
  private render(access: Record<string, unknown>, history: Record<string, unknown>): void {
    const room = this.room; const client = this.client; this.replaceChildren();
    const card = el("div", { class: "settings-frame room-settings-frame", role: "dialog", "aria-modal": "true", "aria-label": room.isSpace ? "Space settings" : "Room settings" });
    const close = el("button", { type: "button", class: "call-btn", text: "Close" }); close.addEventListener("click", () => this.hide());
    card.append(el("div", { class: "room-view-heading" }, el("h2", { text: room.isSpace ? "Space settings" : "Room settings" }), close), el("p", { class: "settings-hint", text: `${room.title} · ${room.id}. Only settings you have permission to change are editable.` }));
    this.status = el("p", { role: "status", "aria-live": "polite", class: "settings-hint" }); card.append(this.status);
    const form = el("form", { class: "room-settings-form" });
    const name = el("input", { type: "text", class: "settings-input", value: room.name ?? "", "aria-label": "Name", disabled: !this.can("m.room.name"), "data-editable": this.can("m.room.name") }) as HTMLInputElement;
    const topic = el("textarea", { class: "settings-input", rows: "3", "aria-label": "Topic", disabled: !this.can("m.room.topic"), "data-editable": this.can("m.room.topic") }) as HTMLTextAreaElement; topic.value = room.topic ?? "";
    const picture = el("input", { type: "file", accept: "image/*", "aria-label": "Room picture", disabled: !this.can("m.room.avatar"), "data-editable": this.can("m.room.avatar") }) as HTMLInputElement;
    const originalRule = typeof access.join_rule === "string" ? access.join_rule : room.joinRule ?? "invite";
    const rule = el("select", { class: "settings-input", "aria-label": "Who can join", disabled: !this.can("m.room.join_rules"), "data-editable": this.can("m.room.join_rules") }) as HTMLSelectElement;
    for (const [value, label] of [["invite", "Invited people only"], ["public", "Anyone (public)"]]) rule.append(el("option", { value, text: label }));
    if (!["invite", "public"].includes(originalRule)) rule.append(el("option", { value: originalRule, text: `${originalRule} (existing rule)` }));
    rule.value = originalRule;
    const originalHistory = typeof history.history_visibility === "string" ? history.history_visibility : "shared";
    const visibility = el("select", { class: "settings-input", "aria-label": "Who can read history", disabled: !this.can("m.room.history_visibility"), "data-editable": this.can("m.room.history_visibility") }) as HTMLSelectElement;
    for (const [value, label] of [["shared", "Members (including earlier messages)"], ["joined", "Members from when they joined"], ["invited", "Members from when they were invited"], ["world_readable", "Anyone, including non-members"]]) visibility.append(el("option", { value, text: label }));
    visibility.value = originalHistory;
    const field = (label: string, control: HTMLElement) => el("label", { class: "room-settings-field" }, el("span", { text: label }), control);
    form.append(field("Name", name), field("Topic", topic), field("Picture", picture), field("Who can join", rule), field("Who can read history", visibility));
    form.append(el("p", { class: "settings-hint", text: "Public access does not publish this room in the homeserver directory. Encrypted history also requires the relevant message keys." }));
    const encryption = el("input", { type: "checkbox", "aria-label": "Enable encryption", disabled: room.isEncrypted || !this.can("m.room.encryption"), "data-editable": !room.isEncrypted && this.can("m.room.encryption") }) as HTMLInputElement; encryption.checked = room.isEncrypted;
    if (!room.isSpace) form.append(field("End-to-end encryption (once enabled, cannot be turned off)", encryption));
    const save = el("button", { type: "submit", class: "call-btn", text: "Save changes", "data-editable": true }); form.append(save);
    form.addEventListener("submit", event => {
      event.preventDefault(); if (this.busy) return;
      const changes: { type: string; content: Record<string, unknown> }[] = [];
      if (name.value !== (room.name ?? "")) changes.push({ type: "m.room.name", content: { name: name.value.trim() } });
      if (topic.value !== (room.topic ?? "")) changes.push({ type: "m.room.topic", content: { topic: topic.value } });
      if (rule.value !== originalRule) changes.push({ type: "m.room.join_rules", content: { join_rule: rule.value } });
      if (visibility.value !== originalHistory) changes.push({ type: "m.room.history_visibility", content: { history_visibility: visibility.value } });
      if (!room.isSpace && !room.isEncrypted && encryption.checked) changes.push({ type: "m.room.encryption", content: { algorithm: "m.megolm.v1.aes-sha2" } });
      const file = picture.files?.[0];
      if (file && file.size > 10 * 1024 * 1024) { this.status.textContent = "Choose a picture smaller than 10 MB."; return; }
      if (!changes.length && !file) { this.status.textContent = "No changes to save."; return; }
      this.saving = true; this.setBusy(true); this.status.textContent = "Saving…"; let saved = 0;
      void (async () => {
        for (const change of changes) await this.authorized(change.type, room, client);
        if (file) { await this.authorized("m.room.avatar", room, client); const url = await client.uploadMedia(file.name, file.type, new Uint8Array(await file.arrayBuffer())); changes.push({ type: "m.room.avatar", content: { url } }); }
        for (const change of changes) { await client.sendStateEvent(room.id, change.type, "", change.content); saved++; }
        this.status.textContent = "Changes saved. The room will update after sync.";
      })().catch(error => { this.status.textContent = `${saved ? `${saved} changes saved before an error. ` : ""}Could not save: ${error instanceof Error ? error.message : "unknown error"}`; }).finally(() => { this.saving = false; this.setBusy(false); });
    });
    card.append(form);
    if (room.isSpace) this.childrenSettings(card, access, history);
    this.append(card); close.focus();
  }
  private childrenSettings(card: HTMLElement, access: Record<string, unknown>, history: Record<string, unknown>): void {
    card.append(el("h3", { text: "Rooms in this space" }));
    const room = this.room; const client = this.client;
    const canEdit = this.can("m.space.child");
    const create = el("button", { type: "button", class: "call-btn", text: "Create a new room", disabled: !canEdit, "data-editable": canEdit });
    create.addEventListener("click", () => {
      if (this.busy) return;
      {
        this.creator?.remove();
        this.creator = document.createElement("room-creation"); this.creator.hidden = true; document.body.append(this.creator);
        this.creator.addEventListener("room-creation-closed", () => { this.inert = false; });
        this.creator.addEventListener("room-created", event => {
          const detail = (event as CustomEvent<{ roomId: string; spaceId: string | null }>).detail;
          if (!this.hidden) this.render(access, history);
          this.dispatchEvent(new CustomEvent("grungus:room-created", { detail, bubbles: true }));
        });
      }
      this.creator.show(room, client); this.inert = true;
    });
    card.append(create);

    const change = (roomId: string, add: boolean): void => {
      if (this.busy) return; this.saving = true; this.setBusy(true);
      void (async () => {
        await this.authorized("m.space.child", room, client);
        if (add) await client.addToSpace(room.id, roomId); else await client.removeFromSpace(room.id, roomId);
        if (add) room.children.add(roomId); else room.children.delete(roomId);
        this.busy = false; if (!this.hidden) this.render(access, history);
      })().catch(error => { this.status.textContent = `Could not change space rooms: ${error instanceof Error ? error.message : "unknown error"}`; }).finally(() => { this.saving = false; this.setBusy(false); });
    };
    for (const id of this.room.children) {
      const remove = el("button", { type: "button", class: "call-btn", text: "Remove from space", disabled: !canEdit, "data-editable": canEdit });
      remove.addEventListener("click", () => change(id, false));
      card.append(el("div", { class: "room-info-row" }, el("span", { text: this.client.getRoom(id)?.title || id }), remove));
    }
    const select = el("select", { class: "settings-input", "aria-label": "Add room to space", disabled: !canEdit, "data-editable": canEdit }) as HTMLSelectElement;
    for (const room of this.client.getRooms().filter(room => !room.isDirect && !room.isSpace && !this.room.children.has(room.id))) select.append(el("option", { value: room.id, text: room.title }));
    const add = el("button", { type: "button", class: "call-btn", text: "Add room", disabled: !canEdit || !select.options.length, "data-editable": canEdit && !!select.options.length });
    add.addEventListener("click", () => { if (select.value) change(select.value, true); }); card.append(el("div", { class: "settings-row" }, select, add));
    card.append(el("p", { class: "settings-hint", text: "Removing a room from a space does not delete the room or remove its members." }));
  }
}
customElements.define("room-settings", RoomSettings);
declare global { interface HTMLElementTagNameMap { "room-settings": RoomSettings; } }
