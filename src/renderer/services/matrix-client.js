/*
 * Grungus — Matrix client core.
 *
 * A dependency-free implementation of the subset of the Matrix
 * Client-Server API that Grungus uses (the same open protocol Element
 * speaks): homeserver discovery, password/token login, /sync long-polling,
 * room state + timeline handling, message send with local echo, room
 * creation/join/invite, profiles, media thumbnails, and logout.
 *
 * UMD-ish: usable as a classic <script> (exposes window.MatrixClient) and
 * from Node for tests (module.exports). Written against Matrix spec v1.x
 * (Client-Server API r0.6+ / v3 paths).
 */
(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = { MatrixClient: factory() };
  } else {
    root.MatrixClient = factory();
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function () {
    "use strict";

    var CLIENT_PREFIX = "/_matrix/client/v3";
    var SYNC_TIMEOUT_MS = 30000;
    var MAX_BACKOFF_MS = 60000;

    /* ------------------------------ helpers ------------------------------ */

    function sleep(ms) {
      return new Promise(function (resolve) {
        setTimeout(resolve, ms);
      });
    }

    function mxidLocalpart(mxid) {
      if (typeof mxid !== "string" || mxid.charAt(0) !== "@") return String(mxid || "");
      return mxid.slice(1).split(":")[0];
    }

    function isLocalHost(host) {
      return (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host === "[::1]" ||
        host.indexOf(".") === -1 && host.indexOf(":") >= 0 ||
        host.slice(-6) === ".local"
      );
    }

    function HttpError(status, body) {
      var msg =
        (body && (body.error || body.errcode)) ||
        "HTTP " + status + " from homeserver";
      var err = new Error(msg);
      err.name = "HttpError";
      err.status = status;
      err.body = body || null;
      err.errcode = (body && body.errcode) || null;
      return err;
    }

    function Emitter() {
      this._listeners = new Map();
    }

    Emitter.prototype.on = function (event, cb) {
      var _this = this;
      if (!this._listeners.has(event)) this._listeners.set(event, new Set());
      this._listeners.get(event).add(cb);
      return function () {
        _this.off(event, cb);
      };
    };

    Emitter.prototype.off = function (event, cb) {
      var set = this._listeners.get(event);
      if (set) set.delete(cb);
    };

    Emitter.prototype.emit = function (event) {
      var args = Array.prototype.slice.call(arguments, 1);
      var set = this._listeners.get(event);
      if (!set) return;
      var snapshot = Array.from(set);
      for (var i = 0; i < snapshot.length; i++) {
        try {
          snapshot[i].apply(null, args);
        } catch (e) {
          /* listener errors must not break the sync loop */
          if (typeof console !== "undefined") console.error(e);
        }
      }
    };

    /* --------------------------- MatrixClient --------------------------- */

    function MatrixClient(options) {
      Emitter.call(this);
      options = options || {};
      if (!options.baseUrl) throw new Error("MatrixClient requires baseUrl");
      this.baseUrl = String(options.baseUrl).replace(/\/+$/, "");
      this.accessToken = options.accessToken || null;
      this.userId = options.userId || null;
      this.deviceId = null;
      this.homeserverDomain = null;

      /* roomId -> room object (see _ensureRoom) */
      this.rooms = new Map();
      this.connectionState = "connecting";

      this._since = null;
      this._seen = new Set(); /* event_id */
      this._acked = new Map(); /* event_id -> txnId of local echo */
      this._txnCounter = 0;
      this._syncRunning = false;
      this._stopped = true;
      this._syncAbort = null;
      this._backoffMs = 0;
      this._readyEmitted = false;
      this._selectedRoomId = null;
      this._avatarCache = new Map(); /* mxc -> Promise<url|null> */
    }

    MatrixClient.prototype = Object.create(Emitter.prototype);
    MatrixClient.prototype.constructor = MatrixClient;

    /* --------------------------- URL discovery -------------------------- */

    /**
     * Turn user input ("matrix.org", "https://hs.example.com",
     * "127.0.0.1:8008") into a base URL. Uses .well-known/matrix/client
     * delegation like Element does; falls back to the origin itself.
     */
    MatrixClient.resolveBaseUrl = function (input) {
      var raw = String(input == null ? "" : input).trim().replace(/\/+$/, "");
      if (!raw) return Promise.reject(new Error("Empty homeserver address"));

      var url;
      if (/^https?:\/\//i.test(raw)) {
        try {
          url = new URL(raw);
        } catch (e) {
          return Promise.reject(new Error("Invalid homeserver address: " + input));
        }
        return Promise.resolve(url.origin);
      }

      var isLocal = false;
      try {
        var probe = new URL("https://" + raw);
        isLocal = isLocalHost(probe.hostname);
      } catch (e) {
        return Promise.reject(new Error("Invalid homeserver address: " + input));
      }
      var scheme = isLocal ? "http" : "https";
      url = new URL(scheme + "://" + raw);
      var origin = url.origin;

      /* Try .well-known delegation, then fall back to the origin. */
      return fetch(new URL("/.well-known/matrix/client", origin), {
        signal: (function () {
          var ctrl = new AbortController();
          setTimeout(function () {
            ctrl.abort();
          }, 5000);
          return ctrl.signal;
        })(),
      })
        .then(function (res) {
          return res.ok ? res.json() : null;
        })
        .then(function (wk) {
          var b = wk && wk["m.homeserver"] && wk["m.homeserver"].base_url;
          if (b && /^https?:\/\//i.test(b)) {
            return b.replace(/\/+$/, "");
          }
          return origin;
        })
        .catch(function () {
          return origin;
        });
    };

    MatrixClient.prototype.versions = function () {
      return this._api("GET", "/_matrix/client/versions", { auth: false });
    };

    /* ------------------------------ HTTP ------------------------------- */

    MatrixClient.prototype._api = function (method, path, opts) {
      var _this = this;
      opts = opts || {};
      var body = opts.body;
      var auth = opts.auth !== false;
      var timeoutMs = opts.timeoutMs == null ? 35000 : opts.timeoutMs;
      var extSignal = opts.signal;

      var url = new URL(this.baseUrl + path);
      if (opts.query) {
        for (var key in opts.query) {
          var v = opts.query[key];
          if (v !== undefined && v !== null) {
            url.searchParams.set(key, String(v));
          }
        }
      }

      var headers = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (auth && this.accessToken) {
        headers["Authorization"] = "Bearer " + this.accessToken;
      }

      var ctrl = new AbortController();
      var timer = null;
      if (timeoutMs) {
        timer = setTimeout(function () {
          ctrl.abort();
        }, timeoutMs);
      }
      var onExternalAbort = function () {
        ctrl.abort();
      };
      if (extSignal) {
        if (extSignal.aborted) ctrl.abort();
        else extSignal.addEventListener("abort", onExternalAbort, { once: true });
      }

      return fetch(url.toString(), {
        method: method,
        headers: headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
        .then(function (res) {
          return res.text().then(function (text) {
            var data = null;
            if (text) {
              try {
                data = JSON.parse(text);
              } catch (e) {
                data = { raw: text };
              }
            }
            if (!res.ok) throw HttpError(res.status, data);
            return data;
          });
        })
        .finally(function () {
          if (timer) clearTimeout(timer);
          if (extSignal) extSignal.removeEventListener("abort", onExternalAbort);
        });
    };

    /* ---------------------------- auth flows ---------------------------- */

    MatrixClient.prototype.loginWithPassword = function (credentials) {
      var _this = this;
      var username = String((credentials && credentials.username) || "").trim();
      var password = (credentials && credentials.password) || "";
      if (!username || !password) {
        return Promise.reject(new Error("Username and password are required"));
      }
      return this._api("POST", CLIENT_PREFIX + "/login", {
        auth: false,
        body: {
          type: "m.login.password",
          identifier: { type: "m.id.user", user: username },
          password: password,
          initial_device_display_name: "Grungus",
        },
      }).then(function (res) {
        if (!res || !res.access_token) throw new Error("Homeserver returned no access token");
        _this.accessToken = res.access_token;
        _this.userId = res.user_id;
        _this.deviceId = res.device_id || null;
        _this.homeserverDomain = res.home_server || null;
        return res;
      });
    };

    /** Validate an access token; resolves {userId} or throws. */
    MatrixClient.prototype.whoami = function () {
      var _this = this;
      return this._api("GET", CLIENT_PREFIX + "/account/whoami", {}).then(function (res) {
        if (!res || !res.user_id) throw new Error("whoami returned no user_id");
        _this.userId = res.user_id;
        return res;
      });
    };

    MatrixClient.prototype.getProfile = function (userId) {
      return this._api(
        "GET",
        CLIENT_PREFIX + "/profile/" + encodeURIComponent(userId),
        { auth: false }
      );
    };

    MatrixClient.prototype.logout = function () {
      var _this = this;
      this.stopSync();
      return this._api("POST", CLIENT_PREFIX + "/logout", { body: {} })
        .catch(function () {
          /* best effort — the token is being discarded anyway */
        })
        .then(function () {
          _this.accessToken = null;
          _this._since = null;
        });
    };

    /* ------------------------------- sync ------------------------------- */

    MatrixClient.prototype.startSync = function () {
      var _this = this;
      if (this._syncRunning) return this;
      this._syncRunning = true;
      this._stopped = false;
      this.connectionState = "connecting";
      this.emit("connection", this.connectionState);

      var loop = function () {
        var step = function () {
          if (_this._stopped) {
            _this._syncRunning = false;
            return Promise.resolve();
          }
          var ctrl = (_this._syncAbort = new AbortController());
          var query = { timeout: SYNC_TIMEOUT_MS };
          if (_this._since) query.since = _this._since;
          return _this
            ._api("GET", CLIENT_PREFIX + "/sync", {
              query: query,
              timeoutMs: SYNC_TIMEOUT_MS + 20000,
              signal: ctrl.signal,
            })
            .then(function (data) {
              if (_this._stopped) {
                _this._syncRunning = false;
                return;
              }
              _this._backoffMs = 0;
              _this.connectionState = "online";
              _this.emit("connection", "online");
              _this._since = (data && data.next_batch) || _this._since;
              _this._applySync(data || {});
              if (!_this._readyEmitted) {
                _this._readyEmitted = true;
                _this.emit("ready");
              }
              return step();
            })
            .catch(function (err) {
              if (_this._stopped) {
                _this._syncRunning = false;
                return;
              }
              if (err && err.status === 401) {
                _this._stopped = true;
                _this._syncRunning = false;
                _this.connectionState = "auth-error";
                _this.emit("auth-error", err);
                return;
              }
              _this.connectionState = "offline";
              _this.emit("connection", "offline");
              _this.emit("error", err);
              _this._backoffMs = Math.min(
                _this._backoffMs ? _this._backoffMs * 2 : 2000,
                MAX_BACKOFF_MS
              );
              return sleep(_this._backoffMs).then(step);
            });
        };
        return step();
      };
      loop();
      return this;
    };

    MatrixClient.prototype.stopSync = function () {
      this._stopped = true;
      if (this._syncAbort) this._syncAbort.abort();
      this.connectionState = "stopped";
    };

    /* --------------------------- sync processing ------------------------ */

    MatrixClient.prototype._ensureRoom = function (roomId) {
      var room = this.rooms.get(roomId);
      if (!room) {
        room = {
          id: roomId,
          name: null,
          canonicalAlias: null,
          topic: null,
          avatarMxc: null,
          isSpace: false,
          creator: null,
          joinRule: null,
          children: new Set(),
          members: new Map(),
          timeline: [],
          joinedCount: 0,
          invitedCount: 0,
          serverNotifications: 0,
          unread: 0,
          lastActivityTs: 0,
          title: roomId,
          isDirect: false,
          directUserId: null,
        };
        this.rooms.set(roomId, room);
      }
      return room;
    };

    MatrixClient.prototype._applyStateEvent = function (room, ev) {
      if (!ev || !ev.type) return;
      var content = ev.content || {};
      switch (ev.type) {
        case "m.room.create":
          room.isSpace = content.type === "m.space";
          room.creator = ev.sender || null;
          break;
        case "m.room.name":
          room.name = typeof content.name === "string" ? content.name : null;
          break;
        case "m.room.topic":
          room.topic = typeof content.topic === "string" ? content.topic : null;
          break;
        case "m.room.avatar":
          room.avatarMxc = content.url || null;
          break;
        case "m.room.canonical_alias":
          room.canonicalAlias = content.alias || null;
          break;
        case "m.room.join_rules":
          room.joinRule = content.join_rule || null;
          break;
        case "m.room.member":
          room.members.set(ev.state_key, {
            userId: ev.state_key,
            displayname: content.displayname || null,
            avatarMxc: content.avatar_url || null,
            membership: content.membership || "leave",
          });
          break;
        case "m.space.child":
          if (content.via && content.via.length) room.children.add(ev.state_key);
          else room.children.delete(ev.state_key);
          break;
        default:
          break;
      }
    };

    MatrixClient.prototype._resolveRoomMeta = function (room) {
      var joinedOthers = [];
      room.members.forEach(function (m) {
        if (m.membership === "join" && m.userId !== this.userId) {
          joinedOthers.push(m);
        }
      }, this);

      if (room.isSpace) {
        room.title = room.name || "Space";
      } else if (room.name) {
        room.title = room.name;
      } else if (joinedOthers.length === 1) {
        var other = joinedOthers[0];
        room.title = other.displayname || mxidLocalpart(other.userId);
        room.directUserId = other.userId;
      } else if (room.canonicalAlias) {
        room.title = room.canonicalAlias;
      } else {
        room.title = "Empty room";
      }
      room.isDirect =
        !room.isSpace && !room.name && !room.canonicalAlias && joinedOthers.length === 1;
      room.joinedMemberCount = joinedOthers.length + (this._isMember(room, this.userId) ? 1 : 0);
    };

    MatrixClient.prototype._isMember = function (room, userId) {
      var m = room.members.get(userId);
      return !!(m && m.membership === "join");
    };

    MatrixClient.prototype._displayNameFor = function (room, sender) {
      var m = room.members.get(sender);
      if (m && m.displayname) return m.displayname;
      if (sender === this.userId) return "You";
      return mxidLocalpart(sender);
    };

    MatrixClient.prototype._toTimelineItem = function (room, ev) {
      if (!ev || !ev.type) return null;
      var ts = ev.origin_server_ts || Date.now();
      var senderName = this._displayNameFor(room, ev.sender);
      var content = ev.content || {};

      if (ev.type === "m.room.message") {
        var msgtype = content.msgtype || "m.text";
        var body = typeof content.body === "string" ? content.body : "";
        if (
          msgtype === "m.image" ||
          msgtype === "m.file" ||
          msgtype === "m.audio" ||
          msgtype === "m.video"
        ) {
          body = "[attachment] " + body;
        }
        return {
          kind: "message",
          id: ev.event_id || null,
          sender: ev.sender,
          senderName: senderName,
          ts: ts,
          msgtype: msgtype,
          body: body,
        };
      }

      if (ev.type === "m.room.member") {
        var membership = content.membership || "join";
        var prev =
          ev.unsigned && ev.unsigned.prev_content && ev.unsigned.prev_content.membership;
        var targetName =
          ev.state_key === ev.sender
            ? senderName
            : (content.displayname || mxidLocalpart(ev.state_key));
        var text;
        if (membership === "join") text = targetName + " joined the room";
        else if (membership === "leave")
          text = prev === "invite" ? targetName + " declined the invite" : targetName + " left the room";
        else if (membership === "invite") text = senderName + " invited " + targetName;
        else if (membership === "ban") text = senderName + " banned " + targetName;
        else text = targetName + "'s membership is now " + membership;
        return { kind: "system", id: ev.event_id || null, ts: ts, text: text };
      }

      if (ev.type === "m.room.name" && content.name) {
        return {
          kind: "system",
          id: ev.event_id || null,
          ts: ts,
          text: senderName + ' changed the room name to "' + content.name + '"',
        };
      }

      if (ev.type === "m.room.topic" && content.topic) {
        return {
          kind: "system",
          id: ev.event_id || null,
          ts: ts,
          text: senderName + " changed the room topic",
        };
      }

      return null;
    };

    MatrixClient.prototype._removeEcho = function (room, txnId) {
      for (var i = 0; i < room.timeline.length; i++) {
        if (room.timeline[i] && room.timeline[i].txnId === txnId) {
          room.timeline.splice(i, 1);
          return true;
        }
      }
      return false;
    };

    MatrixClient.prototype._applySync = function (data) {
      var _this = this;
      var joined = (data.rooms && data.rooms.join) || {};
      var changedRooms = [];

      Object.keys(joined).forEach(function (roomId) {
        var rd = joined[roomId] || {};
        var room = _this._ensureRoom(roomId);
        var newEvents = [];

        (rd.state && rd.state.events ? rd.state.events : []).forEach(function (ev) {
          _this._applyStateEvent(room, ev);
        });

        var timelineEvents = rd.timeline && rd.timeline.events ? rd.timeline.events : [];
        timelineEvents.forEach(function (ev) {
          if (!ev || typeof ev !== "object") return;
          var evId = ev.event_id;
          if (evId) {
            if (_this._seen.has(evId)) return;
            _this._seen.add(evId);
          }
          if (ev.state_key !== undefined) _this._applyStateEvent(room, ev);
          if (evId && _this._acked.has(evId)) {
            var echoTxn = _this._acked.get(evId);
            _this._removeEcho(room, echoTxn);
            _this._acked.delete(evId);
            newEvents.push({ kind: "echo-replaced", txnId: echoTxn });
          }
          var item = _this._toTimelineItem(room, ev);
          if (item) {
            room.timeline.push(item);
            newEvents.push(item);
          }
        });

        if (rd.summary) {
          if (rd.summary["m.joined_member_count"] != null)
            room.joinedCount = rd.summary["m.joined_member_count"];
          if (rd.summary["m.invited_member_count"] != null)
            room.invitedCount = rd.summary["m.invited_member_count"];
        }
        if (rd.unread_notifications && rd.unread_notifications.notification_count != null) {
          room.serverNotifications = rd.unread_notifications.notification_count;
        }

        _this._resolveRoomMeta(room);

        if (newEvents.length) {
          var last = newEvents[newEvents.length - 1];
          room.lastActivityTs = last.ts || room.lastActivityTs;
        }

        if (_this._readyEmitted && newEvents.length && _this._selectedRoomId !== roomId) {
          var msgCount = 0;
          newEvents.forEach(function (e) {
            if (e.kind === "message") msgCount++;
          });
          if (msgCount) room.unread = Math.min((room.unread || 0) + msgCount, 99);
        }

        changedRooms.push({ room: room, newEvents: newEvents });
      });

      changedRooms.forEach(function (c) {
        _this.emit("room", c);
      });
      if (changedRooms.length) {
        this.emit("rooms", this.getRooms());
      }
    };

    /* --------------------------- room operations ------------------------ */

    MatrixClient.prototype.markRoomRead = function (roomId) {
      var room = this.rooms.get(roomId);
      if (room) room.unread = 0;
      this._selectedRoomId = roomId;
    };

    MatrixClient.prototype.clearSelectedRoom = function () {
      this._selectedRoomId = null;
    };

    /**
     * Send a text message with a local echo. The echo is removed and
     * replaced by the server event when /sync delivers it.
     */
    MatrixClient.prototype.sendMessage = function (roomId, body) {
      var _this = this;
      var text = String(body == null ? "" : body);
      if (!text.trim()) return Promise.reject(new Error("Empty message"));
      var txnId = "gr." + Date.now() + "." + ++this._txnCounter;
      var room = this.rooms.get(roomId);
      var echo = {
        kind: "message",
        id: "pending-" + txnId,
        txnId: txnId,
        pending: true,
        sender: this.userId,
        senderName: "You",
        ts: Date.now(),
        msgtype: "m.text",
        body: text,
      };
      if (room) {
        room.timeline.push(echo);
        room.lastActivityTs = echo.ts;
        this.emit("room", { room: room, newEvents: [echo] });
        this.emit("rooms", this.getRooms());
      }
      return this._api(
        "PUT",
        CLIENT_PREFIX +
          "/rooms/" +
          encodeURIComponent(roomId) +
          "/send/m.room.message/" +
          encodeURIComponent(txnId),
        { body: { msgtype: "m.text", body: text } }
      ).then(
        function (res) {
          if (res && res.event_id) {
            echo.eventId = res.event_id;
            _this._acked.set(res.event_id, txnId);
          }
          return res ? res.event_id : null;
        },
        function (err) {
          echo.pending = false;
          echo.failed = true;
          if (room) {
            _this.emit("room", {
              room: room,
              newEvents: [{ kind: "echo-failed", txnId: txnId }],
            });
          }
          throw err;
        }
      );
    };

    MatrixClient.prototype.createRoom = function (opts) {
      opts = opts || {};
      var body = {
        name: opts.name || "",
        preset: opts.isPublic ? "public_chat" : "private_chat",
      };
      if (opts.topic) body.topic = opts.topic;
      if (opts.isSpace) body.creation_content = { type: "m.space" };
      return this._api("POST", CLIENT_PREFIX + "/createRoom", { body: body }).then(
        function (res) {
          if (!res || !res.room_id) throw new Error("createRoom returned no room_id");
          return res.room_id;
        }
      );
    };

    MatrixClient.prototype.joinRoom = function (roomIdOrAlias) {
      return this._api(
        "POST",
        CLIENT_PREFIX + "/join/" + encodeURIComponent(roomIdOrAlias),
        { body: {} }
      ).then(function (res) {
        return res && res.room_id ? res.room_id : roomIdOrAlias;
      });
    };

    MatrixClient.prototype.invite = function (roomId, userId) {
      return this._api(
        "POST",
        CLIENT_PREFIX + "/rooms/" + encodeURIComponent(roomId) + "/invite",
        { body: { user_id: userId } }
      );
    };

    /* ------------------------------ queries ----------------------------- */

    /** Joined rooms (spaces excluded), most recently active first. */
    MatrixClient.prototype.getRooms = function () {
      return Array.from(this.rooms.values())
        .filter(function (r) {
          return !r.isSpace;
        })
        .sort(function (a, b) {
          return (b.lastActivityTs || 0) - (a.lastActivityTs || 0);
        });
    };

    /** Joined spaces (m.space rooms). */
    MatrixClient.prototype.getSpaces = function () {
      return Array.from(this.rooms.values()).filter(function (r) {
        return r.isSpace;
      });
    };

    MatrixClient.prototype.getRoom = function (roomId) {
      return this.rooms.get(roomId) || null;
    };

    /* ------------------------------- media ------------------------------ */

    /**
     * Resolve an mxc:// avatar URI to a displayable URL. Fetches through
     * the authenticated-media path (Bearer header) and caches blobs, so it
     * works against homeservers that require authenticated media (e.g.
     * matrix.org) as well as open ones.
     */
    MatrixClient.prototype.avatarSrc = function (mxc, size) {
      var _this = this;
      if (typeof URL.createObjectURL !== "function") {
        return Promise.resolve(null);
      }
      if (!mxc || typeof mxc !== "string" || mxc.indexOf("mxc://") !== 0) {
        return Promise.resolve(null);
      }
      var key = mxc + "@" + (size || 64);
      if (this._avatarCache.has(key)) return this._avatarCache.get(key);

      var rest = mxc.slice("mxc://".length).split("/");
      var server = rest.shift();
      var mediaId = rest.join("/");
      if (!server || !mediaId) return Promise.resolve(null);

      var url = new URL(
        this.baseUrl +
          "/_matrix/media/v3/thumbnail/" +
          encodeURIComponent(server) +
          "/" +
          encodeURIComponent(mediaId)
      );
      url.searchParams.set("width", String(size || 64));
      url.searchParams.set("height", String(size || 64));
      url.searchParams.set("method", "scale");

      var p = fetch(url.toString(), {
        headers: this.accessToken
          ? { Authorization: "Bearer " + this.accessToken }
          : {},
      })
        .then(function (res) {
          if (!res.ok) return null;
          return res.blob().then(function (blob) {
            return URL.createObjectURL(blob);
          });
        })
        .catch(function () {
          return null;
        });
      this._avatarCache.set(key, p);
      return p;
    };

    return MatrixClient;
  }
);
