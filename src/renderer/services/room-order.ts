/** Device-local room organization, partitioned by Matrix account and space. */
export class RoomOrder {
  private key: string;
  favorites: string[] = [];
  order: string[] = [];
  constructor(account: string, space: string | null) {
    this.key = `grungus.rooms.${JSON.stringify([account, space])}`;
    try {
      const data = JSON.parse(localStorage.getItem(this.key) ?? "{}");
      this.favorites = Array.isArray(data.favorites) ? [...new Set(data.favorites.filter((id: unknown) => typeof id === "string"))] as string[] : [];
      this.order = Array.isArray(data.order) ? [...new Set(data.order.filter((id: unknown) => typeof id === "string"))] as string[] : [];
    } catch { /* unavailable storage or damaged preferences */ }
  }
  private save(): void { try { localStorage.setItem(this.key, JSON.stringify({ favorites: this.favorites, order: this.order })); } catch { /* session remains usable */ } }
  toggle(id: string): void { this.favorites = this.favorites.includes(id) ? this.favorites.filter(value => value !== id) : [...this.favorites, id]; this.save(); }
  sorted<T extends { id: string }>(rooms: T[]): T[] {
    return [...rooms].sort((a, b) => { const ai = this.order.indexOf(a.id), bi = this.order.indexOf(b.id); return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi) || rooms.indexOf(a) - rooms.indexOf(b); });
  }
  move(id: string, target: string, rooms: { id: string }[]): void {
    if (id === target) return;
    const ids = this.sorted(rooms).map(room => room.id); if (!ids.includes(id) || !ids.includes(target)) return;
    ids.splice(ids.indexOf(id), 1); ids.splice(ids.indexOf(target), 0, id); this.order = ids; this.save();
  }
}
