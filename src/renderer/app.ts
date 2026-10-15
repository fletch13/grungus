/*
 * Grungus — renderer bootstrap (TypeScript).
 *
 * Owns the app flow: session restore → login → shell wiring → sync.
 * Components stay dumb; this file is the only place that touches both the
 * MatrixClient and the component tree.
 */
import { el } from "./components/ui.ts";
import { LoginView, type LoginDetail } from "./components/login-view.ts";
import type { SpaceRail } from "./components/space-rail.ts";
import type { RoomList, UserInfo } from "./components/room-list.ts";
import type { ChatView } from "./components/chat-view.ts";
import type { MemberList } from "./components/member-list.ts";
import type { AppShell } from "./components/app-shell.ts";
import { MatrixClient, type Room } from "./services/matrix-client.ts";
import { E2eeCrypto, type CryptoStore } from "./services/e2ee.ts";
import { CallManager, type CallUiState } from "./services/calls.ts";
import { VerificationManager, type SasUiState } from "./services/sas.ts";

export interface SavedSession {
  baseUrl: string;
  userId: string | null;
  accessToken: string;
  deviceId: string | null;
}

export interface GrungusPlatform {
  isElectron: boolean;
  saveSession(session: SavedSession): Promise<boolean>;
  loadSession(): Promise<SavedSession | null>;
  clearSession(): Promise<boolean>;
  /** Present in Electron — olm pickle storage in the main-process vault. */
  cryptoGet?(key: string): Promise<string | null>;
  cryptoPut?(key: string, value: string): Promise<void>;
}

/* Exposed by the preload bridge when running inside Electron. */
declare global {
  interface Window {
    grungusPlatform?: GrungusPlatform;
  }
}

const root = document.getElementById("root");

/* Session storage: Electron bridge when available, localStorage in the
   browser (dev/demo mode). */
