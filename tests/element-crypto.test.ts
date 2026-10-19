import test from "node:test";
import assert from "node:assert/strict";
import * as Rust from "@matrix-org/matrix-sdk-crypto-wasm";
import { MockHomeserver } from "./mock-homeserver.ts";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { E2eeCrypto, MemoryCryptoStore } from "../src/renderer/services/e2ee.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  const start = Date.now();
  while (!predicate()) { if (Date.now() - start > 5000) throw new Error("Timed out"); await new Promise(r => setTimeout(r, 20)); }
}
interface Request { id?: string; type: Rust.RequestType; body: string; event_type?: string; txn_id?: string; }
async function send(client: MatrixClient, machine: Rust.OlmMachine, request: Request): Promise<void> {
  const path = request.type === Rust.RequestType.KeysUpload ? "keys/upload" : request.type === Rust.RequestType.KeysQuery ? "keys/query" : request.type === Rust.RequestType.KeysClaim ? "keys/claim" : request.type === Rust.RequestType.SignatureUpload ? "keys/signatures/upload" : request.type === Rust.RequestType.ToDevice ? `sendToDevice/${request.event_type}/${request.txn_id}` : null;
  assert.ok(path, `Unhandled Rust request ${request.type}`);
  const response = await client.api(request.type === Rust.RequestType.ToDevice ? "PUT" : "POST", `/_matrix/client/v3/${path}`, { body: JSON.parse(request.body) });
  if (request.id) await machine.markRequestAsSent(request.id, request.type, JSON.stringify(response));
}
async function flush(client: MatrixClient, machine: Rust.OlmMachine): Promise<void> {
  for (const request of await machine.outgoingRequests()) await send(client, machine, request);
}

