import test from "node:test";
import assert from "node:assert/strict";
import { recentDirectRooms } from "../src/renderer/services/recent-dms.ts";
import { createRoomRecord } from "../src/renderer/services/matrix-rooms.ts";
test("recent DMs show the latest five conversations with stable ties and exclude other rooms", () => {
  const rooms = Array.from({ length: 7 }, (_, i) => { const room = createRoomRecord(`!dm${i}:test`); room.isDirect = true; room.lastActivityTs = i; return room; });
  const group = createRoomRecord("!group:test"); group.lastActivityTs = 100;
  assert.deepEqual(recentDirectRooms([...rooms, group]).map(room => room.id), [6, 5, 4, 3, 2].map(i => `!dm${i}:test`));
  rooms[0]!.lastActivityTs = 101;
  assert.equal(recentDirectRooms(rooms)[0]?.id, rooms[0]!.id);
  rooms[1]!.lastActivityTs = 101;
  assert.deepEqual(recentDirectRooms([...rooms].reverse()).slice(0, 2).map(room => room.id), [rooms[0]!.id, rooms[1]!.id]);
  assert.equal(rooms.length, 7, "Sorting must not mutate the source list");
});
