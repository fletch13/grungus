/*
 * Grungus — in-process mock Matrix homeserver for the test suite.
 *
 * Implements just enough of the Matrix Client-Server API to exercise the
 * real MatrixClient over HTTP: password login, whoami, profile, logout,
 * createRoom, join, invite, message send, and /sync (initial + long-poll).
 * Not spec-complete — it exists so `npm test` runs fast and deterministic
 * without infrastructure. For testing against a real homeserver see
 * tests/e2e-real-homeserver.ts.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";

interface MockUser {
  username: string;
  password: string;
  userId: string;
  displayname: string;
}

interface MockEvent {
  event_id: string;
  type: string;
  sender: string;
  content: Record<string, unknown>;
  origin_server_ts: number;
  seq: number;
  state_key?: string;
  unsigned?: { prev_content?: Record<string, unknown>; [key: string]: unknown };
}

interface MockRoom {
  id: string;
  name: string | null;
  topic: string | null;
  creator: string;
  joinRule: string;
  isSpace: boolean;
  /** userId -> membership (mock-side routing bookkeeping) */
  members: Map<string, string>;
  events: MockEvent[];
  /** typing: userId -> active-until timestamp */
  typingUntil: Map<string, number>;
  /** bumped on typing changes so long-polls wake */
  typingSeq: number;
}

interface MockDevice {
  deviceId: string;
  deviceKeys: Record<string, unknown>;
  /** "signed_curve25519/<id>" -> signed key object ({ key, signatures }) */
  oneTimeKeys: Map<string, Record<string, unknown>>;
}

interface CreateRoomOptions {
  name: string | null;
  topic: string | null;
  isPublic: boolean;
  isSpace: boolean;
}

export class MockHomeserver {
  readonly users = new Map<string, MockUser>();
  /** token -> { username, deviceId } — tokens are device-bound like real servers. */
  readonly tokens = new Map<string, { username: string; deviceId: string }>();
  readonly rooms = new Map<string, MockRoom>();
  /** media: id -> { bytes, mime } */
  readonly media = new Map<string, { bytes: Buffer; mime: string }>();
  /** username -> deviceId -> device (keys + one-time keys). */
  readonly devices = new Map<string, Map<string, MockDevice>>();
  /** SSO simulation: advertised identity providers (enableSso() to use). */
  ssoEnabled = false;
  readonly ssoProviders = [{ id: "keycloak", name: "University Keycloak" }];
  /** loginToken -> username, issued by the fake IdP redirect. */
  private readonly ssoLoginTokens = new Map<string, string>();
  /** Server-side key backup (single version, per-user). */
  readonly keyBackups = new Map<string, { version: string; body: Record<string, unknown> }>();
  /** username -> roomId -> sessionId -> backed-up entry. */
  readonly backedUpKeys = new Map<string, Record<string, Record<string, unknown>>>();
  /** username -> deviceId -> queued to-device events (with global seq for sync wakeups).
   *  To-device routing is PER DEVICE (real servers never leak one device's
   *  olm messages to another device of the same user). */
  private readonly toDeviceQueue = new Map<
    string,
    Map<string, { seq: number; event: Record<string, unknown> }[]>
  >();
  baseUrl: string | null = null;
  port: number | null = null;
  private _server: http.Server | null = null;
  private _seq = 0;
  private _eventCounter = 0;
  private _roomCounter = 0;

  listen(host = "127.0.0.1"): Promise<{ baseUrl: string; port: number }> {
    return new Promise((resolve) => {
      this._server = http.createServer((req, res) => this._handleRequest(req, res));
      this._server.listen(0, host, () => {
        const addr = this._server!.address() as AddressInfo;
        this.baseUrl = `http://${addr.address}:${addr.port}`;
        this.port = addr.port;
        resolve({ baseUrl: this.baseUrl, port: addr.port });
      });
    });
  }

  private _closed = false;

  close(): Promise<void> {
    this._closed = true; /* abort pending long-poll loops */
    return new Promise((resolve) => {
      const server = this._server;
      if (!server) {
        resolve();
        return;
      }
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      server.close(() => resolve());
    });
  }

  registerUser(username: string, password: string): string {
    const userId = `@${username}:mock.hs`;
    this.users.set(username, { username, password, userId, displayname: username });
    return userId;
  }

