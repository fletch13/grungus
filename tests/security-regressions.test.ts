import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { MatrixClient } from "../src/renderer/services/matrix-client.ts";
import { encryptAttachment, decryptAttachment } from "../src/renderer/services/attachments.ts";
import { CryptoVault } from "../src/main/crypto-vault.ts";
import { authorizeRoom, liveKitRoomName } from "../livekit/authorization.ts";

test("unknown room rejects every send before network access", async () => {
  const client = new MatrixClient({ baseUrl: "http://127.0.0.1:1" });
  const unknown = "!unknown:example.org";
  const reject = (action: () => Promise<unknown>) => assert.rejects(action, /room state not loaded/);
  await reject(() => client.sendMessage(unknown, "private"));
  await reject(() => client.editMessage(unknown, "$event", "private edit"));
  await reject(() => client.replyMessage(unknown, "$event", "@user:test", "private parent", "private reply"));
  await reject(() => client.sendReaction(unknown, "$event", "👍"));
  await reject(() => client.sendRoomEvent(unknown, "m.test", { secret: "private" }));
  await reject(() => client.sendMedia(unknown, { mxc: "mxc://example.org/file", name: "private", mimeType: "image/png" }));
  await reject(() => client.uploadAndSendMedia(unknown, "private.png", "image/png", new Uint8Array([1])));
});

test("attachment v2 encrypts, round-trips, and rejects modified ciphertext", async () => {
  const bytes = new TextEncoder().encode("private image bytes");
  const a = await encryptAttachment(bytes);
  const b = await encryptAttachment(bytes);
  assert.notDeepEqual(a.bytes, bytes);
  assert.notEqual(a.file.key.k, b.file.key.k);
  assert.equal(a.file.key.alg, "A256CTR");
  assert.deepEqual(await decryptAttachment(a.bytes, a.file), bytes);
  const { createDecipheriv } = await import("node:crypto");
  const decipher = createDecipheriv("aes-256-ctr", Buffer.from(a.file.key.k!, "base64url"), Buffer.from(a.file.iv, "base64"));
  assert.deepEqual(Buffer.concat([decipher.update(a.bytes), decipher.final()]), Buffer.from(bytes));
  a.bytes[0] = a.bytes[0]! ^ 1;
  await assert.rejects(() => decryptAttachment(a.bytes, a.file), /integrity/);
});

test("vault keeps a backup and refuses corrupt or inaccessible data", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grungus-vault-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "vault.json");
  let locked = false;
  const vault = new CryptoVault(file, {
    isEncryptionAvailable: () => !locked,
    encryptString: value => Buffer.from(value),
    decryptString: value => { if (locked) throw new Error("locked"); return value.toString(); },
  });
  vault.put("identity", "first");
  const first = fs.readFileSync(file, "utf8");
  vault.put("session", "second");
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), first);
  assert.equal(vault.read().identity, "first");
  const valid = fs.readFileSync(file, "utf8");
  locked = true;
  assert.throws(() => vault.put("new", "key"), /cannot be read/);
  assert.equal(fs.readFileSync(file, "utf8"), valid);
  locked = false;
  fs.writeFileSync(file, "{broken");
  assert.throws(() => vault.put("new", "key"), /cannot be read/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
  fs.unlinkSync(file);
  assert.throws(() => vault.put("new", "key"), /unavailable/);
});

test("room authorization denies outsiders and failures; room mapping avoids collisions", async t => {
  let membership = "join";
  let status = 200;
  const server = http.createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer service-token");
    assert.ok(req.url?.endsWith("/state/m.room.member/%40alice%3Aexample.org"));
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ membership }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const room = "!private:example.org";
  await authorizeRoom(url, "service-token", "@alice:example.org", room);
  membership = "leave";
  await assert.rejects(() => authorizeRoom(url, "service-token", "@alice:example.org", room), /not a current member/);
  status = 403;
  membership = "join";
  await assert.rejects(() => authorizeRoom(url, "service-token", "@alice:example.org", room));
  await assert.rejects(() => authorizeRoom(url, undefined, "@alice:example.org", room), /not configured/);
  assert.notEqual(liveKitRoomName("!a:b-c"), liveKitRoomName("!a-b:c"));
  assert.notEqual(liveKitRoomName(`!${"a".repeat(150)}:a`), liveKitRoomName(`!${"a".repeat(150)}:b`));
});

