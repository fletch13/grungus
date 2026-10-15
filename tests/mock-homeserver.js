/*
 * Grungus — in-process mock Matrix homeserver for the test suite.
 *
 * Implements just enough of the Matrix Client-Server API to exercise the
 * real MatrixClient over HTTP: password login, whoami, profile, logout,
 * createRoom, join, invite, message send, and /sync (initial + long-poll).
 * Not spec-complete — it exists so `npm test` runs fast and deterministic
 * without any infrastructure. For testing against a real homeserver see
 * tests/e2e-real-homeserver.js.
 */
"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

class MockHomeserver {
  constructor() {
    this.users = new Map(); /* username -> { username, password, userId, displayname } */
    this.tokens = new Map(); /* token -> username */
    this.rooms = new Map(); /* roomId -> room record */
    this.baseUrl = null;
    this.port = null;
    this.server = null;
    this._seq = 0;
    this._eventCounter = 0;
    this._roomCounter = 0;
  }

  listen(host = "127.0.0.1") {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this._handleRequest(req, res));
      this.server.listen(0, host, () => {
        const addr = this.server.address();
        this.baseUrl = `http://${addr.address}:${addr.port}`;
        this.port = addr.port;
        resolve({ baseUrl: this.baseUrl, port: this.port });
      });
    });
  }

  close() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      if (typeof this.server.closeAllConnections === "function") {
        this.server.closeAllConnections();
      }
      this.server.close(() => resolve());
    });
  }

  registerUser(username, password) {
    const userId = `@${username}:mock.hs`;
    this.users.set(username, {
      username,
      password,
      userId,
      displayname: username,
    });
    return userId;
  }

  /** Mock-only helper: attach a room to a space (m.space.child state event). */
  addSpaceChild(spaceRoomId, childRoomId) {
    const room = this.rooms.get(spaceRoomId);
    if (!room) throw new Error("addSpaceChild: unknown space room");
    this._appendEvent(room, "m.space.child", room.creator, { via: ["mock.hs"] }, {
      state_key: childRoomId,
    });
  }

  /* ----------------------------- events ----------------------------- */

  _appendEvent(room, type, sender, content, extra) {
    extra = extra || {};
    const ev = {
      event_id: "$e" + ++this._eventCounter,
      type,
      sender,
      content,
      origin_server_ts: Date.now(),
      seq: ++this._seq,
    };
    if (extra.state_key !== undefined) ev.state_key = extra.state_key;
    room.events.push(ev);

    /* mock-side bookkeeping for routing (join checks etc.) */
    if (ev.type === "m.room.member") {
      room.members.set(ev.state_key, ev.content.membership || "leave");
    } else if (ev.type === "m.room.join_rules") {
      room.joinRule = ev.content.join_rule || "invite";
    } else if (ev.type === "m.room.create") {
      room.isSpace = ev.content.type === "m.space";
    }
    return ev;
  }

  _createRoomInternal(creator, opts) {
    const roomId = "!r" + ++this._roomCounter + ":mock.hs";
    const room = {
      id: roomId,
      name: opts.name || null,
      topic: opts.topic || null,
      creator: creator.userId,
      joinRule: opts.isPublic ? "public" : "invite",
      isSpace: !!opts.isSpace,
      members: new Map(),
      events: [],
    };
    this.rooms.set(roomId, room);

    const createContent = { creator: creator.userId };
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

  /* ------------------------------ HTTP ------------------------------ */

  _handleRequest(req, res) {
    if (req.method === "OPTIONS") {
      this._send(res, 204, null);
      return;
    }

    const readBody = () =>
      new Promise((resolve) => {
        if (req.method !== "POST" && req.method !== "PUT") return resolve({});
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch {
            resolve({});
          }
        });
      });

    readBody()
      .then((body) => this._route(req, res, body))
      .catch((err) => {
        this._send(res, 500, { errcode: "M_UNKNOWN", error: String(err) });
      });
  }

  _send(res, status, payload) {
    const data = status === 204 ? "" : JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
    });
    res.end(data);
  }

  _err(res, status, errcode, error) {
    this._send(res, status, { errcode, error });
  }

  _authUser(req) {
    const header = req.headers["authorization"] || "";
    const token = header.replace(/^Bearer /, "");
    const username = this.tokens.get(token);
    return username ? this.users.get(username) : null;
  }

  _route(req, res, body) {
    const url = new URL(req.url, "http://mock.hs");
    const parts = decodeURIComponent(url.pathname)
      .split("/")
      .filter(Boolean);
    const query = url.searchParams;

    if (req.method === "GET" && parts.join("/") === "_matrix/client/versions") {
      return this._send(res, 200, { versions: ["v1.11.0"] });
    }

    if (parts[0] !== "_matrix" || parts[1] !== "client" || parts[2] !== "v3") {
      return this._err(res, 404, "M_UNRECOGNIZED", "Unknown endpoint");
    }
    const route = parts.slice(3).join("/");

    /* POST /login (no auth) */
    if (req.method === "POST" && route === "login") {
      const identifier = (body && body.identifier) || {};
      const rec = this.users.get(String(identifier.user || ""));
      if (!rec || rec.password !== (body && body.password)) {
        return this._err(res, 403, "M_FORBIDDEN", "Invalid username or password");
      }
      const token = "tok_" + crypto.randomBytes(12).toString("hex");
      this.tokens.set(token, rec.username);
      return this._send(res, 200, {
        access_token: token,
        user_id: rec.userId,
        device_id: "MOCKDEVICE",
        home_server: "mock.hs",
      });
    }

    const user = this._authUser(req);
    if (!user) {
      return this._err(res, 401, "M_UNKNOWN_TOKEN", "Unrecognised access token");
    }

    if (req.method === "POST" && route === "logout") {
      const token = (req.headers["authorization"] || "").replace(/^Bearer /, "");
      this.tokens.delete(token);
      return this._send(res, 200, {});
    }

    if (req.method === "GET" && route === "account/whoami") {
      return this._send(res, 200, { user_id: user.userId });
    }

    if (req.method === "GET" && route.startsWith("profile/")) {
      const userId = route.slice("profile/".length);
      for (const rec of this.users.values()) {
        if (rec.userId === userId) {
          return this._send(res, 200, { displayname: rec.displayname });
        }
      }
      return this._err(res, 404, "M_NOT_FOUND", "No profile");
    }

    if (req.method === "POST" && route === "createRoom") {
      const room = this._createRoomInternal(user, {
        name: (body && body.name) || null,
        topic: (body && body.topic) || null,
        isPublic: (body && body.preset) === "public_chat",
        isSpace: !!(
          body &&
          body.creation_content &&
          body.creation_content.type === "m.space"
        ),
      });
      return this._send(res, 200, { room_id: room.id });
    }

    if (req.method === "POST" && route.startsWith("join/")) {
      const room = this.rooms.get(route.slice("join/".length));
      if (!room) return this._err(res, 404, "M_NOT_FOUND", "Unknown room");
      const membership = room.members.get(user.userId);
      if (!membership && room.joinRule !== "public") {
        return this._err(res, 403, "M_FORBIDDEN", "Not invited");
      }
      this._appendEvent(
        room,
        "m.room.member",
        user.userId,
        { membership: "join", displayname: user.displayname },
        { state_key: user.userId }
      );
      return this._send(res, 200, { room_id: room.id });
    }

    const sendMatch = route.match(/^rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/);
    if (req.method === "PUT" && sendMatch) {
      const room = this.rooms.get(sendMatch[1]);
      if (!room) return this._err(res, 404, "M_NOT_FOUND", "Unknown room");
      if (room.members.get(user.userId) !== "join") {
        return this._err(res, 403, "M_FORBIDDEN", "Not in room");
      }
      const ev = this._appendEvent(room, sendMatch[2], user.userId, body || {});
      return this._send(res, 200, { event_id: ev.event_id });
    }

    const inviteMatch = route.match(/^rooms\/([^/]+)\/invite$/);
    if (req.method === "POST" && inviteMatch) {
      const room = this.rooms.get(inviteMatch[1]);
      if (!room) return this._err(res, 404, "M_NOT_FOUND", "Unknown room");
      if (room.members.get(user.userId) !== "join") {
        return this._err(res, 403, "M_FORBIDDEN", "Not in room");
      }
      if (!body || !body.user_id) {
        return this._err(res, 400, "M_BAD_JSON", "user_id required");
      }
      this._appendEvent(
        room,
        "m.room.member",
        user.userId,
        { membership: "invite" },
        { state_key: body.user_id }
      );
      return this._send(res, 200, {});
    }

    if (req.method === "GET" && route === "sync") {
      return this._handleSync(res, user, query);
    }

    return this._err(res, 404, "M_UNRECOGNIZED", "Unknown endpoint: " + route);
  }

  /* ------------------------------ sync ------------------------------ */

  _joinedRooms(user) {
    const out = [];
    for (const room of this.rooms.values()) {
      if (room.members.get(user.userId) === "join") out.push(room);
    }
    return out;
  }

  _hasNew(user, sinceNum) {
    return this._joinedRooms(user).some((room) =>
      room.events.some((e) => e.seq > sinceNum)
    );
  }

  _handleSync(res, user, query) {
    const since = query.get("since");
    const timeout = Number(query.get("timeout") || 0);
    const sinceNum = since ? Number(since) : null;

    if (!since || this._hasNew(user, sinceNum)) {
      return this._send(res, 200, this._buildSync(user, sinceNum));
    }
    if (!timeout) {
      return this._send(res, 200, this._buildSync(user, sinceNum));
    }

    /* long-poll: poll internally until new events or deadline */
    const deadline = Date.now() + Math.min(timeout, 30000);
    const poll = () => {
      if (this._hasNew(user, sinceNum) || Date.now() >= deadline) {
        this._send(res, 200, this._buildSync(user, sinceNum));
      } else {
        setTimeout(poll, 20);
      }
    };
    poll();
  }

  _buildSync(user, sinceNum) {
    const join = {};
    for (const room of this._joinedRooms(user)) {
      const isState = (e) => e.state_key !== undefined;
      const stateEvents = sinceNum == null ? room.events.filter(isState) : [];
      const timelineEvents =
        sinceNum == null
          ? room.events.filter((e) => !isState(e))
          : room.events.filter((e) => e.seq > sinceNum);
      const joinedCount = Array.from(room.members.values()).filter(
        (m) => m === "join"
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

module.exports = { MockHomeserver };