const storage: GrungusPlatform =
  window.grungusPlatform ??
  {
    isElectron: false,
    saveSession(session) {
      try {
        localStorage.setItem("grungus-session", JSON.stringify(session));
        return Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    },
    loadSession() {
      try {
        return Promise.resolve(
          JSON.parse(localStorage.getItem("grungus-session") ?? "null") as
            | SavedSession
            | null
        );
      } catch {
        return Promise.resolve(null);
      }
    },
    clearSession() {
      try {
        localStorage.removeItem("grungus-session");
      } catch {
        /* ignore */
      }
      return Promise.resolve(true);
    },
  };

let client: MatrixClient | null = null;
const state: { spaceId: string | null; roomId: string | null } = {
  spaceId: null,
  roomId: null,
};

function showLogin(): void {
  if (!root) return;
  root.textContent = "";
  const view = el("login-view") as LoginView;
  view.addEventListener("grungus:login", (event) => {
    handleLogin((event as CustomEvent<LoginDetail>).detail, view);
  });
  root.appendChild(view);
}

function handleLogin(detail: LoginDetail, view: LoginView): Promise<void> {
  view.setBusy(true);
  view.setStatus("Connecting to homeserver…", false);
  let baseUrl = "";
  return MatrixClient.resolveBaseUrl(detail.homeserver)
    .then((resolved) => {
      baseUrl = resolved;
      client = new MatrixClient({ baseUrl });
      if (detail.accessToken) {
        client.accessToken = detail.accessToken;
        return client.whoami();
      }
      return client.loginWithPassword({
        username: detail.username,
        password: detail.password,
      });
    })
    .then(() => {
      const active = client;
      if (!active) throw new Error("Login failed");
      const session: SavedSession = {
        baseUrl,
        userId: active.userId,
        accessToken: active.accessToken ?? "",
        deviceId: active.deviceId,
      };
      return storage.saveSession(session).then(() => session);
    })
    .then(() => {
      const active = client;
      if (!active) throw new Error("Login failed");
      return attachCrypto(active);
    })
    .then(() => {
      startShell();
    })
    .catch((err: unknown) => {
      view.setBusy(false);
      const message =
        err instanceof Error
          ? err instanceof Error && "errcode" in err
            ? `${(err as { errcode?: string }).errcode}: ${err.message}`
            : err.message
          : "Login failed";
      view.setStatus(message, true);
    });
}

function makeCryptoStore(): CryptoStore {
  const platform = window.grungusPlatform;
  if (platform?.cryptoGet && platform?.cryptoPut) {
    return {
      get: (key) => platform.cryptoGet!(key),
      put: (key, value) => platform.cryptoPut!(key, value),
    };
  }
  /* Browser dev mode: localStorage — dev/testing only, documented in README. */
  return {
    async get(key) {
      try {
        return localStorage.getItem("grungus-crypto:" + key);
      } catch {
        return null;
      }
    },
    async put(key, value) {
      try {
        localStorage.setItem("grungus-crypto:" + key, value);
      } catch {
        /* ignore */
      }
    },
  };
}

/** Attach the E2EE layer; the app degrades gracefully when it fails. */
async function attachCrypto(c: MatrixClient): Promise<void> {
  /* escape hatch for constrained environments (and call-only testing):
     ?noe2ee boots without the E2EE layer */
  if (new URLSearchParams(location.search).has("noe2ee")) {
    console.warn("[grungus] E2EE disabled via ?noe2ee");
    return;
  }
  try {
    const crypto = new E2eeCrypto({ host: c, store: makeCryptoStore() });
    await crypto.init();
    c.crypto = crypto;
    /* a forwarded room key may decrypt tracked UTD events — retry them */
    crypto.onInboundSessionAdded = (roomId) => c.retryUndecrypted(roomId);
  } catch (err) {
    console.error("[grungus] E2EE init failed (continuing without):", err);
  }
}

function logout(): void {
  if (client) {
    const c = client;
    client = null;
    c.stopSync();
    void c.logout().catch(() => {});
  }
  void storage.clearSession().then(() => {
    location.reload();
  });
}

function startShell(): void {
  const active = client;
  if (!root || !active) return;
  root.textContent = "";

  const shell = document.createElement("app-shell");
  root.appendChild(shell);

  const rail = shell.querySelector("space-rail");
  const roomList = shell.querySelector("room-list");
  const chat = shell.querySelector("chat-view");
  const members = shell.querySelector("member-list");
  if (!rail || !roomList || !chat || !members) return;

  const currentSpace = (): Room | null =>
    state.spaceId ? active.getRoom(state.spaceId) : null;

  const roomsForSpace = (): Room[] => {
    const rooms = active.getRooms();
    const space = currentSpace();
    if (!space) return rooms;
    return rooms.filter((room) => space.children.has(room.id));
  };

  const refreshSidebar = (): void => {
    rail.update(active.getSpaces(), state.spaceId, active);
    roomList.update(
      roomsForSpace(),
      active.getSpaces(),
      state.roomId,
      state.spaceId,
      active
    );
  };

  /* ---- calls (MSC3401, full-mesh WebRTC) ---- */
  const callManager = new CallManager(active);
  const callView = document.createElement("call-view");
  root.appendChild(callView);
  callManager.setUiListener((callState: CallUiState) => {
    callView.update(callState, callManager);
    if (state.roomId) {
      const room = active.getRoom(state.roomId);
      chat.setCallState(CallManager.callOngoing(room, active.userId), callState.active);
    }
  });

  const startCall = (roomId: string): void => {
    void callManager.start(roomId).catch((err: unknown) => {
      chat.setNotice(
        `Could not start call: ${err instanceof Error ? err.message : "unknown error"}`
      );
    });
  };

  chat.addEventListener("grungus:start-call", (event) => {
    startCall((event as CustomEvent<{ roomId: string }>).detail.roomId);
  });

  /* ---- SAS device verification ---- */
  const verifyView = document.createElement("verify-view");
  root.appendChild(verifyView);
  let verification: VerificationManager | null = null;
  const cryptoLayer = active.crypto;
  if (cryptoLayer) {
    verification = new VerificationManager(cryptoLayer);
    cryptoLayer.addPayloadListener((sender, type, content) => {
      verification?.handlePayload(sender, type, content);
    });
    /* v1: incoming requests are accepted automatically — the emoji
       comparison remains the human checkpoint */
    verification.onIncoming = (txn) => {
      void txn.sendStart();
    };
    const refreshVerify = (): void => {
      if (!verification) return;
      verifyView.update(
        verification.transactions.map((txn) => txn.uiState()),
        verification
      );
    };
    verification.onUi = refreshVerify;
    verification.onVerified = () => {
      refreshVerify();
      setTimeout(refreshVerify, 1500); /* let the verified card show */
    };
  }

  /* ---- typing + media ---- */
  let typingSentAt = 0;
  chat.addEventListener("grungus:typing", () => {
    const roomId = state.roomId;
    if (!roomId) return;
    const now = Date.now();
    if (now - typingSentAt < 8_000) return; /* server-side rate */
    typingSentAt = now;
    void active.setTyping(roomId, true).catch(() => {});
  });
  chat.addEventListener("grungus:typing-stop", () => {
    const roomId = state.roomId;
    if (!roomId) return;
    typingSentAt = 0;
    void active.setTyping(roomId, false).catch(() => {});
  });

  chat.addEventListener("grungus:send-media", (event) => {
    const detail = (event as CustomEvent<{ roomId: string; file: File }>).detail;
    void (async () => {
      try {
        const bytes = new Uint8Array(await detail.file.arrayBuffer());
        const mxc = await active.uploadMedia(detail.file.name, detail.file.type || "image/png", bytes);
        await active.sendMedia(detail.roomId, {
          mxc,
          name: detail.file.name,
          mimeType: detail.file.type || "image/png",
          size: bytes.length,
        });
      } catch (err) {
        chat.setNotice(
          `Could not send image: ${err instanceof Error ? err.message : "unknown error"}`
        );
      }
    })();
  });

  chat.addEventListener("grungus:verify-devices", () => {
    const roomId = state.roomId;
    if (!roomId || !verification || !cryptoLayer) return;
    const room = active.getRoom(roomId);
    if (!room) return;
    void (async () => {
      try {
        for (const member of room.members.values()) {
          if (member.userId === active.userId || member.membership !== "join") continue;
          const devices = await cryptoLayer.getDevicesOf(member.userId);
          for (const device of devices) {
            if (device.deviceId === cryptoLayer.deviceId) continue;
            const verified = await cryptoLayer.getVerifiedKey(member.userId, device.deviceId);
            if (verified === device.ed25519) continue; /* already verified */
            verification.start(member.userId, device.deviceId);
          }
        }
      } catch (err) {
        chat.setNotice(
          `Could not start verification: ${err instanceof Error ? err.message : "unknown error"}`
        );
      }
    })();
  });

  const selectRoom = (roomId: string): void => {
    const room = active.getRoom(roomId);
    if (!room) return;
    state.roomId = roomId;
    active.markRoomRead(roomId);
    chat.setRoom(room, active, active.userId);
    members.update(room, active, active.userId);
    shell.setMembersVisible(true);
    refreshSidebar();
  };

  const selectSpace = (spaceId: string | null): void => {
    state.spaceId = spaceId;
    const rooms = roomsForSpace();
    if (rooms.length > 0 && rooms[0]) {
      selectRoom(rooms[0].id);
    } else {
      state.roomId = null;
      active.clearSelectedRoom();
      chat.clearRoom();
      members.update(null, active, active.userId);
      shell.setMembersVisible(false);
      refreshSidebar();
    }
  };

  rail.addEventListener("grungus:select-space", (event) => {
    selectSpace((event as CustomEvent<{ spaceId: string | null }>).detail.spaceId);
  });

  roomList.addEventListener("grungus:select-room", (event) => {
    selectRoom((event as CustomEvent<{ roomId: string }>).detail.roomId);
  });

  roomList.addEventListener("grungus:create-room", (event) => {
    const name = (event as CustomEvent<{ name: string }>).detail.name;
    void active.createRoom({ name, isPublic: false }).catch((err: unknown) => {
      chat.setNotice(
        `Could not create room: ${err instanceof Error ? err.message : "network error"}`
      );
    });
  });

  roomList.addEventListener("grungus:logout", logout);

  chat.addEventListener("grungus:send", (event) => {
    const detail = (event as CustomEvent<{ roomId: string; body: string }>).detail;
    void active
      .sendMessage(detail.roomId, detail.body)
      .catch((err: unknown) => {
        chat.setNotice(
          `Failed to send: ${err instanceof Error ? err.message : "network error"}`
        );
      });
  });

  active.on("room", (update) => {
    if (!client) return;
    callManager.onRoomUpdate(update.room);
    if (update.room.id === state.roomId) {
      if (update.redraw) {
        /* timeline items changed in place (forwarded key decrypted UTD
           lines) — full re-render */
        chat.setRoom(update.room, client, client.userId);
      } else {
        chat.appendEvents(update.room, update.newEvents);
      }
      members.update(update.room, client, client.userId);
      chat.setCallState(
        CallManager.callOngoing(update.room, active.userId),
        callManager.active
      );
      chat.setTypingUsers(update.room.typingUsers);
    }
    refreshSidebar();
  });

  /* ---- invites ---- */
  active.on("invites", (invites) => {
    roomList.setInvites(invites);
  });
  roomList.addEventListener("grungus:accept-invite", (event) => {
    const detail = (event as CustomEvent<{ roomId: string }>).detail;
    void active
      .acceptInvite(detail.roomId)
      .then(() => {
        roomList.setInvites(active.getInvites());
        refreshSidebar();
      })
      .catch((err: unknown) => {
        chat.setNotice(
          `Could not accept invite: ${err instanceof Error ? err.message : "unknown error"}`
        );
      });
  });
  roomList.addEventListener("grungus:decline-invite", (event) => {
    const detail = (event as CustomEvent<{ roomId: string }>).detail;
    void active
      .declineInvite(detail.roomId)
      .then(() => {
        roomList.setInvites(active.getInvites());
      })
      .catch((err: unknown) => {
        chat.setNotice(
          `Could not decline invite: ${err instanceof Error ? err.message : "unknown error"}`
        );
      });
  });

  active.on("connection", (connState) => {
    roomList.setConnection(connState);
  });

  active.on("auth-error", () => {
    logout();
  });

  active.on("ready", () => {
    /* first sync landed — default to the first room of the current space */
    if (!state.roomId) {
      const rooms = roomsForSpace();
      const first = rooms[0];
      if (first) selectRoom(first.id);
    }
    refreshSidebar();
  });

  /* user footer */
  const user: UserInfo = {
    userId: active.userId ?? "?",
    displayname: null,
    avatarMxc: null,
  };
  roomList.setUser(user);
  void active
    .getProfile(user.userId)
    .then((profile) => {
      roomList.setUser({
        ...user,
        displayname: profile.displayname ?? null,
        avatarMxc: profile.avatar_url ?? null,
      });
    })
    .catch(() => {
      /* profile is optional decoration */
    });

  refreshSidebar();
  active.startSync();
}

/* ---- boot: restore a saved session, otherwise show login ---- */

function boot(): void {
  void storage
    .loadSession()
    .then((saved) => {
      if (saved && saved.baseUrl && saved.accessToken) {
        client = new MatrixClient({
          baseUrl: saved.baseUrl,
          accessToken: saved.accessToken,
          userId: saved.userId,
        });
        /* the olm account is bound to the server-side device — the crypto
           layer needs the token's device id, not a stale client-generated
           one from an old store */
        client.deviceId = saved.deviceId ?? null;
        return client
          .whoami()
          .then(() => {
            const active = client;
            if (active) return attachCrypto(active);
            return undefined;
          })
          .then(() => {
            startShell();
          })
          .catch(() => {
            client = null;
            showLogin();
          });
      }
      showLogin();
      return undefined;
    })
    .catch(() => {
      client = null;
      showLogin();
    });
}

boot();
