#!/usr/bin/env node
/*
 * Grungus example — list every joined room for an account.
 *
 *   GRUNGUS_HOMESERVER=http://127.0.0.1:8008 \
 *   GRUNGUS_USER=grungus_a GRUNGUS_PASS=secret \
 *   node examples/list-rooms.js
 */
"use strict";

const { MatrixClient } = require("../src/renderer/services/matrix-client.js");

const required = ["GRUNGUS_HOMESERVER", "GRUNGUS_USER", "GRUNGUS_PASS"];
for (const key of required) {
  if (!process.env[key]) {
    console.error("missing required env: " + key);
    process.exit(1);
  }
}

const env = process.env;
const client = new MatrixClient({ baseUrl: env.GRUNGUS_HOMESERVER });

(async () => {
  await client.loginWithPassword({
    username: env.GRUNGUS_USER,
    password: env.GRUNGUS_PASS,
  });
  client.startSync();
  await new Promise((resolve) => client.on("ready", resolve));

  console.log("rooms:");
  for (const room of client.getRooms()) {
    const kind = room.isDirect ? "dm" : "room";
    console.log(`  [${kind}] ${room.id}  "${room.title}"  members=${room.joinedMemberCount}`);
  }
  const spaces = client.getSpaces();
  if (spaces.length) {
    console.log("spaces:");
    for (const space of spaces) {
      console.log(`  ${space.id}  "${space.title}"  children=${space.children.size}`);
    }
  }
  client.stopSync();
  process.exit(0);
})().catch((e) => {
  console.error((e && e.stack) || e);
  process.exit(1);
});