  /** Mock-only helper: attach a room to a space (m.space.child state event). */
  addSpaceChild(spaceRoomId: string, childRoomId: string): void {
    const room = this.rooms.get(spaceRoomId);
    if (!room) throw new Error("addSpaceChild: unknown space room");
    this._appendEvent(room, "m.space.child", room.creator, { via: ["mock.hs"] }, {
      state_key: childRoomId,
    });
  }

  /**
   * Mock-only helper: append an arbitrary event to a room (e.g. an
   * m.image message the client itself cannot send yet).
   */
  pushEvent(
    roomId: string,
    type: string,
    sender: string,
    content: Record<string, unknown>
  ): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`pushEvent: unknown room ${roomId}`);
    this._appendEvent(room, type, sender, content);
  }

  /* ------------------------------ events ------------------------------ */

  private _appendEvent(
    room: MockRoom,
    type: string,
    sender: string,
    content: Record<string, unknown>,
    extra?: { state_key?: string }
  ): MockEvent {
    const ev: MockEvent = {
      event_id: "$e" + ++this._eventCounter,
      type,
      sender,
      content,
      origin_server_ts: Date.now(),
      seq: ++this._seq,
    };
    if (extra && extra.state_key !== undefined) ev.state_key = extra.state_key;
    /* real servers attach unsigned.prev_content on membership transitions —
       the client's key rotation depends on it */
    if (
      ev.type === "m.room.member" &&
      ev.state_key !== undefined &&
      room.members.has(ev.state_key)
    ) {
      const prev = room.members.get(ev.state_key);
      ev.unsigned = {
        ...ev.unsigned,
        prev_content: { membership: prev },
      };
    }
    room.events.push(ev);

    /* mock-side bookkeeping for routing (join checks etc.) */
    if (ev.type === "m.room.member" && ev.state_key !== undefined) {
      room.members.set(ev.state_key, String(ev.content.membership ?? "leave"));
    } else if (ev.type === "m.room.join_rules") {
      room.joinRule = String(ev.content.join_rule ?? "invite");
    } else if (ev.type === "m.room.create") {
      room.isSpace = ev.content.type === "m.space";
    }
    return ev;
  }

  private _createRoomInternal(creator: MockUser, opts: CreateRoomOptions): MockRoom {
    const roomId = `!r${++this._roomCounter}:mock.hs`;
    const room: MockRoom = {
      id: roomId,
      name: opts.name,
      topic: opts.topic,
      creator: creator.userId,
      joinRule: opts.isPublic ? "public" : "invite",
      isSpace: opts.isSpace,
      members: new Map(),
      events: [],
      typingUntil: new Map(),
      typingSeq: 0,
    };
    this.rooms.set(roomId, room);

    const createContent: Record<string, unknown> = { creator: creator.userId };
    if (opts.isSpace) createContent.type = "m.space";
    this._appendEvent(room, "m.room.create", creator.userId, createContent, {
      state_key: "",
    });
    this._appendEvent(
      room,
      "m.room.member",
      creator.userId,
      { membership: "join", displayname: creator.displayname },
      { state_key: creator.userId }
    );
    this._appendEvent(
      room,
      "m.room.join_rules",
      creator.userId,
      { join_rule: room.joinRule },
      { state_key: "" }
    );
    if (opts.name) {
      this._appendEvent(room, "m.room.name", creator.userId, { name: opts.name }, {
        state_key: "",
      });
    }
    if (opts.topic) {
      this._appendEvent(room, "m.room.topic", creator.userId, { topic: opts.topic }, {
        state_key: "",
      });
    }
    return room;
  }

  /* ------------------------------- HTTP ------------------------------- */

  private _handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === "OPTIONS") {
      this._send(res, 204, null);
      return;
    }

    /* media upload carries raw bytes — bypass the JSON body reader */
    const uploadUrl = new URL(req.url ?? "/", "http://mock.hs");
    if (req.method === "POST" && uploadUrl.pathname === "/_matrix/media/v3/upload") {
      this._handleUpload(req, res);
      return;
    }

    /* fake IdP (Keycloak stand-in) — lives outside /_matrix, handled early */
    if (req.method === "GET" && uploadUrl.pathname === "/_fake_idp/auth") {
      const redirectUrl = uploadUrl.searchParams.get("redirectUrl");
      if (!redirectUrl) {
        this._err(res, 400, "M_BAD_JSON", "redirectUrl required");
        return;
      }
      const lastUser = [...this.users.values()].pop();
      if (!lastUser) {
        this._err(res, 500, "M_UNKNOWN", "No users registered");
        return;
      }
      const token = "sso_tok_" + crypto.randomBytes(12).toString("hex");
      this.ssoLoginTokens.set(token, lastUser.username);
      const sep = redirectUrl.includes("?") ? "&" : "?";
      res.writeHead(302, { Location: `${redirectUrl}${sep}loginToken=${token}` });
      res.end();
      return;
    }

    /* SSO redirect lives under /_matrix/client/v3 but needs no auth */
    if (req.method === "GET" && /^\/_matrix\/client\/v\d+\/login\/sso\/redirect/.test(uploadUrl.pathname)) {
      const match = uploadUrl.pathname.match(/\/login\/sso\/redirect(?:\/([^/]+))?$/);
      const idpId = match?.[1] ?? null;
      if (idpId && !this.ssoProviders.some((p) => p.id === idpId)) {
        this._err(res, 404, "M_NOT_FOUND", "Unknown SSO provider");
        return;
      }
      const redirectUrl = uploadUrl.searchParams.get("redirectUrl");
      if (!redirectUrl) {
        this._err(res, 400, "M_BAD_JSON", "redirectUrl required");
        return;
      }
      const authUrl =
        `${this.baseUrl!}/_fake_idp/auth?redirectUrl=${encodeURIComponent(redirectUrl)}`;
      res.writeHead(302, { Location: authUrl });
      res.end();
      return;
    }

    this._readBody(req)
      .then((body) => this._route(req, res, body))
      .catch((err: unknown) => {
        this._send(res, 500, {
          errcode: "M_UNKNOWN",
          error: String(err),
        });
      });
  }

  private _handleUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
    const user = this._authUser(req);
    if (!user) {
      this._err(res, 401, "M_UNKNOWN_TOKEN", "Unrecognised access token");
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const id = crypto.randomBytes(16).toString("hex");
      const mime = String(req.headers["content-type"] ?? "application/octet-stream");
      this.media.set(id, { bytes, mime });
      this._send(res, 200, { content_uri: `mxc://mock.hs/${id}` });
    });
  }

  private _sendBytes(
    res: http.ServerResponse,
    status: number,
    mime: string,
    bytes: Buffer
  ): void {
    res.writeHead(status, {
      "Content-Type": mime,
      "Content-Length": bytes.length,
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end(bytes);
  }

  private _readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      if (req.method !== "POST" && req.method !== "PUT") {
        resolve({});
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
        } catch {
          resolve({});
        }
      });
    });
  }

  private _send(res: http.ServerResponse, status: number, payload: unknown): void {
    const data = status === 204 ? "" : JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end(data);
  }

  private _err(
    res: http.ServerResponse,
    status: number,
    errcode: string,
    error: string
  ): void {
    this._send(res, status, { errcode, error });
  }

  private _authContext(
    req: http.IncomingMessage
  ): { user: MockUser; deviceId: string } | null {
    const header = req.headers["authorization"] ?? "";
    const token = String(header).replace(/^Bearer /, "");
    const entry = this.tokens.get(token);
    if (!entry) return null;
    const user = this.users.get(entry.username);
    return user ? { user, deviceId: entry.deviceId } : null;
  }

  private _authUser(req: http.IncomingMessage): MockUser | null {
    return this._authContext(req)?.user ?? null;
  }

  private _route(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    body: Record<string, unknown>
  ): void {
    const url = new URL(req.url ?? "/", "http://mock.hs");
    const parts = decodeURIComponent(url.pathname).split("/").filter(Boolean);
    const query = url.searchParams;

    if (req.method === "GET" && parts.join("/") === "_matrix/client/versions") {
      this._send(res, 200, { versions: ["v1.11.0"] });
      return;
    }

    /* media endpoints live under _matrix/media (not client/v3) */
    if (parts[0] === "_matrix" && parts[1] === "media" && req.method === "GET") {
      const mediaRoute = parts.slice(2).join("/"); /* v3/download/{server}/{id} */
      const mediaMatch = mediaRoute.match(/^v3\/(?:download|thumbnail)\/([^/]+)\/([^/]+)$/);
      const item = mediaMatch
        ? this.media.get(decodeURIComponent(mediaMatch[2] ?? ""))
        : null;
      if (item) {
        this._sendBytes(res, 200, item.mime, item.bytes);
      } else {
        this._err(res, 404, "M_NOT_FOUND", "Unknown media");
      }
      return;
    }

    if (parts[0] !== "_matrix" || parts[1] !== "client" || parts[2] !== "v3") {
      this._err(res, 404, "M_UNRECOGNIZED", "Unknown endpoint");
      return;
    }
    const route = parts.slice(3).join("/");

    /* POST /login (no auth) */
    /* GET /login: the login modes this server offers (SSO providers included) */
    if (req.method === "GET" && route === "login") {
      const flows: Record<string, unknown>[] = [{ type: "m.login.password" }];
      if (this.ssoEnabled) {
        flows.push({ type: "m.login.sso", identity_providers: this.ssoProviders });
      }
      this._send(res, 200, { flows });
      return;
    }

    /* SSO redirect + fake IdP handled pre-route in _handleRequest */
    if (req.method === "POST" && route === "login") {
      /* m.login.token: exchange the loginToken from the SSO redirect */
      if (body.type === "m.login.token") {
        const username = this.ssoLoginTokens.get(String(body.token ?? ""));
        if (!username) {
          this._err(res, 403, "M_FORBIDDEN", "Invalid login token");
          return;
        }
        this.ssoLoginTokens.delete(String(body.token ?? ""));
        const ssoUser = this.users.get(username)!;
        const token = "tok_" + crypto.randomBytes(12).toString("hex");
        const deviceId = "MOCK_" + crypto.randomBytes(6).toString("hex");
        this.tokens.set(token, { username, deviceId });
        this._send(res, 200, {
          access_token: token,
          user_id: ssoUser.userId,
          device_id: deviceId,
          home_server: "mock.hs",
        });
        return;
      }
      const identifier = (body.identifier ?? {}) as { user?: string };
      const user = this.users.get(String(identifier.user ?? ""));
      if (!user || user.password !== body.password) {
        this._err(res, 403, "M_FORBIDDEN", "Invalid username or password");
        return;
      }
      const token = "tok_" + crypto.randomBytes(12).toString("hex");
      const deviceId = "MOCK_" + crypto.randomBytes(6).toString("hex");
      this.tokens.set(token, { username: user.username, deviceId });
      this._send(res, 200, {
        access_token: token,
        user_id: user.userId,
        device_id: deviceId,
        home_server: "mock.hs",
      });
      return;
    }

    const user = this._authUser(req);
    if (!user) {
      this._err(res, 401, "M_UNKNOWN_TOKEN", "Unrecognised access token");
      return;
    }

    if (req.method === "POST" && route === "logout") {
      const header = String(req.headers["authorization"] ?? "");
      this.tokens.delete(header.replace(/^Bearer /, ""));
      this._send(res, 200, {});
      return;
    }

    if (req.method === "GET" && route === "account/whoami") {
      this._send(res, 200, { user_id: user.userId });
      return;
    }

    /* ---- server-side key backup (m.megolm_backup.v1) ---- */

    if (req.method === "GET" && route === "room_keys/version") {
      const backup = this.keyBackups.get(user.username);
      if (!backup) {
        this._err(res, 404, "M_NOT_FOUND", "Key backup does not exist.");
        return;
      }
      const rooms = this.backedUpKeys.get(user.username) ?? {};
      let count = 0;
      for (const perRoom of Object.values(rooms)) count += Object.keys(perRoom).length;
      this._send(res, 200, { ...backup.body, version: backup.version, count, etag: "1" });
      return;
    }

    if (req.method === "POST" && route === "room_keys/version") {
      if (this.keyBackups.has(user.username)) {
        this._err(res, 400, "M_UNKNOWN", "A backup already exists");
        return;
      }
      if (
        body.algorithm !== "m.megolm_backup.v1.curve25519-aes-sha2" ||
        !body.auth_data
      ) {
        this._err(res, 400, "M_BAD_JSON", "Unsupported backup algorithm");
        return;
      }
      this.keyBackups.set(user.username, { version: "1", body });
      this._send(res, 200, { version: "1" });
      return;
    }

    if (req.method === "GET" && route === "room_keys/keys") {
      const stored = this.backedUpKeys.get(user.username) ?? {};
      /* spec shape: {rooms: {roomId: {sessions: {sessionId: entry}}}} */
      const rooms: Record<string, { sessions: Record<string, unknown> }> = {};
      for (const [roomId, sessions] of Object.entries(stored)) {
        rooms[roomId] = { sessions };
      }
      this._send(res, 200, { rooms });
      return;
    }

    const backupKeyMatch = route.match(/^room_keys\/keys\/([^/]+)\/(.+)$/);
    if (req.method === "PUT" && backupKeyMatch) {
      const rooms = this.backedUpKeys.get(user.username) ?? {};
      this.backedUpKeys.set(user.username, rooms);
      const roomId = backupKeyMatch[1] ?? "";
      /* base64 session ids may contain "/" — everything after the room id */
      const sessionId = backupKeyMatch[2] ?? "";
      rooms[roomId] = rooms[roomId] ?? {};
      rooms[roomId]![sessionId] = body;
      this._send(res, 200, {});
      return;
    }

    if (req.method === "GET" && route.startsWith("profile/")) {
      const userId = route.slice("profile/".length);
      for (const candidate of this.users.values()) {
        if (candidate.userId === userId) {
          this._send(res, 200, { displayname: candidate.displayname });
          return;
        }
      }
      this._err(res, 404, "M_NOT_FOUND", "No profile");
      return;
    }

    if (req.method === "POST" && route === "createRoom") {
      const creation = (body.creation_content ?? {}) as { type?: string };
      const room = this._createRoomInternal(user, {
        name: (body.name as string | undefined) ?? null,
        topic: (body.topic as string | undefined) ?? null,
        isPublic: body.preset === "public_chat",
        isSpace: creation.type === "m.space",
      });
      const initialState =
        (body.initial_state as
          | { type: string; state_key?: string; content?: Record<string, unknown> }[]
          | undefined) ?? [];
      for (const stateInit of initialState) {
        this._appendEvent(
          room,
          stateInit.type,
          user.userId,
          stateInit.content ?? {},
          { state_key: stateInit.state_key ?? "" }
        );
      }
      this._send(res, 200, { room_id: room.id });
      return;
    }

    /* E2EE endpoints */

    if (req.method === "POST" && route === "keys/upload") {
      const deviceKeys = (body.device_keys as Record<string, unknown>) ?? {};
      const deviceId = String(deviceKeys.device_id ?? "");
      if (!deviceId) {
        this._err(res, 400, "M_BAD_JSON", "device_id required");
        return;
      }
      const userDevices = this.devices.get(user.username) ?? new Map<string, MockDevice>();
      const device: MockDevice =
        userDevices.get(deviceId) ?? {
          deviceId,
          deviceKeys: {},
          oneTimeKeys: new Map(),
        };
      device.deviceKeys = deviceKeys;
      const otkMap =
        (body.one_time_keys as Record<string, Record<string, unknown>> | undefined) ?? {};
      for (const [keyId, keyObject] of Object.entries(otkMap)) {
        device.oneTimeKeys.set(keyId, keyObject);
      }
      userDevices.set(deviceId, device);
      this.devices.set(user.username, userDevices);
      const total = [...userDevices.values()].reduce(
        (n, d) => n + d.oneTimeKeys.size,
        0
      );
      this._send(res, 200, { one_time_key_counts: { signed_curve25519: total } });
      return;
    }

    if (req.method === "POST" && route === "keys/query") {
      const requested = (body.device_keys as Record<string, unknown[]>) ?? {};
      const deviceKeys: Record<string, Record<string, unknown>> = {};
      for (const userId of Object.keys(requested)) {
        const username = this._usernameForUserId(userId);
        const userDevices = username ? this.devices.get(username) : undefined;
        if (!userDevices) continue;
        const byDevice: Record<string, unknown> = {};
        for (const device of userDevices.values()) {
          byDevice[device.deviceId] = device.deviceKeys;
        }
        deviceKeys[userId] = byDevice;
      }
      this._send(res, 200, { device_keys: deviceKeys });
      return;
    }

    if (req.method === "POST" && route === "keys/claim") {
      const requested = (body.one_time_keys as Record<string, Record<string, string>>) ?? {};
      const claimed: Record<string, Record<string, Record<string, unknown>>> = {};
      for (const [userId, deviceMap] of Object.entries(requested)) {
        const username = this._usernameForUserId(userId);
        const userDevices = username ? this.devices.get(username) : undefined;
        if (!userDevices) continue;
        for (const deviceId of Object.keys(deviceMap)) {
          const device = userDevices.get(deviceId);
          if (!device || device.oneTimeKeys.size === 0) continue;
          const first = device.oneTimeKeys.entries().next().value as [
            string,
            Record<string, unknown>,
          ];
          device.oneTimeKeys.delete(first[0]);
          if (!claimed[userId]) claimed[userId] = {};
          claimed[userId]![deviceId] = { [first[0]]: first[1] };
        }
      }
      this._send(res, 200, { one_time_keys: claimed });
      return;
    }

    const sendToDeviceMatch = route.match(/^sendToDevice\/([^/]+)\/([^/]+)$/);
    if (req.method === "PUT" && sendToDeviceMatch) {
      const type = sendToDeviceMatch[1]!;
      const messages = (body.messages as Record<string, Record<string, unknown>>) ?? {};
      for (const [userId, deviceMap] of Object.entries(messages)) {
        const username = this._usernameForUserId(userId);
        if (!username) continue;
        const byDevice = this.toDeviceQueue.get(username) ?? new Map();
        this.toDeviceQueue.set(username, byDevice);
        for (const [targetDeviceId, content] of Object.entries(deviceMap)) {
          const queue = byDevice.get(targetDeviceId) ?? [];
          queue.push({
            seq: ++this._seq,
            event: { type, sender: user.userId, content },
          });
          byDevice.set(targetDeviceId, queue);
        }
      }
      this._send(res, 200, {});
      return;
    }

    if (req.method === "POST" && route.startsWith("join/")) {
      const room = this.rooms.get(route.slice("join/".length));
      if (!room) {
        this._err(res, 404, "M_NOT_FOUND", "Unknown room");
        return;
      }
      const membership = room.members.get(user.userId);
      if (!membership && room.joinRule !== "public") {
        this._err(res, 403, "M_FORBIDDEN", "Not invited");
        return;
      }
      this._appendEvent(
        room,
        "m.room.member",
        user.userId,
        { membership: "join", displayname: user.displayname },
        { state_key: user.userId }
      );
      this._send(res, 200, { room_id: room.id });
      return;
    }

    const sendMatch = route.match(/^rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/);
    if (req.method === "PUT" && sendMatch) {
      const room = this.rooms.get(sendMatch[1] ?? "");
      if (!room) {
        this._err(res, 404, "M_NOT_FOUND", "Unknown room");
        return;
      }
      if (room.members.get(user.userId) !== "join") {
        this._err(res, 403, "M_FORBIDDEN", "Not in room");
        return;
      }
      const ev = this._appendEvent(
        room,
        sendMatch[2] ?? "m.room.message",
        user.userId,
        body
      );
      this._send(res, 200, { event_id: ev.event_id });
      return;
    }

    const inviteMatch = route.match(/^rooms\/([^/]+)\/invite$/);
    if (req.method === "POST" && inviteMatch) {
      const room = this.rooms.get(inviteMatch[1] ?? "");
      if (!room) {
        this._err(res, 404, "M_NOT_FOUND", "Unknown room");
        return;
      }
      if (room.members.get(user.userId) !== "join") {
        this._err(res, 403, "M_FORBIDDEN", "Not in room");
        return;
      }
      if (typeof body.user_id !== "string") {
        this._err(res, 400, "M_BAD_JSON", "user_id required");
        return;
      }
      this._appendEvent(
        room,
        "m.room.member",
        user.userId,
        { membership: "invite" },
        { state_key: body.user_id }
      );
      this._send(res, 200, {});
      return;
    }

    const leaveMatch = route.match(/^rooms\/([^/]+)\/leave$/);
    if (req.method === "POST" && leaveMatch) {
      const room = this.rooms.get(leaveMatch[1] ?? "");
      if (!room) {
        this._err(res, 404, "M_NOT_FOUND", "Unknown room");
        return;
      }
      const membership = room.members.get(user.userId);
      if (membership !== "join" && membership !== "invite") {
        this._err(res, 403, "M_FORBIDDEN", "Not in room");
        return;
      }
      this._appendEvent(
        room,
        "m.room.member",
        user.userId,
        { membership: "leave" },
        { state_key: user.userId }
      );
      this._send(res, 200, {});
      return;
    }

    /* GET room state (e.g. the m.room.encryption probe in joinRoom) */
    const getStateMatch = route.match(/^rooms\/([^/]+)\/state\/([^/]+)(?:\/(.*))?$/);
    if (req.method === "GET" && getStateMatch) {
      const room = this.rooms.get(getStateMatch[1] ?? "");
      if (!room) {
        this._err(res, 404, "M_NOT_FOUND", "Unknown room");
        return;
      }
      const type = getStateMatch[2] ?? "";
      const stateKey = getStateMatch[3] ?? "";
      const found = [...room.events]
        .reverse()
        .find((event) => event.type === type && (event.state_key ?? "") === stateKey);
      if (found) {
        this._send(res, 200, found.content);
      } else {
        this._err(res, 404, "M_NOT_FOUND", "State event not found");
      }
      return;
    }

    /* generic state event send (e.g. m.call.member, com.grungus.livekit) */
    const stateMatch = route.match(/^rooms\/([^/]+)\/state\/([^/]+)(?:\/(.*))?$/);
    if (req.method === "PUT" && stateMatch) {
      const room = this.rooms.get(stateMatch[1] ?? "");
      if (!room) {
        this._err(res, 404, "M_NOT_FOUND", "Unknown room");
        return;
      }
      if (room.members.get(user.userId) !== "join") {
        this._err(res, 403, "M_FORBIDDEN", "Not in room");
        return;
      }
      const stateKey = stateMatch[3] ?? "";
      const ev = this._appendEvent(
        room,
        stateMatch[2] ?? "",
        user.userId,
        body,
        { state_key: stateKey }
      );
      this._send(res, 200, { event_id: ev.event_id });
      return;
    }

    /* media download/thumbnail (authenticated) — mock serves the raw bytes */
    const downloadMatch = route.match(/^(?:media\/v3\/)?(?:download|thumbnail)\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && downloadMatch) {
      const item = this.media.get(decodeURIComponent(downloadMatch[2] ?? ""));
      if (!item) {
        this._err(res, 404, "M_NOT_FOUND", "Unknown media");
        return;
      }
      this._sendBytes(res, 200, item.mime, item.bytes);
      return;
    }

    /* typing notifications */
    const typingMatch = route.match(/^rooms\/([^/]+)\/typing\/(.+)$/);
    if (req.method === "PUT" && typingMatch) {
      const room = this.rooms.get(typingMatch[1] ?? "");
      if (!room) {
        this._err(res, 404, "M_NOT_FOUND", "Unknown room");
        return;
      }
      const typingUserId = decodeURIComponent(typingMatch[2] ?? "");
      const active = body.typing === true;
      if (active) {
        room.typingUntil.set(typingUserId, Date.now() + Number(body.timeout ?? 30000));
      } else {
        room.typingUntil.delete(typingUserId);
      }
      room.typingSeq = ++this._seq; /* wake long-polls */
      this._send(res, 200, {});
      return;
    }

    if (req.method === "GET" && route === "sync") {
      const context = this._authContext(req);
      if (context) {
        this._handleSync(res, context.user, context.deviceId, query);
      } else {
        this._err(res, 401, "M_UNKNOWN_TOKEN", "Unrecognised access token");
      }
      return;
    }

    this._err(res, 404, "M_UNRECOGNIZED", `Unknown endpoint: ${route}`);
  }

  private _usernameForUserId(userId: string): string | null {
    for (const candidate of this.users.values()) {
      if (candidate.userId === userId) return candidate.username;
    }
    return null;
  }

  /* ------------------------------- sync ------------------------------- */

  private _joinedRooms(user: MockUser): MockRoom[] {
    const out: MockRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.members.get(user.userId) === "join") out.push(room);
    }
    return out;
  }

  private _invitedRooms(user: MockUser): MockRoom[] {
    const out: MockRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.members.get(user.userId) === "invite") out.push(room);
    }
    return out;
  }

  /** username -> room ids already delivered by a sync (first delivery includes full state). */
  private readonly _syncedRooms = new Map<string, Set<string>>();

  private _hasNew(
    user: MockUser,
    deviceId: string,
    sinceNum: number
  ): boolean {
    const deviceQueue = this.toDeviceQueue.get(user.username)?.get(deviceId) ?? [];
    if (deviceQueue.some((entry) => entry.seq > sinceNum)) return true;
    return (
      this._invitedRooms(user).some((room) =>
        room.events.some((event) => event.seq > sinceNum)
      ) ||
      this._joinedRooms(user).some(
        (room) =>
          room.typingSeq > sinceNum ||
          room.events.some((event) => event.seq > sinceNum)
      )
    );
  }

  private _handleSync(
    res: http.ServerResponse,
    user: MockUser,
    deviceId: string,
    query: URLSearchParams
  ): void {
    const since = query.get("since");
    const timeout = Number(query.get("timeout") ?? "0");
    const sinceNum = since ? Number(since) : null;

    if (!since || (sinceNum !== null && this._hasNew(user, deviceId, sinceNum))) {
      this._send(res, 200, this._buildSync(user, deviceId, sinceNum));
      return;
    }
    if (!timeout) {
      this._send(res, 200, this._buildSync(user, deviceId, sinceNum));
      return;
    }

    /* long-poll: poll internally until new events or deadline */
    const deadline = Date.now() + Math.min(timeout, 30_000);
    const poll = (): void => {
      if (this._closed) return; /* server closed under us */
      if (
        (sinceNum !== null && this._hasNew(user, deviceId, sinceNum)) ||
        Date.now() >= deadline
      ) {
        this._send(res, 200, this._buildSync(user, deviceId, sinceNum));
      } else {
        setTimeout(poll, 20);
      }
    };
    poll();
  }

  private _buildSync(
    user: MockUser,
    deviceId: string,
    sinceNum: number | null
  ): Record<string, unknown> {
    const join: Record<string, unknown> = {};
    for (const room of this._joinedRooms(user)) {
      /* Real servers deliver a newly-joined room's full state in the first
         sync it appears in — otherwise clients miss e.g. m.room.encryption
         and silently drop encrypted events. Mirror that here. */
      const seen = this._syncedRooms.get(user.username) ?? new Set<string>();
      this._syncedRooms.set(user.username, seen);
      const firstSync = !seen.has(room.id);
      if (firstSync) seen.add(room.id);

      const isState = (event: MockEvent) => event.state_key !== undefined;
      const stateEvents =
        sinceNum === null || firstSync ? room.events.filter(isState) : [];
      const timelineEvents =
        sinceNum === null || firstSync
          ? room.events.filter((event) => !isState(event))
          : room.events.filter((event) => event.seq > sinceNum);
      const joinedCount = [...room.members.values()].filter(
        (membership) => membership === "join"
      ).length;
      const typingNow = [...room.typingUntil.entries()]
        .filter(([, until]) => until > Date.now())
        .map(([userId]) => userId);
      const joinEntry: Record<string, unknown> = {
        state: { events: stateEvents },
        timeline: { events: timelineEvents },
        summary: {
          "m.joined_member_count": joinedCount,
          "m.invited_member_count": 0,
        },
      };
      if (room.typingSeq > 0) {
        joinEntry.ephemeral = {
          events: [
            {
              type: "m.typing",
              sender: "@mock:hs",
              content: { user_ids: typingNow },
            },
          ],
        };
      }
      join[room.id] = joinEntry;
    }

    /* to-device: deliver THIS device's queued events (initial sync delivers all). */
    const deviceQueue =
      this.toDeviceQueue.get(user.username)?.get(deviceId) ?? [];
    let delivered: { seq: number; event: Record<string, unknown> }[];
    if (sinceNum === null) {
      delivered = deviceQueue.splice(0, deviceQueue.length);
    } else {
      delivered = deviceQueue.filter((entry) => entry.seq > sinceNum);
      const remaining = deviceQueue.filter((entry) => entry.seq <= sinceNum);
      this.toDeviceQueue.get(user.username)?.set(deviceId, remaining);
    }

    /* rooms.invite: stripped state for rooms the user is invited to */
    const invite: Record<string, unknown> = {};
    for (const room of this._invitedRooms(user)) {
      const stripped = room.events
        .filter((event) => event.state_key !== undefined)
        .map((event) => ({
          type: event.type,
          state_key: event.state_key,
          sender: event.sender,
          content: event.content,
        }));
      invite[room.id] = { invite_state: { events: stripped } };
    }

    const userDevices = this.devices.get(user.username);
    const myOtks = userDevices?.get(deviceId)?.oneTimeKeys.size ?? 0;

    return {
      next_batch: String(this._seq),
      rooms: { join, invite },
      to_device: { events: delivered.map((entry) => entry.event) },
      device_one_time_keys_count: { signed_curve25519: myOtks },
    };
  }
}
