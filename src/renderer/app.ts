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
    if (update.room.id === state.roomId) {
      chat.appendEvents(update.room, update.newEvents);
      members.update(update.room, client, client.userId);
    }
    refreshSidebar();
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
        return client
          .whoami()
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
