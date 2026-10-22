import { el } from "./ui.ts";
import { userLabel, bindUserTile } from "./user-menu.ts";
import { recentDirectRooms } from "../services/recent-dms.ts";
import type { MatrixClient, Room } from "../services/matrix-client.ts";

export class RecentDms extends HTMLElement {
  private list: HTMLElement | null = null;
  private tiles = new Map<string, HTMLElement>();
  private signatures = new Map<string, string>();
  private client: MatrixClient | null = null;
  private animations = new Map<string, Animation>();
  private profiles = new Map<string, { expires: number; load: Promise<string | null> }>();
  private avatarFor(client: MatrixClient, userId: string, avatar: string | null): Promise<string | null> {
    if (avatar) return client.avatarSrc(avatar, 30);
    const cached = this.profiles.get(userId); if (cached && cached.expires > Date.now()) return cached.load;
    const load = client.getProfile(userId).then(profile => client.avatarSrc(profile.avatar_url, 30)).catch(() => null);
    this.profiles.set(userId, { expires: Date.now() + 60000, load });
    if (this.profiles.size > 128) this.profiles.delete(this.profiles.keys().next().value!);
    return load;
  }
  disconnectedCallback(): void { for (const animation of this.animations.values()) animation.cancel(); this.animations.clear(); }
  update(rooms: Room[], selectedId: string | null, client: MatrixClient | null): void {
    const recent = recentDirectRooms(rooms);
    if (client !== this.client) this.profiles.clear();
    const previous = new Map([...this.tiles].map(([id, tile]) => [id, tile.getBoundingClientRect()]));
    const previousOrder = [...this.tiles.keys()].join("|");
    const reordered = previousOrder !== recent.map(room => room.id).join("|");
    if (reordered) { for (const animation of this.animations.values()) animation.cancel(); this.animations.clear(); }
    this.hidden = recent.length === 0;
    if (!this.list) {
      this.setAttribute("aria-label", "Recent direct messages");
      this.append(el("div", { class: "recent-dms-heading", text: "Recent direct messages" }));
      this.list = el("div", { class: "recent-dms-list" }); this.append(this.list);
    }
    const focusedRoom = [...this.tiles].find(([, tile]) => tile.contains(document.activeElement))?.[0];
    const keep = new Set(recent.map(room => room.id));
    for (const [id, tile] of this.tiles) if (!keep.has(id)) { tile.remove(); this.tiles.delete(id); this.signatures.delete(id); }
    const nextTiles = new Map<string, HTMLElement>();
    for (const [index, room] of recent.entries()) {
      let tile = this.tiles.get(room.id);
      if (!tile) {
        tile = el("div", { class: "recent-dm-tile", dataset: { roomId: room.id } });
        const open = el("button", { type: "button", class: "recent-dm-open" });
        open.addEventListener("click", () => this.dispatchEvent(new CustomEvent("grungus:select-room", { detail: { roomId: room.id }, bubbles: true })));
        tile.append(open);
      }
      const others = [...room.members.values()].filter(member => member.userId !== client?.userId && ["join", "invite"].includes(member.membership));
      const peer = room.members.get(room.directUserId ?? "") ?? (others.length === 1 ? others[0] : undefined);
      const name = peer ? userLabel(client, peer.userId, peer.displayname || room.title) : room.title;
      const presence = peer ? client?.getPresence?.(peer.userId) ?? null : null;
      const signature = JSON.stringify([name, peer?.userId, peer?.avatarMxc, room.avatarMxc, room.unread, presence]);
      const open = tile.querySelector<HTMLButtonElement>("button")!;
      if (signature !== this.signatures.get(room.id) || client !== this.client) {
        const avatar = document.createElement("g-avatar");
        avatar.update({ name, userId: peer?.userId ?? room.id, size: 30, presence: peer ? presence : undefined,
          load: client ? peer ? this.avatarFor(client, peer.userId, peer.avatarMxc) : client.avatarSrc(room.avatarMxc, 30) : null });
        open.replaceChildren(avatar, el("span", { class: "recent-dm-name", text: name }));
        if (room.unread > 0) open.append(el("span", { class: "unread-badge", text: room.unread > 99 ? "99+" : String(room.unread) }));
        open.setAttribute("aria-label", `Open direct message with ${name}${room.unread ? `, ${room.unread} unread` : ""}`);
        // Keep the ordinary click for opening the DM; use right-click for user settings.
        if (peer) bindUserTile(avatar, client, peer.userId, name);
        this.signatures.set(room.id, signature);
      }
      open.setAttribute("aria-current", room.id === selectedId ? "page" : "false");
      tile.classList.toggle("active", room.id === selectedId);
      if (this.list.children[index] !== tile) this.list.insertBefore(tile, this.list.children[index] ?? null);
      nextTiles.set(room.id, tile);
    }
    this.tiles = nextTiles; this.client = client;
    if (focusedRoom) this.tiles.get(focusedRoom)?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    if (reordered && this.isConnected && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const [id, tile] of this.tiles) {
        const old = previous.get(id), next = tile.getBoundingClientRect();
        const frames = old ? [{ transform: `translate(${old.left - next.left}px, ${old.top - next.top}px)` }, { transform: "translate(0, 0)" }]
          : [{ opacity: 0, transform: "translateY(8px) scale(.96)" }, { opacity: 1, transform: "translateY(0) scale(1)" }];
        const animation = tile.animate(frames, { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
        this.animations.set(id, animation);
        void animation.finished.then(() => { if (this.animations.get(id) === animation) this.animations.delete(id); }).catch(() => {});
      }
    }
  }
}
customElements.define("recent-dms", RecentDms);
declare global { interface HTMLElementTagNameMap { "recent-dms": RecentDms; } }
