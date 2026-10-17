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
import { IncomingCall } from "./components/incoming-call.ts";
import { LkCallManager, type LkCallState } from "./services/calls-livekit.ts";
import { VerificationManager, type SasUiState } from "./services/sas.ts";
import { CrossSigning } from "./services/cross-signing.ts";

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
  /** Present in Electron — SSO auth window with redirect interception. */
  ssoLogin?(
    url: string,
    callbackPrefix: string
  ): Promise<{ loginToken: string | null }>;
  /** Present in Electron — system-browser SSO (passkeys work in the IdP). */
  ssoLoopbackPrepare?(): Promise<{ redirectUrl: string }>;
  ssoSystemBrowser?(url: string): Promise<{ loginToken: string | null }>;
  ssoLoopbackAbort?(): Promise<boolean>;
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
  view.addEventListener("grungus:server-chosen", (event) => {
    handleServerChosen((event as CustomEvent<{ homeserver: string }>).detail, view);
  });
  view.addEventListener("grungus:sso", (event) => {
    handleSsoLogin((event as CustomEvent<{ idpId: string }>).detail.idpId, view);
  });
  view.addEventListener("grungus:login", (event) => {
    handleLogin((event as CustomEvent<LoginDetail>).detail, view);
  });
  root.appendChild(view);
}

/* The resolved homeserver + flows of the in-progress login. */
let loginBaseUrl: string | null = null;

async function handleServerChosen(
  detail: { homeserver: string },
  view: LoginView
): Promise<void> {
  view.setBusy(true);
  view.setStatus("Connecting to homeserver…", false);
  try {
    loginBaseUrl = await MatrixClient.resolveBaseUrl(detail.homeserver);
    const probe = new MatrixClient({ baseUrl: loginBaseUrl });
    const flows = await probe.loginFlows();
    view.setBusy(false);
    view.showFlows(loginBaseUrl, flows);
  } catch (err) {
    view.setBusy(false);
    view.setStatus(
      `Could not reach the homeserver: ${err instanceof Error ? err.message : "unknown error"}`,
      true
    );
  }
}

/**
 * SSO (e.g. Keycloak): the redirect dance runs wherever passkeys and
 * WebAuthn prompts work best — the HOST SYSTEM BROWSER (loopback HTTP
 * captures the loginToken, RFC 8252 style). The embedded auth window is
 * the fallback; browser dev mode uses a full-page redirect that boot()
 * completes on return.
 */
async function handleSsoLogin(idpId: string, view: LoginView): Promise<void> {
  const baseUrl = loginBaseUrl;
  if (!baseUrl) return;
  const platform = window.grungusPlatform;

  if (platform?.ssoLoopbackPrepare && platform.ssoSystemBrowser) {
    /* Electron + system browser (preferred — OS-native passkeys) */
    view.setBusy(true);
    view.setStatus("Opening your system browser…", false);
    try {
      const { redirectUrl } = await platform.ssoLoopbackPrepare();
      const ssoUrl = new MatrixClient({ baseUrl }).ssoLoginUrl(idpId, redirectUrl);
      const result = await platform.ssoSystemBrowser(ssoUrl);
      if (!result.loginToken) {
        await platform.ssoLoopbackAbort?.();
        throw new Error("Sign-in did not complete in the browser window");
      }
      const client = new MatrixClient({ baseUrl });
      await client.loginWithToken(result.loginToken);
      await finishLogin(baseUrl, client);
    } catch (err) {
      view.setBusy(false);
      /* fall back to the embedded auth window */
      if (platform.ssoLogin) {
        view.setStatus("Retrying inside Grungus…", false);
        try {
          const callbackPrefix = "http://127.0.0.1/grungus-sso";
          const ssoUrl = new MatrixClient({ baseUrl }).ssoLoginUrl(idpId, callbackPrefix);
          const result = await platform.ssoLogin(ssoUrl, callbackPrefix);
          if (!result.loginToken) throw new Error("SSO window closed before sign-in finished");
          const client = new MatrixClient({ baseUrl });
          await client.loginWithToken(result.loginToken);
          await finishLogin(baseUrl, client);
          return;
        } catch (err2) {
          view.setBusy(false);
          view.setStatus(
            `SSO login failed: ${err2 instanceof Error ? err2.message : "unknown error"}`,
            true
          );
          return;
        }
      }
      view.setStatus(
        `SSO login failed: ${err instanceof Error ? err.message : "unknown error"}`,
        true
      );
    }
    return;
  }

  if (platform?.ssoLogin) {
    /* Electron fallback: embedded auth window with redirect interception */
    view.setBusy(true);
    view.setStatus("Complete the sign-in in the opened window…", false);
    try {
      const callbackPrefix = "http://127.0.0.1/grungus-sso";
      const ssoUrl = new MatrixClient({ baseUrl }).ssoLoginUrl(idpId, callbackPrefix);
      const result = await platform.ssoLogin(ssoUrl, callbackPrefix);
      if (!result.loginToken) throw new Error("SSO window closed before sign-in finished");
      const client = new MatrixClient({ baseUrl });
      await client.loginWithToken(result.loginToken);
      await finishLogin(baseUrl, client);
    } catch (err) {
      view.setBusy(false);
      view.setStatus(
        `SSO login failed: ${err instanceof Error ? err.message : "unknown error"}`,
        true
      );
    }
    return;
  }

  /* Browser: full-page redirect; boot() completes it on return. */
  const returnTo =
    `${location.origin}${location.pathname}` +
    `?sso=1&hs=${encodeURIComponent(baseUrl)}`;
  const ssoUrl = new MatrixClient({ baseUrl }).ssoLoginUrl(idpId, returnTo);
  location.href = ssoUrl;
}

