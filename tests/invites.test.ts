/*
 * Grungus — invites (rooms.invite in /sync) against the mock homeserver:
 * receiving an invite, accepting it, and declining one.
 *
 * Run: npm test
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient, type MessageItem } from "../src/renderer/services/matrix-client.ts";

function waitFor(
  predicate: () => boolean,
  timeoutMs = 8_000,
  label = "condition"
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      let ok = false;
      try {
        ok = predicate();
      } catch (e) {
        reject(e);
        return;
      }
      if (ok) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Timed out waiting for: ${label}`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function makeUser(hs: MockHomeserver, name: string, password: string): Promise<MatrixClient> {
  hs.registerUser(name, password);
  const client = new MatrixClient({ baseUrl: hs.baseUrl! });
  return client.loginWithPassword({ username: name, password }).then(() => client);
}

test("invites: appear in sync, accept joins and delivers messages", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const host = await makeUser(hs, "inv_host", "pw1");
  const guest = await makeUser(hs, "inv_guest", "pw2");
  host.startSync();
  guest.startSync();
  t.after(() => {
    host.stopSync();
    guest.stopSync();
  });

  const roomId = await host.createRoom({ name: "dinner-party", isPublic: false });
  await waitFor(() => host.getRoom(roomId) !== null, 5_000, "host sees room");

  await host.invite(roomId, guest.userId!);
  await waitFor(
    () => guest.getInvites().some((invite) => invite.id === roomId),
    8_000,
    "guest sees the invite"
  );

  const invite = guest.getInvites().find((entry) => entry.id === roomId)!;
  assert.equal(invite.name, "dinner-party");
  assert.equal(invite.inviterId, host.userId);
  assert.equal(invite.isEncrypted, false);

  await guest.acceptInvite(roomId);
  assert.equal(guest.getInvites().length, 0, "invite cleared on accept");
  await waitFor(() => guest.getRoom(roomId) !== null, 8_000, "guest joined");

  await host.sendMessage(roomId, "welcome!");
  await waitFor(
    () =>
      (guest.getRoom(roomId)?.timeline ?? []).some(
        (item): item is MessageItem =>
          item.kind === "message" && item.body === "welcome!"
      ),
    8_000,
    "guest receives messages after accepting"
  );
});

test("invites: decline clears the invite without joining", async (t) => {
  const hs = new MockHomeserver();
  await hs.listen();
  t.after(() => hs.close());

  const host = await makeUser(hs, "dec_host", "pw1");
  const guest = await makeUser(hs, "dec_guest", "pw2");
  host.startSync();
  guest.startSync();
  t.after(() => {
    host.stopSync();
    guest.stopSync();
  });

  const roomId = await host.createRoom({ name: "no-thanks", isPublic: false });
  await waitFor(() => host.getRoom(roomId) !== null, 5_000, "host sees room");

  await host.invite(roomId, guest.userId!);
  await waitFor(
    () => guest.getInvites().some((invite) => invite.id === roomId),
    8_000,
    "guest sees the invite"
  );

  await guest.declineInvite(roomId);
  assert.equal(guest.getInvites().length, 0, "invite cleared on decline");
  assert.equal(guest.getRoom(roomId), null, "guest never joined");
});
