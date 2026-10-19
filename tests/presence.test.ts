import test from "node:test";
import assert from "node:assert/strict";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { MockHomeserver } from "./mock-homeserver.ts";

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Presence did not update"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
test("sync presence updates online, offline, and away without room events, and ignores invalid values", async t => {
  const hs = new MockHomeserver(); await hs.listen(); t.after(() => hs.close());
  hs.registerUser("presence_me", "pw");
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  await client.loginWithPassword({ username: "presence_me", password: "pw" });
  const peer = "@presence_friend:mock.hs";
  assert.equal(client.getPresence(peer), null);
  let changes = 0;
  client.on("presence", users => { assert.ok(users.includes(peer)); changes++; });
  hs.setPresence(peer, "online");
  client.startSync(); t.after(() => client.stopSync());
  await waitFor(() => client.getPresence(peer) === "online");
  hs.setPresence(peer, "offline");
  await waitFor(() => client.getPresence(peer) === "offline");
  hs.setPresence(peer, "unavailable");
  await waitFor(() => client.getPresence(peer) === "unavailable");
  hs.setPresence(peer, "invalid");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(client.getPresence(peer), "unavailable");
  assert.equal(changes, 3);
  assert.equal(client.rooms.size, 0);
});
