#!/usr/bin/env node
/*
 * Grungus example — send one message from the command line with the same
 * MatrixClient module the desktop app uses (no Electron involved).
 *
 *   GRUNGUS_HOMESERVER=http://127.0.0.1:8008 \
 *   GRUNGUS_USER=grungus_b GRUNGUS_PASS=secret \
 *   GRUNGUS_ROOM_ID='!abc:example.org' \
 *   GRUNGUS_MESSAGE='hello from node' \
 *   node examples/send-message.ts
 */
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";

for (const key of [
  "GRUNGUS_HOMESERVER",
  "GRUNGUS_USER",
  "GRUNGUS_PASS",
  "GRUNGUS_ROOM_ID",
  "GRUNGUS_MESSAGE",
]) {
  if (!process.env[key]) {
    console.error("missing required env: " + key);
    process.exit(1);
  }
}

const env = process.env;
const client = new MatrixClient({ baseUrl: env.GRUNGUS_HOMESERVER! });
client.on("error", (e: unknown) =>
  console.error("client error:", e instanceof Error ? e.message : e)
);

void (async () => {
  try {
    await client.loginWithPassword({
      username: env.GRUNGUS_USER!,
      password: env.GRUNGUS_PASS!,
    });
    client.startSync();
    await new Promise<void>((resolve) => client.on("ready", resolve));

    if (!client.getRoom(env.GRUNGUS_ROOM_ID!)) {
      console.error("room not visible (not joined?): " + env.GRUNGUS_ROOM_ID);
      process.exit(1);
    }

    const eventId = await client.sendMessage(
      env.GRUNGUS_ROOM_ID!,
      env.GRUNGUS_MESSAGE!
    );
    console.log("sent", eventId);
    client.stopSync();
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error && e.stack ? e.stack : e);
    process.exit(1);
  }
})();
