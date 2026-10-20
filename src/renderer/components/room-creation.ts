import { el } from "./ui.ts";
import type { MatrixClient, Room, CreateRoomOptions } from "../services/matrix-client.ts";
import { createSpaceRoom, SpaceRoomLinkError } from "../services/space-room-creation.ts";

export class RoomCreation extends HTMLElement {
  private busy = false;
  private previewUrl: string | null = null;
  private opener: HTMLElement | null = null;
  constructor() {
    super();
    this.addEventListener("keydown", event => {
      if (event.key === "Escape") { event.preventDefault(); this.hide(); }
      if (event.key === "Tab") {
        const controls = [...this.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary')].filter(node => node.getClientRects().length);
        if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus(); }
      }
    });
  }
  disconnectedCallback(): void { this.clearPreview(); }
  private clearPreview(): void { if (this.previewUrl) URL.revokeObjectURL(this.previewUrl); this.previewUrl = null; }
  hide(): void {
    if (this.busy) return;
    this.hidden = true; this.classList.remove("room-creation-overlay"); this.clearPreview(); this.replaceChildren();
    this.dispatchEvent(new CustomEvent("room-creation-closed")); this.opener?.focus();
  }
  show(space: Room, client: MatrixClient): void {
    if (this.busy) return;
    this.clearPreview(); this.opener = document.activeElement as HTMLElement | null;
    this.hidden = false; this.classList.add("room-creation-overlay");
    const card = el("div", { class: "settings-frame room-creation-card", role: "dialog", "aria-modal": "true", "aria-label": "Create a room in this space" });
    const close = el("button", { type: "button", class: "call-btn", text: "Cancel" }) as HTMLButtonElement; close.addEventListener("click", () => this.hide());
    card.append(el("div", { class: "room-view-heading" }, el("h2", { text: "Create a room" }), close), el("p", { class: "settings-hint", text: `New room in ${space.title}. You will be the room administrator.` }));
    const form = el("form", { class: "room-creation-form" });
    const field = (label: string, control: HTMLElement, hint?: string) => el("label", { class: "room-settings-field" }, el("span", { text: label }), control, hint ? el("small", { class: "settings-hint", text: hint }) : null);
    const name = el("input", { type: "text", class: "settings-input", required: true, maxlength: "100", "aria-label": "New room name", placeholder: "e.g. Project lounge" }) as HTMLInputElement;
    const topic = el("textarea", { rows: "3", class: "settings-input", maxlength: "2000", "aria-label": "New room topic", placeholder: "What is this room for?" }) as HTMLTextAreaElement;
    const type = el("select", { class: "settings-input", "aria-label": "New room type" }, el("option", { value: "text", text: "Text room" }), el("option", { value: "video", text: "Video room" })) as HTMLSelectElement;
    const access = el("select", { class: "settings-input", "aria-label": "New room access" },
      el("option", { value: "invite", text: "Invited people only" }), el("option", { value: "restricted", text: "Members of this space" }), el("option", { value: "public", text: "Anyone (public)" })) as HTMLSelectElement;
    const encryption = el("input", { type: "checkbox", "aria-label": "Encrypt new room" }) as HTMLInputElement; encryption.checked = true;
    const history = el("select", { class: "settings-input", "aria-label": "New room history" },
      el("option", { value: "shared", text: "Members, including earlier messages" }), el("option", { value: "joined", text: "Messages from when a member joins" }), el("option", { value: "invited", text: "Messages from when a member is invited" }), el("option", { value: "world_readable", text: "Anyone, including non-members" })) as HTMLSelectElement;
    const picture = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif,image/avif", "aria-label": "New room picture" }) as HTMLInputElement;
    const preview = el("img", { class: "room-creation-preview", alt: "New room picture preview", hidden: true }) as HTMLImageElement;
    const status = el("p", { role: "status", "aria-live": "polite", class: "settings-hint" });
    picture.addEventListener("change", () => {
      this.clearPreview(); preview.hidden = true;
      const file = picture.files?.[0]; if (!file) return;
      if (!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type) || file.size > 10 * 1024 * 1024) { status.textContent = "Choose a PNG, JPEG, WebP, GIF, or AVIF picture smaller than 10 MB."; picture.value = ""; return; }
      this.previewUrl = URL.createObjectURL(file); preview.src = this.previewUrl; preview.hidden = false; status.textContent = "";
    });
    const invites = el("textarea", { rows: "2", class: "settings-input", "aria-label": "Invite people to new room", placeholder: "@friend:example.org, @colleague:example.org" }) as HTMLTextAreaElement;
    const alias = el("input", { type: "text", class: "settings-input", pattern: "[A-Za-z0-9._=\\-]+", maxlength: "100", "aria-label": "New room address", placeholder: "Optional address, e.g. project-lounge" }) as HTMLInputElement;
    const domain = client.userId?.slice(client.userId.indexOf(":") + 1) || new URL(client.baseUrl).hostname;
    const publish = el("input", { type: "checkbox", "aria-label": "Publish new room in directory", disabled: true }) as HTMLInputElement;
    const senders = el("select", { class: "settings-input", "aria-label": "Who can send in new room" }, el("option", { value: "everyone", text: "Everyone" }), el("option", { value: "moderators", text: "Moderators and administrators (announcements)" })) as HTMLSelectElement;
    const canInvite = el("input", { type: "checkbox", "aria-label": "Allow members to invite" }) as HTMLInputElement;
    const advanced = el("details", { class: "room-creation-advanced" }, el("summary", { text: "Advanced room options" }),
      field("Room address", alias, `Creates #your-address:${domain}. The homeserver must have this address available.`),
      field("List in the homeserver’s public room directory", publish, "Available for public rooms only. Leaving this off keeps the room out of directory listings."),
      field("Who can send messages", senders), field("Allow regular members to invite people", canInvite));
    form.append(field("Room name", name), field("Room type", type, "Video rooms use the configured MatrixRTC call backend. Joining starts with the camera off."),
      field("Topic", topic), field("Room picture (optional)", picture), preview,
      field("Who can join", access, "Space-member access depends on homeserver support for restricted rooms. Creating a room does not invite every space member."),
      field("Enable end-to-end encryption", encryption, "Recommended. Encryption cannot be disabled later."),
      field("Who can read message history", history, "Encrypted history requires the relevant message keys."),
      field("Invite people (optional)", invites, "Enter full Matrix IDs separated by commas, spaces, or new lines."), advanced);
    const summary = el("p", { class: "room-creation-summary" });
    const syncOptions = () => {
      publish.disabled = access.value !== "public"; if (publish.disabled) publish.checked = false;
      const world = history.querySelector<HTMLOptionElement>('option[value="world_readable"]')!; world.disabled = encryption.checked;
      if (encryption.checked && history.value === "world_readable") history.value = "shared";
      summary.textContent = `${type.value === "video" ? "Video" : "Text"} room · ${access.selectedOptions[0]!.textContent} · ${encryption.checked ? "End-to-end encrypted" : "Not end-to-end encrypted"} · Added to ${space.title}`;
    };
    form.addEventListener("change", syncOptions); syncOptions();
    const create = el("button", { type: "submit", class: "call-btn", text: "Create room in space" }) as HTMLButtonElement;
    const open = el("button", { type: "button", class: "call-btn", text: "Open created room", hidden: true }) as HTMLButtonElement;
    let createdId: string | undefined;
    let uploadedAvatar: string | undefined;
    const setBusy = (busy: boolean) => { this.busy = busy; close.disabled = busy; create.disabled = busy; open.disabled = busy; form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, textarea, select").forEach(control => { control.disabled = busy || !!createdId; }); if (!busy && !createdId) syncOptions(); };
    open.addEventListener("click", () => { if (!createdId) return; this.hide(); this.dispatchEvent(new CustomEvent("room-created", { detail: { roomId: createdId, spaceId: null } })); });
    form.addEventListener("submit", event => {
      event.preventDefault(); if (this.busy) return;
      const ids = [...new Set(invites.value.split(/[\s,;]+/).filter(Boolean))].filter(id => id !== client.userId);
      if (!createdId && ids.some(id => !/^@[^:\s]+:[^\s]+$/.test(id))) { status.textContent = "Use full Matrix IDs for invitations, such as @friend:example.org."; return; }
      const options: CreateRoomOptions = {
        name: name.value.trim(), topic: topic.value.trim(), isVideo: type.value === "video", isPublic: access.value === "public",
        joinRule: access.value as CreateRoomOptions["joinRule"], historyVisibility: history.value as CreateRoomOptions["historyVisibility"],
        encrypted: encryption.checked, aliasLocalpart: alias.value.trim() || undefined, publish: publish.checked,
        announcementOnly: senders.value === "moderators", membersCanInvite: canInvite.checked, invite: ids,
      };
      const file = picture.files?.[0];
      if (!createdId && !options.name) { status.textContent = "Enter a room name."; return; }
      setBusy(true); status.textContent = createdId ? "Adding the created room to the space…" : "Creating room…";
      void (async () => {
        if (file && !uploadedAvatar && !createdId) uploadedAvatar = await client.uploadMedia(file.name, file.type, new Uint8Array(await file.arrayBuffer()));
        const roomId = await createSpaceRoom(client, space, { ...options, avatarUrl: uploadedAvatar }, createdId);
        setBusy(false); this.hide(); this.dispatchEvent(new CustomEvent("room-created", { detail: { roomId, spaceId: space.id } }));
      })().catch(error => {
        if (error instanceof SpaceRoomLinkError) {
          createdId = error.roomId; create.textContent = "Retry adding to space"; open.hidden = false;
          status.textContent = `Room ${createdId} was created, but could not be added to the space: ${error.message}. Retry adds the same room without creating another.`;
        } else status.textContent = `Could not create room: ${error instanceof Error ? error.message : "unknown error"}`;
        setBusy(false);
      });
    });
    form.append(summary, status, el("div", { class: "settings-row" }, create, open)); card.append(form); this.replaceChildren(card); name.focus();
  }
}
customElements.define("room-creation", RoomCreation);
declare global { interface HTMLElementTagNameMap { "room-creation": RoomCreation; } }
