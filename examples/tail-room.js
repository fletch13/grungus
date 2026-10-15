#!/usr/bin/env node
/*
 * Grungus example — live-tail every event in one room (Ctrl-C to stop).
 * Handy for watching the desktop app's traffic while you test it.
 *
 *   GRUNGUS_HOMESERVER=http://127.0.0.1:8008 \
 *   GRUNGUS_USER=grungus_b GRUNGUS_PASS=secret \
 *   GRUNGUS_ROOM_ID='!abc:example.org' \
 *   node examples/tail-room.js
 */
"use strict";

const { MatrixClient } = require("../src/renderer/services/matrix-client.js");

const required = [
  "GRUNGUS_HOMESERVER",
  "GRUNGUS_USER",
  "GRUNGUS_PASS",
  "GRUNGUS_ROOM_ID",
];

for (const key of required) {
  if (!process.env[key]) {
    console.error("missing required env: " + key);
    process.exit(1);
  }
}

const env = process.env;
const client = new MatrixClient({ baseUrl: env.GRUNGUS_HOMESERVER });

client.on("room", ({ room, newEvents }) => {
  if (room.id !== env.GRUNGUS_ROOM_ID) return;
  for (const event of newEvents) {
    if (event.kind === "message") {
      console.log(`${event.senderName}: ${event.body}`);
    } else if (event.kind === "system") {
      console.log(`* ${event.text}`);
    }
  }
});
client.on("connection", (state) => {
  if (state === "offline") console.error("[connection lost — retrying]");
});

(async () => {
  await client.loginWithPassword({
    username: env.GRUNGUS_USER,
    password: env.GRUNGUS_PASS,
  });
  client.startSync();
  console.log(`tailing ${env.GRUNGUS_ROOM_ID} as ${client.userId} — Ctrl-C to stop`);
})().catch((e) => {
  console.error((e && e.stack) || e);
  process.exit(1);
});