test("failed vault replacement preserves the original and cleans up temporary files", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grungus-vault-failure-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "vault.json");
  const vault = new CryptoVault(file, { isEncryptionAvailable: () => false, encryptString: Buffer.from, decryptString: value => value.toString() });
  vault.put("identity", "original");
  const previous = fs.readFileSync(file, "utf8");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    if (destination === file) throw new Error("simulated disk failure");
    return rename(source, destination);
  });
  assert.throws(() => vault.put("identity", "replacement"), /simulated disk failure/);
  assert.equal(fs.readFileSync(file, "utf8"), previous);
  assert.equal(fs.readFileSync(`${file}.bak`, "utf8"), previous);
  assert.ok(fs.readdirSync(dir).every(name => !name.endsWith(".tmp")));
});

for (const mode of ["openid", "whoami"]) test(`LiveKit endpoint enforces ${mode} verification and room authorization`, async t => {
  const { spawn } = await import("node:child_process");
  const jwt = (await import("jsonwebtoken")).default;
  let membership = "join";
  const upstream = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/_matrix/federation/")) {
      assert.equal(mode, "openid");
      res.end(JSON.stringify({ sub: "@alice:example.org" }));
    } else if (req.url?.endsWith("/account/whoami")) {
      assert.equal(mode, "whoami");
      assert.equal(req.headers.authorization, "Bearer identity-proof");
      res.end(JSON.stringify({ user_id: "@alice:example.org" }));
    } else {
      assert.equal(req.headers.authorization, "Bearer service-token");
      res.end(JSON.stringify({ membership }));
    }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const hsUrl = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`;
  const child = spawn(process.execPath, [path.resolve("livekit/auth-service.ts")], {
    env: { ...process.env, PORT: "0", VERIFY_MODE: mode, HS_URL: hsUrl, HS_AUTH_TOKEN: "service-token", LK_API_KEY: "test-key", LK_API_SECRET: "test-secret" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => new Promise<void>(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", () => resolve());
    child.kill();
  }));
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Token service did not start")), 5000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    let output = "";
    child.stdout.on("data", chunk => {
      output += String(chunk);
      const match = output.match(/up on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]!); }
    });
  });
  const request = (body: Record<string, unknown>) => fetch(`${baseUrl}/grungus/livekit/join`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const roomId = "!private:example.org";
  const proof = mode === "openid" ? { openid_token: "identity-proof" } : { matrix_token: "identity-proof" };
  const wrongProof = mode === "openid" ? { matrix_token: "identity-proof" } : { openid_token: "identity-proof" };
  assert.equal((await request({ room_id: roomId, ...wrongProof })).status, 403);
  assert.equal((await request({ room_id: roomId, ...proof, padding: "x".repeat(17 * 1024) })).status, 413);
  assert.equal((await request({})).status, 400);
  const invalidJson = await fetch(`${baseUrl}/grungus/livekit/join`, { method: "POST", body: "{invalid" });
  assert.equal(invalidJson.status, 400);
  const response = await request({ room_id: roomId, room: "attacker-selected", ...proof });
  assert.equal(response.status, 200);
  const data = await response.json() as { token: string; room: string };
  const claims = jwt.verify(data.token, "test-secret") as import("jsonwebtoken").JwtPayload;
  assert.equal(claims.sub, "@alice:example.org");
  assert.equal(claims.video.canPublish, true);
  assert.equal(claims.video.canSubscribe, true);
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.room, liveKitRoomName(roomId));
  assert.equal(data.room, liveKitRoomName(roomId));
  membership = "leave";
  assert.equal((await request({ room_id: roomId, ...proof })).status, 403);
  assert.equal((await request({ room: "arbitrary-room", ...proof })).status, 400);
});

test("LiveKit service refuses missing signing credentials", async () => {
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, [path.resolve("livekit/auth-service.ts")], {
    env: { ...process.env, LK_API_KEY: "", LK_API_SECRET: "" }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-default credentials/);
});
