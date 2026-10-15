/*
 * Grungus — renderer bootstrap.
 *
 * Owns the app flow: session restore → login → shell wiring → sync.
 * Components stay dumb; this file is the only place that touches both the
 * MatrixClient and the component tree.
 */
"use strict";

(function () {
  var root = document.getElementById("root");

  /* Session storage: Electron bridge when available, localStorage in the
     browser (dev/demo mode). */
  var storage =
    window.grungusPlatform ||
    {
      isElectron: false,
      saveSession: function (s) {
        try {
          localStorage.setItem("grungus-session", JSON.stringify(s));
          return Promise.resolve(true);
        } catch (e) {
          return Promise.resolve(false);
        }
      },
      loadSession: function () {
        try {
          return Promise.resolve(
            JSON.parse(localStorage.getItem("grungus-session") || "null")
          );
        } catch (e) {
          return Promise.resolve(null);
        }
      },
      clearSession: function () {
        try {
          localStorage.removeItem("grungus-session");
        } catch (e) {
          /* ignore */
        }
        return Promise.resolve(true);
      },
    };

  var client = null;
  var state = { spaceId: null, roomId: null };

  function showLogin() {
    root.textContent = "";
    var view = el("login-view");
    view.addEventListener("grungus:login", function (event) {
      handleLogin(event.detail, view);
    });
    root.appendChild(view);
  }

  function handleLogin(detail, view) {
    view.setBusy(true);
    view.setStatus("Connecting to homeserver…", false);
    var baseUrl;
    var session;
    return MatrixClient.resolveBaseUrl(detail.homeserver)
      .then(function (b) {
        baseUrl = b;
        client = new MatrixClient({ baseUrl: baseUrl });
        if (detail.accessToken) {
          client.accessToken = detail.accessToken;
          return client.whoami();
        }
        return client.loginWithPassword({
          username: detail.username,
          password: detail.password,
        });
      })
      .then(function () {
        session = {
          baseUrl: baseUrl,
          userId: client.userId,
          accessToken: client.accessToken,
          deviceId: client.deviceId,
        };
        return storage.saveSession(session);
      })
      .then(function () {
        startShell();
      })
      .catch(function (err) {
        view.setBusy(false);
        view.setStatus(
          (err && (err.errcode ? err.errcode + ": " + err.message : err.message)) ||
            "Login failed",
          true
        );
      });
  }

  function logout() {
    if (client) {
      var c = client;
      client = null;
      c.stopSync();
      c.logout().catch(function () {});
    }
    storage.clearSession().then(function () {
      location.reload();
    });
  }

  function startShell() {
    root.textContent = "";
    var shell = el("app-shell");
    root.appendChild(shell);

    var rail = shell.querySelector("space-rail");
    var roomList = shell.querySelector("room-list");
    var chat = shell.querySelector("chat-view");
    var members = shell.querySelector("member-list");

    function currentSpace() {
      return state.spaceId ? client.getRoom(state.spaceId) : null;
    }

    function roomsForSpace() {
      var rooms = client.getRooms();
      var space = currentSpace();
      if (!space) return rooms;
      return rooms.filter(function (r) {
        return space.children.has(r.id);
      });
    }

    function refreshSidebar() {
      rail.update(client.getSpaces(), state.spaceId, client);
      roomList.update(
        roomsForSpace(),
        client.getSpaces(),
        state.roomId,
        state.spaceId,
        client
      );
    }

    function selectRoom(roomId) {
      var room = client.getRoom(roomId);
      if (!room) return;
      state.roomId = roomId;
      client.markRoomRead(roomId);
      chat.setRoom(room, client, client.userId);
      members.update(room, client, client.userId);
      shell.setMembersVisible(true);
      refreshSidebar();
    }

    function selectSpace(spaceId) {
      state.spaceId = spaceId;
      var rooms = roomsForSpace();
      if (rooms.length) {
        selectRoom(rooms[0].id);
      } else {
        state.roomId = null;
        client.clearSelectedRoom();
        chat.clearRoom();
        members.update(null);
        shell.setMembersVisible(false);
        refreshSidebar();
      }
    }

    rail.addEventListener("grungus:select-space", function (event) {
      selectSpace(event.detail.spaceId);
    });

    roomList.addEventListener("grungus:select-room", function (event) {
      selectRoom(event.detail.roomId);
    });

    roomList.addEventListener("grungus:create-room", function (event) {
      var name = event.detail.name;
      client
        .createRoom({ name: name, isPublic: false })
        .catch(function (err) {
          chat.setNotice("Could not create room: " + (err.message || "network error"));
        });
    });

    roomList.addEventListener("grungus:logout", logout);

    chat.addEventListener("grungus:send", function (event) {
      client.sendMessage(event.detail.roomId, event.detail.body).catch(function (err) {
        chat.setNotice("Failed to send: " + (err.message || "network error"));
      });
    });

    client.on("room", function (p) {
      if (!client) return;
      if (p.room.id === state.roomId) {
        chat.appendEvents(p.room, p.newEvents);
        members.update(p.room, client, client.userId);
      }
      refreshSidebar();
    });

    client.on("connection", function (s) {
      roomList.setConnection(s);
    });

    client.on("auth-error", function () {
      logout();
    });

    client.on("ready", function () {
      /* first sync arrived — default to the first room of the current space */
      if (!state.roomId) {
        var rooms = roomsForSpace();
        if (rooms.length) selectRoom(rooms[0].id);
      }
      refreshSidebar();
    });

    /* user footer */
    var user = { userId: client.userId, displayname: null, avatarMxc: null };
    roomList.setUser(user);
    client
      .getProfile(client.userId)
      .then(function (profile) {
        user.displayname = profile.displayname || null;
        user.avatarMxc = profile.avatar_url || null;
        roomList.setUser(user);
      })
      .catch(function () {
        /* profile is optional decoration */
      });

    refreshSidebar();
    client.startSync();
  }

  /* ---- boot: restore a saved session, otherwise show login ---- */

  function boot() {
    storage
      .loadSession()
      .then(function (saved) {
        if (saved && saved.baseUrl && saved.accessToken) {
          client = new MatrixClient({
            baseUrl: saved.baseUrl,
            accessToken: saved.accessToken,
            userId: saved.userId || null,
          });
          return client.whoami().then(function () {
            startShell();
          });
        }
        showLogin();
      })
      .catch(function () {
        client = null;
        showLogin();
      });
  }

  boot();
})();