/** Shared post-auth path: persist the session, attach E2EE, start the shell. */
async function finishLogin(baseUrl: string, activeClient: MatrixClient): Promise<void> {
  const active = activeClient;
  const session: SavedSession = {
    baseUrl,
    userId: active.userId,
    accessToken: active.accessToken ?? "",
    deviceId: active.deviceId,
  };
  await storage.saveSession(session);
  client = active;
  await attachCrypto(active);
  startShell();
}

async function handleLogin(detail: LoginDetail, view: LoginView): Promise<void> {
  view.setBusy(true);
  view.setStatus("Signing in…", false);
  let baseUrl = loginBaseUrl;
  try {
    if (!baseUrl) {
      baseUrl = await MatrixClient.resolveBaseUrl(detail.homeserver);
    }
    const active = new MatrixClient({ baseUrl });
    if (detail.accessToken) {
      active.accessToken = detail.accessToken;
      await active.whoami();
    } else {
      await active.loginWithPassword({
        username: detail.username,
        password: detail.password,
      });
    }
    await finishLogin(baseUrl, active);
  } catch (err) {
    view.setBusy(false);
    const message =
      err instanceof Error
        ? err instanceof Error && "errcode" in err
          ? `${(err as { errcode?: string }).errcode}: ${err.message}`
          : err.message
        : "Login failed";
    view.setStatus(message, true);
  }
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
      active,
      active.getRooms().filter((room) => !room.isDirect)
    );
  };

  /* ---- calls (MSC3401 mesh, or LiveKit SFU when configured) ---- */
  const callManager = new CallManager(active);
  const lkManager = new LkCallManager(active);
  const callView = document.createElement("call-view");
  root.appendChild(callView);
  /* the incoming-call ring banner (someone started a call in one of
     our rooms) */
  const incomingCall = document.createElement("incoming-call");
  root.appendChild(incomingCall);
  let callMode: "mesh" | "livekit" = "mesh";
  /** debounced read-marker sender for the open room */
  let markReadTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleMarkRead = (roomId: string): void => {
    if (markReadTimer) clearTimeout(markReadTimer);
    markReadTimer = setTimeout(() => {
      markReadTimer = null;
      if (state.roomId === roomId) active.markRoomRead(roomId);
    }, 1_500);
  };
  /** per-room "call was ongoing last we looked" — rings only fire on an
   *  OBSERVED false→true flip, so stale state at login never rings */
  const callWasOngoing = new Map<string, boolean>();
  /** the room our current call is in (no self-ring) */
  let currentCallRoomId: string | null = null;

  const refreshCallHeader = (): void => {
    if (state.roomId) {
      const room = active.getRoom(state.roomId);
      const ongoing =
        callMode === "livekit" ? lkManager.connected : callManager.active;
      chat.setCallState(
        CallManager.callOngoing(room, active.userId),
        ongoing
      );
    }
  };

  callManager.setUiListener((callState: CallUiState) => {
    currentCallRoomId = callState.active ? callState.roomId : null;
    if (callState.active) incomingCall.dismiss();
    if (callMode === "mesh") {
      callView.update(callState, callManager);
      refreshCallHeader();
    }
  });
  lkManager.setListener((lkState) => {
    currentCallRoomId = lkState.connected ? state.roomId : null;
    if (lkState.connected) incomingCall.dismiss();
    if (callMode === "livekit") {
      /* adapt the SFU state to the overlay's shape */
      callView.update(
        {
          active: lkState.connected,
          roomId: state.roomId,
          participants: lkState.participants.map((p) => ({
            key: p.identity,
            userId: p.identity,
            deviceId: "sfu",
            name: p.name,
            stream: p.stream,
            screenStream: p.screenStream,
            sharing: p.sharing,
            connectionState: "connected",
          })),
          notice: lkState.notice,
          localMuted: lkState.localMuted,
          localSharing: lkState.localSharing,
          localKey: active.userId,
        },
        {
          /* route the overlay buttons to the SFU manager */
          setMuted: (m) => lkManager.setMuted(m),
          hangUp: () => void lkManager.leave(),
          startScreenshare: () => void lkManager.setSharing(true),
          stopScreenshare: () => void lkManager.setSharing(false),
          localStream: null,
        }
      );
      refreshCallHeader();
    }
  });

  const startCall = (roomId: string): void => {
    const room = active.getRoom(roomId);
    /* LiveKit path when the room has a Grungus service state OR an
       ongoing MatrixRTC call with a LiveKit focus (Element Call interop:
       join the call another MatrixRTC client started) */
    const rtcFocus = room?.rtcMemberships.find((m) => m.focusUrl)?.focusUrl ?? null;
    if (room?.livekitService || rtcFocus) {
      callMode = "livekit";
      lkManager.setRoomId(roomId);
      void lkManager.join().catch((err: unknown) => {
        chat.setNotice(
          `Could not join the LiveKit call: ${err instanceof Error ? err.message : "network error"}`
        );
        callMode = "mesh";
      });
      return;
    }
    callMode = "mesh";
    void callManager.start(roomId).catch((err: unknown) => {
      chat.setNotice(
        `Could not start call: ${err instanceof Error ? err.message : "network error"}`
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

  /* ---- key backup / restore ---- */
  const backupView = document.createElement("backup-view");
  backupView.hidden = true;
  root.appendChild(backupView);
  let serverHasBackup: boolean | null = null;
  if (active.crypto) {
    void active.crypto
      .getKeyBackupVersion()
      .then((version) => {
        serverHasBackup = version !== null;
        backupView.update(active.crypto, serverHasBackup);
      })
      .catch(() => {
        serverHasBackup = false;
        backupView.update(active.crypto, false);
      });
  } else {
    backupView.update(null, false);
  }
  roomList.addEventListener("grungus:open-backup", () => {
    backupView.update(active.crypto, serverHasBackup);
    backupView.show();
  });
  backupView.addEventListener(
    "grungus:backup-create",
    (event) => {
      const detail = (event as CustomEvent<{ passphrase: string; confirm: string }>).detail;
      const cryptoLayerNow = active.crypto;
      if (!cryptoLayerNow) return;
      if (detail.passphrase !== detail.confirm) {
        backupView.setStatus("Passphrases do not match.", true);
        return;
      }
      backupView.setStatus("Deriving key and creating backup…", false);
      void cryptoLayerNow
        .createKeyBackup(detail.passphrase)
        .then((version) => {
          serverHasBackup = true;
          backupView.update(cryptoLayerNow, true);
          backupView.setStatus(`Backup created (version ${version}). New room keys are backed up automatically.`, false);
        })
        .catch((err: unknown) => {
          backupView.setStatus(
            `Could not create backup: ${err instanceof Error ? err.message : "unknown error"}`,
            true
          );
        });
    }
  );
  backupView.addEventListener("grungus:backup-restore", (event) => {
    const detail = (event as CustomEvent<{ passphrase: string }>).detail;
    const cryptoLayerNow = active.crypto;
    if (!cryptoLayerNow) return;
    backupView.setStatus("Deriving key and fetching the backup…", false);
    void cryptoLayerNow
      .restoreKeyBackup(detail.passphrase)
      .then((count) => {
        backupView.setStatus(`Restored ${count} session${count === 1 ? "" : "s"} — undecryptable messages update in place.`, false);
      })
      .catch((err: unknown) => {
        backupView.setStatus(
          `${err instanceof Error ? err.message : "unknown error"}`,
          true
        );
      });
  });

  const cryptoLayer = active.crypto;
  if (cryptoLayer) {
    const crossSigning = new CrossSigning(cryptoLayer, active);
    verification = new VerificationManager(cryptoLayer);
    verification.crossSigning = crossSigning;
    cryptoLayer.addPayloadListener((sender, type, content, senderKey) => {
      /* SSSS secret sharing (spec "Secret sharing"): requests go to the
         cross-signing service; secrets only flow to verified own devices */
      if (type === "m.secret.request") {
        const req = content as { name?: string; device_id?: string; request_id?: string };
        if (req.name && req.device_id && req.request_id) {
          void crossSigning.handleSecretRequest(sender, req.device_id, req.request_id, req.name);
        }
        return;
      }
      if (type === "m.secret.send") {
        const send = content as { request_id?: string; secret?: string };
        if (send.request_id && send.secret) {
          void crossSigning.handleSecretSend(send.request_id, send.secret);
        }
        return;
      }
      verification?.handlePayload(sender, type, content, senderKey);
    });
    /* incoming verification requests PROMPT — never auto-accept; the
       human decides whether to verify the other device */
    const refreshVerify = (): void => {
      if (!verification) return;
      verifyView.update(
        [
          ...verification.transactions.map((txn) => txn.uiState()),
          ...verification.qrTransactions.map((txn) => txn.uiState()),
        ],
        verification
      );
    };
    verification.onIncoming = () => {
      refreshVerify();
    };
    verification.onUi = refreshVerify;
    verification.onQrUi = refreshVerify;
    verification.onVerified = (peerUserId, peerDeviceId) => {
      refreshVerify();
      setTimeout(refreshVerify, 1500); /* let the verified card show */
      /* cross-signing propagation: when THIS device holds the self-
         signing key and we verified one of OUR OWN devices, sign its
         device key — every device that trusts our master key then
         trusts it too (verify once, trust everywhere) */
      if (peerUserId === active.userId) {
        void crossSigning.signDevice(peerDeviceId).catch(() => {});
        /* SSSS: if we do NOT hold the private signing keys yet, ask the
           just-verified device for them (the js-sdk
           requestKeysDuringVerification flow) — this turns a new
           device into a full signer */
        void (async () => {
          if (!(await crossSigning.canSign())) {
            await crossSigning.requestCrossSigningKeys(peerUserId, peerDeviceId).catch(() => {});
          }
        })();
      }
    };
    /* the user accepted an incoming request (or re-verifies a card) */
    verifyView.addEventListener("grungus:accept-verify", (event) => {
      const id = (event as CustomEvent<{ transactionId: string }>).detail.transactionId;
      const txn = verification?.transactions.find((t) => t.transactionId === id);
      if (txn) void txn.sendStart();
    });
    verifyView.addEventListener("grungus:decline-verify", (event) => {
      const id = (event as CustomEvent<{ transactionId: string }>).detail.transactionId;
      void verification?.cancel(id);
      const qr = verification?.asQr(id);
      if (qr) {
        void qr.decline();
        verification?.discard(id);
      }
      refreshVerify();
    });
    /* the overlay's ✕: cancel everything and clear the overlay */
    verifyView.addEventListener("grungus:close-verify", () => {
      verification?.cancelAll();
      verifyView.closeAll();
      refreshVerify();
    });
    /* failed/cancelled cards' Dismiss: remove the transaction from the UI */
    verifyView.addEventListener("grungus:discard-verify", (event) => {
      const id = (event as CustomEvent<{ transactionId: string }>).detail.transactionId;
      verification?.discard(id);
      refreshVerify();
    });
    verifyView.addEventListener("grungus:confirm-sas", (event) => {
      const id = (event as CustomEvent<{ transactionId: string }>).detail.transactionId;
      const txn = verification?.transactions.find((t) => t.transactionId === id);
      if (txn) void txn.confirmEmojiMatch();
    });
    /* QR: shower renders its code, scanner opens camera/upload */
    /* show-qr became async (cross-signing mode selection) */
    verifyView.addEventListener("grungus:show-qr", (event) => {
      const id = (event as CustomEvent<{ transactionId: string }>).detail.transactionId;
      void verification?.asQr(id)?.showQrCode();
      refreshVerify();
    });
    verifyView.addEventListener("grungus:scan-qr", (event) => {
      const id = (event as CustomEvent<{ transactionId: string }>).detail.transactionId;
      verification?.asQr(id)?.startScanning();
      refreshVerify();
    });
    verifyView.addEventListener("grungus:qr-scanned", (event) => {
      const detail = (event as CustomEvent<{ transactionId: string; bytes: Uint8Array }>).detail;
      void verification?.asQr(detail.transactionId)?.scanQrCode(detail.bytes);
      refreshVerify();
    });
    verifyView.addEventListener("grungus:qr-scan-error", (event) => {
      const detail = (event as CustomEvent<{ error: string }>).detail;
      console.warn("[grungus] qr scan:", detail.error);
    });
    verifyView.addEventListener("grungus:confirm-scan", (event) => {
      const id = (event as CustomEvent<{ transactionId: string }>).detail.transactionId;
      void verification?.asQr(id)?.confirmScanned();
      refreshVerify();
    });
    /* cross-signing bootstrap (UIA password prompt on the view) */
    verifyView.addEventListener("grungus:bootstrap-crosssigning", (event) => {
      const detail = (event as CustomEvent<{
        password: string;
        recoveryPassphrase?: string;
      }>).detail;
      void (async () => {
        try {
          const res = await crossSigning.bootstrap(
            detail.password || undefined,
            detail.recoveryPassphrase || undefined
          );
          verifyView.setBootstrapResult({
            ok: true,
            message:
              `✅ Cross-signing ready — master key ${res.masterPub.slice(0, 12)}…` +
              (res.ssssKeyId ? " · secret storage enabled" : ""),
          });
        } catch (err) {
          verifyView.setBootstrapResult({
            ok: false,
            message: `❌ Bootstrap failed: ${err instanceof Error ? err.message : "unknown error"}`,
          });
        }
      })();
    });
    /* session verification: this device asks its own other devices */
    verifyView.addEventListener("grungus:request-session-verify", () => {
      verifyView.markSessionRequested();
      void verification?.startSessionVerification().then(() => refreshVerify());
    });
    roomList.addEventListener("grungus:verify-session", () => {
      if (!verification) return;
      verifyView.setSessionMode(true);
      refreshVerify();
    });
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
    /* the call state may have arrived in the initial sync (before this
       room was ever selected) — refresh the header's Join call state */
    chat.setCallState(
      CallManager.callOngoing(room, active.userId),
      callManager.active && callMode === "mesh"
        ? true
        : callMode === "livekit" && lkManager.connected
    );
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

  /* space management */
  roomList.addEventListener("grungus:create-space", (event) => {
    const name = (event as CustomEvent<{ name: string }>).detail.name;
    void active.createRoom({ name, isPublic: false, isSpace: true }).catch((err: unknown) => {
      chat.setNotice(
        `Could not create space: ${err instanceof Error ? err.message : "network error"}`
      );
    });
  });
  roomList.addEventListener("grungus:add-to-space", (event) => {
    const detail = (event as CustomEvent<{ spaceId: string; roomId: string }>).detail;
    void active.addToSpace(detail.spaceId, detail.roomId).catch((err: unknown) => {
      chat.setNotice(
        `Could not add to space: ${err instanceof Error ? err.message : "network error"}`
      );
    });
  });
  roomList.addEventListener("grungus:remove-from-space", (event) => {
    const detail = (event as CustomEvent<{ spaceId: string; roomId: string }>).detail;
    void active.removeFromSpace(detail.spaceId, detail.roomId).catch((err: unknown) => {
      chat.setNotice(
        `Could not remove from space: ${err instanceof Error ? err.message : "network error"}`
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

  chat.addEventListener("grungus:edit", (event) => {
    const detail = (event as CustomEvent<{ roomId: string; eventId: string; body: string }>).detail;
    void active
      .editMessage(detail.roomId, detail.eventId, detail.body)
      .catch((err: unknown) => {
        chat.setNotice(
          `Failed to edit: ${err instanceof Error ? err.message : "network error"}`
        );
      });
  });

  chat.addEventListener("grungus:send-reply", (event) => {
    const detail = (event as CustomEvent<{
      roomId: string;
      parentEventId: string;
      parentSender: string;
      parentBody: string;
      body: string;
    }>).detail;
    void active
      .replyMessage(
        detail.roomId,
        detail.parentEventId,
        detail.parentSender,
        detail.parentBody,
        detail.body
      )
      .catch((err: unknown) => {
        chat.setNotice(
          `Failed to reply: ${err instanceof Error ? err.message : "network error"}`
        );
      });
  });

  chat.addEventListener("grungus:react", (event) => {
    const detail = (event as CustomEvent<{ roomId: string; eventId: string | null; emoji: string }>).detail;
    if (!detail.eventId) return;
    void active
      .sendReaction(detail.roomId, detail.eventId, detail.emoji)
      .catch((err: unknown) => {
        chat.setNotice(
          `Failed to react: ${err instanceof Error ? err.message : "network error"}`
        );
      });
  });

  active.on("room", (update) => {
    if (!client) return;
    callManager.onRoomUpdate(update.room);
    /* incoming-call ring: edge-detect "a call started in this room"
       (mesh m.call.member state or a MatrixRTC membership with a
       LiveKit focus) while we are not in that call ourselves. Only an
       OBSERVED false→true flip rings — a call that was already ongoing
       when we logged in is a missed call, not an incoming one */
    const ongoing =
      CallManager.callOngoing(update.room, active.userId) ||
      update.room.rtcMemberships.some((m) => m.focusUrl);
    const prev = callWasOngoing.get(update.room.id);
    callWasOngoing.set(update.room.id, ongoing);
    if (
      ongoing &&
      prev === false &&
      update.room.id !== currentCallRoomId &&
      incomingCall.ringingRoomId === null
    ) {
      incomingCall.show(update.room.id, update.room.title);
    }
    if (!ongoing && incomingCall.ringingRoomId === update.room.id) {
      incomingCall.dismiss();
    }
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
      /* the open room is being read: keep the unread at zero and send
         fresh read markers (debounced — receipts for every message
         would spam the room) */
      if (update.newEvents.some((e) => e.kind === "message")) {
        scheduleMarkRead(update.room.id);
      }
      /* receipts changed (someone read our messages) — re-render the
         Seen indicator */
      if (update.newEvents.length === 0) {
        chat.refreshSeenState();
      }
    }
    refreshSidebar();
  });

  /* joining from the ring banner routes through the same call setup */
  incomingCall.addEventListener("grungus:join-incoming", (event) => {
    const roomId = (event as CustomEvent<{ roomId: string }>).detail.roomId;
    selectRoom(roomId);
    startCall(roomId);
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

/* ---- boot: complete an SSO return, restore a saved session, or show login ---- */

async function completeSsoReturn(params: URLSearchParams): Promise<void> {
  const loginToken = params.get("loginToken");
  const hs = params.get("hs");
  if (!loginToken || !hs) return;
  /* strip the token from the URL — it is single-use and must not linger */
  history.replaceState(null, "", location.pathname);
  try {
    const active = new MatrixClient({ baseUrl: hs });
    await active.loginWithToken(loginToken);
    await finishLogin(hs, active);
  } catch (err) {
    console.error("[grungus] SSO token exchange failed:", err);
    showLogin();
  }
}

function boot(): void {
  const bootParams = new URLSearchParams(location.search);
  if (bootParams.get("sso") === "1" && bootParams.get("loginToken")) {
    void completeSsoReturn(bootParams);
    return;
  }
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