test("Element Rust engine sends to Grungus and decrypts Grungus messages in both directions", async t => {
  await Rust.initAsync();
  const hs = new MockHomeserver(); await hs.listen(); t.after(() => hs.close());
  hs.registerUser("grungus_rust", "pw"); hs.registerUser("element_rust", "pw");
  const grungus = new MatrixClient({ baseUrl: hs.baseUrl! });
  await grungus.loginWithPassword({ username: "grungus_rust", password: "pw" });
  const grungusStore = new MemoryCryptoStore();
  grungus.crypto = new E2eeCrypto({ host: grungus, store: grungusStore });
  await grungus.crypto.init();
  grungus.crypto.onInboundSessionAdded = room => grungus.retryUndecrypted(room);
  const element = new MatrixClient({ baseUrl: hs.baseUrl! });
  await element.loginWithPassword({ username: "element_rust", password: "pw" });
  const machine = await Rust.OlmMachine.initialize(new Rust.UserId(element.userId!), new Rust.DeviceId(element.deviceId!));
  t.after(() => { grungus.stopSync(); machine.close(); });
  await flush(element, machine);
  const room = await grungus.createRoom({ name: "Rust interop", encrypted: true, isPublic: true });
  await element.joinRoom(room);
  grungus.startSync();
  await waitFor(() => grungus.getRoom(room)?.members.has(element.userId!) === true);
  await machine.updateTrackedUsers([new Rust.UserId(grungus.userId!)]);
  await flush(element, machine);
  const claim = await machine.getMissingSessions([new Rust.UserId(grungus.userId!)]);
  if (claim) await send(element, machine, claim);
  const settings = new Rust.EncryptionSettings(); settings.sharingStrategy = Rust.CollectStrategy.allDevices();
  for (const request of await machine.shareRoomKey(new Rust.RoomId(room), [new Rust.UserId(grungus.userId!)], settings)) await send(element, machine, request);
  const encrypted = JSON.parse(await machine.encryptRoomEvent(new Rust.RoomId(room), "m.room.message", JSON.stringify({ msgtype: "m.text", body: "Element → Grungus" })));
  await element.api("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.encrypted/rust-event`, { body: encrypted });
  await waitFor(() => grungus.getRoom(room)?.timeline.some(item => item.kind === "message" && item.body === "Element → Grungus") === true);
  await grungus.sendMessage(room, "Grungus → Element");
  const sync = await element.api<{ to_device?: { events?: unknown[] } }>("GET", "/_matrix/client/v3/sync", { query: { timeout: 0 } });
  await machine.receiveSyncChanges(JSON.stringify(sync.to_device?.events ?? []), new Rust.DeviceLists(), new Map(), new Set());
  const event = hs.rooms.get(room)!.events.filter(event => event.type === "m.room.encrypted").at(-1)!;
  const decrypted = await machine.decryptRoomEvent(JSON.stringify(event), new Rust.RoomId(room), new Rust.DecryptionSettings(Rust.TrustRequirement.Untrusted));
  assert.equal(JSON.parse(decrypted.event).content.body, "Grungus → Element");
  await grungus.crypto.flush();
  grungus.crypto = new E2eeCrypto({ host: grungus, store: grungusStore });
  await grungus.crypto.init();
  grungus.crypto.onInboundSessionAdded = id => grungus.retryUndecrypted(id);
  assert.equal(grungus.crypto.decryptRoomEvent({ type: "m.room.encrypted", sender: element.userId!, content: encrypted }, room)?.content.body, "Element → Grungus", "Received history keys must survive restart without recovery");
  // A new Megolm session travels through the already-established Olm session.
  await machine.invalidateGroupSession(new Rust.RoomId(room));
  for (const request of await machine.shareRoomKey(new Rust.RoomId(room), [new Rust.UserId(grungus.userId!)], settings)) await send(element, machine, request);
  const afterRestart = JSON.parse(await machine.encryptRoomEvent(new Rust.RoomId(room), "m.room.message", JSON.stringify({ msgtype: "m.text", body: "Element after restart" })));
  await element.api("PUT", `/_matrix/client/v3/rooms/${encodeURIComponent(room)}/send/m.room.encrypted/rust-restart`, { body: afterRestart });
  await waitFor(() => grungus.getRoom(room)?.timeline.some(item => item.kind === "message" && item.body === "Element after restart") === true);

});

test("Element Rust engine recognizes a Grungus device recovered with an Element security key as owner cross-signed", async t => {
  const { SecretStorage, encodeRecoveryKey } = await import("../src/renderer/services/ssss.ts");
  const { recoverSession } = await import("../src/renderer/services/session-recovery.ts");
  await Rust.initAsync();
  const hs = new MockHomeserver(); await hs.listen(); t.after(() => hs.close());
  hs.registerUser("owner_rust", "pw");
  const element = new MatrixClient({ baseUrl: hs.baseUrl! });
  await element.loginWithPassword({ username: "owner_rust", password: "pw" });
  const machine = await Rust.OlmMachine.initialize(new Rust.UserId(element.userId!), new Rust.DeviceId(element.deviceId!));
  t.after(() => machine.close());
  await flush(element, machine);
  const bootstrap = await machine.bootstrapCrossSigning(false);
  if (bootstrap.uploadKeysRequest) await send(element, machine, bootstrap.uploadKeysRequest);
  await element.api("POST", "/_matrix/client/v3/keys/device_signing/upload", { body: JSON.parse(bootstrap.uploadSigningKeysRequest.body) });
  await send(element, machine, bootstrap.uploadSignaturesRequest);
  const secrets = await machine.exportCrossSigningKeys(); assert.ok(secrets);
  const storage = new SecretStorage(element);
  await storage.createKey("Element recovery fixture");
  await storage.storeSecret("m.cross_signing.master", secrets.masterKey!);
  await storage.storeSecret("m.cross_signing.self_signing", secrets.self_signing_key!);
  await storage.storeSecret("m.cross_signing.user_signing", secrets.userSigningKey!);
  const key = encodeRecoveryKey((await storage.debugKeyBytes("Element recovery fixture"))!);
  const fresh = new MatrixClient({ baseUrl: hs.baseUrl! });
  await fresh.loginWithPassword({ username: "owner_rust", password: "pw" });
  const freshStore = new MemoryCryptoStore();
  fresh.crypto = new E2eeCrypto({ host: fresh, store: freshStore }); await fresh.crypto.init();
  const result = await recoverSession(fresh, key);
  assert.equal(result.verified, true);
  await fresh.crypto.onOneTimeKeyCounts({ signed_curve25519: 0 });
  await fresh.crypto.flush();
  fresh.crypto = new E2eeCrypto({ host: fresh, store: freshStore });
  await fresh.crypto.init();
  await machine.receiveSyncChanges("[]", new Rust.DeviceLists([new Rust.UserId(fresh.userId!)]), new Map(), new Set());
  await flush(element, machine);
  const device = await machine.getDevice(new Rust.UserId(fresh.userId!), new Rust.DeviceId(fresh.deviceId!));
  assert.ok(device);
  assert.equal(device.isCrossSignedByOwner(), true, "Element's own engine must validate the recovered device's cross-signing chain");
});
