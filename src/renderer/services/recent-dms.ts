import type { Room } from "./matrix-types.ts";
/** Stable ordering prevents equal timestamps from shuffling on each sync. */
export function recentDirectRooms(rooms: Room[]): Room[] {
  return rooms.filter(room => room.isDirect && !room.isSpace)
    .sort((a, b) => b.lastActivityTs - a.lastActivityTs || a.id.localeCompare(b.id)).slice(0, 5);
}
