import test from "node:test";
import assert from "node:assert/strict";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { createRoomRecord } from "../src/renderer/services/matrix-rooms.ts";
import { createSpaceRoom, SpaceRoomLinkError } from "../src/renderer/services/space-room-creation.ts";

test("space creation retries linking without creating duplicate rooms and checks fresh permissions", async () => {
  const space = createRoomRecord("!space:test"); space.isSpace = true;
  let level = 100, creates = 0, links = 0;
  const client = {
    userId: "@me:test",
    getRoomPowerLevels: async () => ({ users: { "@me:test": level } }),
    createRoom: async (options: { parentSpaceId?: string; name?: string }) => { creates++; assert.equal(options.parentSpaceId, space.id); assert.equal(options.name, "Lounge"); return "!new:test"; },
    addToSpace: async () => { if (++links === 1) throw new Error("Temporary outage"); },
  } as unknown as MatrixClient;
  await assert.rejects(createSpaceRoom(client, space, { name: " Lounge " }), error => error instanceof SpaceRoomLinkError && error.roomId === "!new:test");
  assert.equal(space.children.size, 0);
  await createSpaceRoom(client, space, { name: "Lounge" }, "!new:test");
  assert.equal(creates, 1); assert.equal(links, 2); assert.ok(space.children.has("!new:test"));
  level = 0;
  await assert.rejects(createSpaceRoom(client, space, { name: "Blocked" }), /permission/);
  assert.equal(creates, 1);
});

test("advanced room creation combines encryption, access, history, avatar and parent state", async () => {
  const client = new MatrixClient({ baseUrl: "https://test", userId: "@me:test" });
  let body: Record<string, any> = {};
  client.api = (async (_method: string, _path: string, options: { body: Record<string, any> }) => { body = options.body; return { room_id: "!new:test" }; }) as typeof client.api;
  await client.createRoom({ name: "Lounge", encrypted: true, isVideo: true, joinRule: "restricted", parentSpaceId: "!space:test", historyVisibility: "joined", avatarUrl: "mxc://test/avatar", aliasLocalpart: "lounge", announcementOnly: true, membersCanInvite: false, publish: false });
  const state = body.initial_state as { type: string; state_key: string; content: any }[];
  assert.equal(state.find(s => s.type === "m.room.encryption")?.content.algorithm, "m.megolm.v1.aes-sha2");
  assert.deepEqual(state.find(s => s.type === "m.room.join_rules")?.content, { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: "!space:test" }] });
  assert.equal(state.find(s => s.type === "m.room.history_visibility")?.content.history_visibility, "joined");
  assert.equal(state.find(s => s.type === "m.room.avatar")?.content.url, "mxc://test/avatar");
  assert.equal(state.find(s => s.type === "m.space.parent")?.state_key, "!space:test");
  assert.equal(body.creation_content.type, "org.matrix.msc3417.call");
  assert.equal(body.room_alias_name, "lounge"); assert.equal(body.visibility, "private");
  assert.equal(body.power_level_content_override.events_default, 50);
  assert.equal(body.power_level_content_override.invite, 50);
  assert.equal(body.power_level_content_override.events["org.matrix.msc3401.call.member"], 0);
  await assert.rejects(client.createRoom({ name: "Invalid", publish: true }), /Only public/);
  await assert.rejects(client.createRoom({ name: "Invalid", aliasLocalpart: "bad address" }), /Room address/);
  await assert.rejects(client.createRoom({ name: "Invalid", joinRule: "restricted" }), /parent space/);
});
