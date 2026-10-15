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
}

interface CreateRoomOptions {
  name: string | null;
  topic: string | null;
  isPublic: boolean;
  isSpace: boolean;
}

export class MockHomeserver {
  readonly users = new Map<string, MockUser>();
  readonly tokens = new Map<string, string>(); /* token -> username */
  readonly rooms = new Map<string, MockRoom>();
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

  close(): Promise<void> {
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
    this._readBody(req)
      .then((body) => this._route(req, res, body))
      .catch((err: unknown) => {
        this._send(res, 500, {
          errcode: "M_UNKNOWN",
          error: String(err),
        });
      });
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

  private _authUser(req: http.IncomingMessage): MockUser | null {
    const header = req.headers["authorization"] ?? "";
    const token = String(header).replace(/^Bearer /, "");
    const username = this.tokens.get(token);
    return username ? (this.users.get(username) ?? null) : null;
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

    if (parts[0] !== "_matrix" || parts[1] !== "client" || parts[2] !== "v3") {
      this._err(res, 404, "M_UNRECOGNIZED", "Unknown endpoint");
      return;
    }
    const route = parts.slice(3).join("/");

    /* POST /login (no auth) */
    if (req.method === "POST" && route === "login") {
      const identifier = (body.identifier ?? {}) as { user?: string };
      const user = this.users.get(String(identifier.user ?? ""));
      if (!user || user.password !== body.password) {
        this._err(res, 403, "M_FORBIDDEN", "Invalid username or password");
        return;
      }
      const token = "tok_" + crypto.randomBytes(12).toString("hex");
      this.tokens.set(token, user.username);
      this._send(res, 200, {
        access_token: token,
        user_id: user.userId,
        device_id: "MOCKDEVICE",
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
      this._send(res, 200, { room_id: room.id });
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

    if (req.method === "GET" && route === "sync") {
      this._handleSync(res, user, query);
      return;
    }

    this._err(res, 404, "M_UNRECOGNIZED", `Unknown endpoint: ${route}`);
  }

  /* ------------------------------- sync ------------------------------- */

  private _joinedRooms(user: MockUser): MockRoom[] {
    const out: MockRoom[] = [];
    for (const room of this.rooms.values()) {
      if (room.members.get(user.userId) === "join") out.push(room);
    }
    return out;
  }

  private _hasNew(user: MockUser, sinceNum: number): boolean {
    return this._joinedRooms(user).some((room) =>
      room.events.some((event) => event.seq > sinceNum)
    );
  }

  private _handleSync(
    res: http.ServerResponse,
    user: MockUser,
    query: URLSearchParams
  ): void {
    const since = query.get("since");
    const timeout = Number(query.get("timeout") ?? "0");
    const sinceNum = since ? Number(since) : null;

    if (!since || (sinceNum !== null && this._hasNew(user, sinceNum))) {
      this._send(res, 200, this._buildSync(user, sinceNum));
      return;
    }
    if (!timeout) {
      this._send(res, 200, this._buildSync(user, sinceNum));
      return;
    }

    /* long-poll: poll internally until new events or deadline */
    const deadline = Date.now() + Math.min(timeout, 30_000);
    const poll = (): void => {
      if ((sinceNum !== null && this._hasNew(user, sinceNum)) || Date.now() >= deadline) {
        this._send(res, 200, this._buildSync(user, sinceNum));
      } else {
        setTimeout(poll, 20);
      }
    };
    poll();
  }

  private _buildSync(user: MockUser, sinceNum: number | null): Record<string, unknown> {
    const join: Record<string, unknown> = {};
    for (const room of this._joinedRooms(user)) {
      const isState = (event: MockEvent) => event.state_key !== undefined;
      const stateEvents =
        sinceNum === null ? room.events.filter(isState) : [];
      const timelineEvents =
        sinceNum === null
          ? room.events.filter((event) => !isState(event))
          : room.events.filter((event) => event.seq > sinceNum);
      const joinedCount = [...room.members.values()].filter(
        (membership) => membership === "join"
      ).length;
      join[room.id] = {
        state: { events: stateEvents },
        timeline: { events: timelineEvents },
        summary: {
          "m.joined_member_count": joinedCount,
          "m.invited_member_count": 0,
        },
      };
    }
    return { next_batch: String(this._seq), rooms: { join } };
  }
}
