import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";

test("room directory uses authenticated filtered requests, pagination, and cancellation", async t => {
  const requests: { path: string; auth?: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    requests.push({ path: req.url!, auth: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ chunk: [{ room_id: "!lounge:test", name: "Lounge", num_joined_members: 4, join_rule: "public" }], next_batch: "next" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const client = new MatrixClient({ baseUrl: `http://127.0.0.1:${address.port}` });
  client.accessToken = "directory-test-token";
  const page = await client.publicRooms();
  assert.equal(page.chunk[0]?.name, "Lounge");
  assert.equal(page.next_batch, "next");
  await client.publicRooms("  games  ", page.next_batch);
  assert.deepEqual(requests, [
    { path: "/_matrix/client/v3/publicRooms", auth: "Bearer directory-test-token", body: { limit: 30, filter: { room_types: [null] } } },
    { path: "/_matrix/client/v3/publicRooms", auth: "Bearer directory-test-token", body: { limit: 30, since: "next", filter: { generic_search_term: "games", room_types: [null] } } },
  ]);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(client.publicRooms("", undefined, controller.signal));
});

test("space hierarchy uses its own endpoint and pagination instead of the public directory", async () => {
  const client = new MatrixClient({ baseUrl: "https://example.org" });
  const calls: unknown[][] = [];
  client.api = async <T>(...args: Parameters<MatrixClient["api"]>): Promise<T> => {
    calls.push(args);
    return { rooms: [], next_batch: "next-space-page" } as T;
  };
  const controller = new AbortController();
  const page = await client.spaceHierarchy("!friends:remote.test", "previous", controller.signal);
  assert.equal(page.next_batch, "next-space-page");
  assert.deepEqual(calls, [["GET", "/_matrix/client/v1/rooms/!friends%3Aremote.test/hierarchy", {
    query: { limit: 30, max_depth: 1, suggested_only: "false", from: "previous" }, signal: controller.signal,
  }]]);
  const joinCalls: unknown[][] = [];
  client.api = async <T>(...args: Parameters<MatrixClient["api"]>): Promise<T> => {
    joinCalls.push(args);
    return (args[0] === "POST" ? { room_id: "!lounge:remote.test" } : {}) as T;
  };
  await client.joinRoom("!lounge:remote.test", ["remote.test", "other.test"]);
  assert.equal(joinCalls[0]?.[1], "/_matrix/client/v3/join/!lounge%3Aremote.test?server_name=remote.test&server_name=other.test");
});
