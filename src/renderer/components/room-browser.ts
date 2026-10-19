import { isVideoRoom } from "../services/room-kind.ts";
import { el } from "./ui.ts";
import type { MatrixClient } from "../services/matrix-client.ts";
import type { PublicRoom, Room } from "../services/matrix-types.ts";

export class RoomBrowser extends HTMLElement {
  private client!: MatrixClient;
  private space: Room | null = null;
  private routes = new Map<string, string[]>();
  private search!: HTMLInputElement;
  private status!: HTMLElement;
  private results!: HTMLElement;
  private more!: HTMLButtonElement;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private next: string | undefined;
  private sequence = 0;
  private joining = false;
  private seen = new Set<string>();
  private opener: HTMLElement | null = null;

  constructor() {
    super();
    this.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); this.hide(); } });
  }
  show(client: MatrixClient, space: Room | null = null): void {
    if (this.joining) return;
    this.cancel(); this.client = client; this.space = space; this.routes.clear(); this.opener = document.activeElement as HTMLElement | null;
    this.hidden = false; this.classList.add("call-overlay");
    const close = el("button", { type: "button", class: "call-btn", text: "Close" });
    close.addEventListener("click", () => this.hide());
    this.search = el("input", { type: "search", class: "settings-input", placeholder: "Search rooms by name or topic", "aria-label": space ? "Search space rooms" : "Search public rooms", autocomplete: "off" }) as HTMLInputElement;
    this.status = el("p", { role: "status", "aria-live": "polite" });
    this.results = el("div", { class: "room-directory-results" });
    this.more = el("button", { type: "button", class: "call-btn", text: "Load more rooms", hidden: true }) as HTMLButtonElement;
    this.more.addEventListener("click", () => { void this.load(true); });
    this.search.addEventListener("input", () => {
      if (this.space) { this.filter(); return; }
      this.cancel(); this.results.replaceChildren(); this.more.hidden = true;
      this.status.textContent = "Searching…";
      this.timer = setTimeout(() => { void this.load(); }, 300);
    });
    this.replaceChildren(el("div", { class: "backup-card room-directory-card", role: "dialog", "aria-modal": "true", "aria-label": space ? `Rooms in ${space.title}` : "Explore rooms" },
      el("div", { class: "emoji-picker-header" }, el("h2", { text: space ? `Rooms in ${space.title}` : "Explore rooms" }), close),
      el("p", { class: "settings-hint", text: space ? "Discover rooms in this space, including rooms you have not joined. Space members may join rooms with membership requirements; the server checks access. Search filters loaded rooms; load more to discover others." : "Rooms published by your homeserver. Private and unlisted rooms are not shown. Admission depends on each room’s rules." }),
      this.search, this.status, this.results, this.more));
    this.search.focus(); void this.load();
  }
  private cancel(): void {
    this.sequence++; this.controller?.abort(); this.controller = null;
    if (this.timer) clearTimeout(this.timer); this.timer = null;
  }
  hide(): void {
    if (this.joining) return;
    this.cancel(); this.hidden = true; this.classList.remove("call-overlay"); this.replaceChildren(); this.opener?.focus();
  }
  disconnectedCallback(): void { this.cancel(); }
  private async load(append = false): Promise<void> {
    this.cancel();
    const sequence = this.sequence;
    this.controller = new AbortController(); this.more.disabled = true;
    this.status.textContent = "Loading rooms…";
    if (!append) { this.results.replaceChildren(); this.seen.clear(); this.next = undefined; this.more.hidden = true; }
    try {
      let page;
      if (this.space) {
        const hierarchy = await this.client.spaceHierarchy(this.space.id, append ? this.next : undefined, this.controller.signal);
        if (sequence !== this.sequence || this.hidden) return;
        for (const entry of hierarchy.rooms) {
          for (const child of entry.children_state ?? []) {
            if (child.type === "m.space.child" && Array.isArray(child.content.via) && child.content.via.length) this.routes.set(child.state_key, child.content.via);
          }
        }
        page = { chunk: hierarchy.rooms.filter(room => room.room_id !== this.space!.id && room.room_type !== "m.space"), next_batch: hierarchy.next_batch };
      } else page = await this.client.publicRooms(this.search.value, append ? this.next : undefined, this.controller.signal);
      if (sequence !== this.sequence || this.hidden) return;
      for (const room of page.chunk) {
        if (this.seen.has(room.room_id)) continue;
        this.seen.add(room.room_id); this.results.appendChild(this.row(room));
      }
      this.next = page.next_batch;
      this.more.hidden = !this.next;
      this.status.textContent = this.seen.size ? `${this.seen.size} rooms shown. Choose Join to enter a room.` : this.space ? "No visible rooms found in this space." : "No rooms found. Your homeserver may not publish any rooms.";
      if (this.space) this.filter();
    } catch (error) {
      if (sequence === this.sequence && !this.hidden) this.status.textContent = `Could not load rooms: ${error instanceof Error ? error.message : "unknown error"}. Try searching again.`;
    } finally { if (sequence === this.sequence) this.more.disabled = false; }
  }
  private filter(): void {
    const query = this.search.value.trim().toLocaleLowerCase();
    let visible = 0;
    for (const row of this.results.children) {
      const element = row as HTMLElement;
      element.hidden = !(element.dataset.search ?? "").includes(query);
      if (!element.hidden) visible++;
    }
    this.status.textContent = visible ? `${visible} rooms shown in this space.` : "No matching rooms loaded in this space.";
  }
  private row(room: PublicRoom): HTMLElement {
    const row = el("div", { class: "room-directory-entry" });
    row.dataset.search = [room.name, room.topic, room.canonical_alias, room.room_id].filter(Boolean).join(" ").toLocaleLowerCase();
    const avatar = document.createElement("g-avatar");
    avatar.update({ name: room.name || room.canonical_alias || room.room_id, size: 40, load: this.client.avatarSrc(room.avatar_url, 40) });
    const joined = !!this.client.getRoom(room.room_id);
    const canJoin = room.join_rule === "public" || !room.join_rule || (!!this.space && ["restricted", "knock_restricted"].includes(room.join_rule));
    const button = el("button", { type: "button", class: "call-btn", text: joined ? "Open" : canJoin ? "Join" : "Restricted", disabled: !joined && !canJoin, "aria-label": `${joined ? "Open" : "Join"} ${room.name || room.room_id}` }) as HTMLButtonElement;
    button.addEventListener("click", () => { void this.join(room.room_id, joined); });
    row.append(avatar, el("div", { class: "room-directory-details" },
      el("strong", { text: room.name || room.canonical_alias || room.room_id }),
      el("small", { text: isVideoRoom(room) ? "Video room · Persistent call" : "Text room" }),
      el("small", { text: `${room.num_joined_members} members · ${room.canonical_alias || room.room_id}` }),
      ...(this.space && ["restricted", "knock_restricted"].includes(room.join_rule ?? "") ? [el("small", { text: "Membership requirements apply; access is checked when joining." })] : []),
      ...(room.topic ? [el("p", { text: room.topic })] : []),
      ...(!joined && !canJoin ? [el("small", { text: "Invitation, approval, or membership in another room required." })] : [])), button);
    return row;
  }
  private async join(roomId: string, joined: boolean): Promise<void> {
    if (this.joining) return;
    this.joining = true; this.cancel(); this.status.textContent = joined ? "Opening room…" : "Joining room…";
    const controls = [...this.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")].map(control => ({ control, disabled: control.disabled }));
    controls.forEach(({ control }) => { control.disabled = true; });
    try {
      const id = joined ? roomId : await this.client.joinRoom(roomId, this.routes.get(roomId) ?? []);
      this.joining = false; this.hide();
      this.dispatchEvent(new CustomEvent("grungus:room-joined", { detail: { roomId: id, spaceId: this.space?.id ?? null } }));
    } catch (error) {
      this.joining = false;
      this.status.textContent = `Could not join room: ${error instanceof Error ? error.message : "unknown error"}`;
      controls.forEach(({ control, disabled }) => { control.disabled = disabled; });
    }
  }
}
customElements.define("room-browser", RoomBrowser);
declare global { interface HTMLElementTagNameMap { "room-browser": RoomBrowser; } }
