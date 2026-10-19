/*
 * Grungus — Matrix client facade and sync orchestration (TypeScript).
 *
 * The public entry point for the subset of the Matrix
 * Client-Server API that Grungus uses (the same open protocol Element
 * speaks): homeserver discovery, password/token login, /sync long-polling,
 * room state + timeline handling, message send with local echo, room
 * creation/join/invite, profiles, media (thumbnails + authenticated
 * downloads for images/GIFs), and logout.
 *
 * Consumed two ways: esbuild bundles it into the renderer; Node runs it
 * directly (native type stripping) for the tests and the example CLIs.
 * Written against Matrix spec v1.x (Client-Server API, v3 paths).
 * Focused matrix-* services own room state, messaging, media, history,
 * timeline decryption, relations, and RTC parsing behind this stable API.
 */

import type { EncryptedFile } from "./attachments.ts";
export { mxidLocalpart } from "./matrix-identifiers.ts";
import { MatrixHistory } from "./matrix-history.ts";
import { MatrixTimeline } from "./matrix-timeline.ts";
import { MatrixMedia } from "./matrix-media.ts";
import { MatrixMessaging } from "./matrix-messaging.ts";
import { MatrixRtc } from "./matrix-rtc.ts";
import { createRoomRecord, applyStateEvent, resolveRoomMeta } from "./matrix-rooms.ts";
import { applyRelations } from "./matrix-relations.ts";
import type { E2eeCrypto } from "./e2ee.ts";

/* Re-export the established public types so existing callers keep their imports. */

export * from "./matrix-types.ts";
import { HttpError } from "./matrix-types.ts";
import type {
  MatrixEvent, SyncResponse, ToDeviceEvent, MediaKeysEvent,
  RoomEvent, RoomUpdate, InvitedRoom, Room,
  ConnectionState, ClientEvents, Listener, LoginCredentials, LoginResult,
  LoginFlow, RegistrationFlow, RegistrationChallenge, RegisterCredentials,
  CreateRoomOptions, ApiOptions, MediaMessage,
} from "./matrix-types.ts";

const CLIENT_PREFIX = "/_matrix/client/v3";
const SYNC_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalHost(host: string): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host.endsWith(".local")
  );
}

/* --------------------------------- client -------------------------------- */

export class MatrixClient {
  readonly baseUrl: string;
  accessToken: string | null;
  userId: string | null;
  deviceId: string | null;
  readonly rooms = new Map<string, Room>();
  /** Rooms with a pending invite (rooms.invite in /sync). */
  readonly invites = new Map<string, InvitedRoom>();
  connectionState: ConnectionState = "connecting";
  /** E2EE layer — attached by the app after login; null in plain mode. */
  crypto: E2eeCrypto | null = null;
  /**
   * Hook for PLAINTEXT to-device events (non-m.room.encrypted), e.g.
   * MSC3401 call signaling in unencrypted rooms. Set by the call layer.
   */
  onToDevice: ((event: ToDeviceEvent) => void) | null = null;
  /**
   * Hook for raw m.call.* ROOM events (the legacy 1:1 call protocol —
   * m.call.invite/answer/select_answer/candidates/hangup). Decrypted
   * first in encrypted rooms, exactly like Element's call events. Set by
   * the call layer.
   */
  onCallEvent: ((roomId: string, ev: MatrixEvent) => void) | null = null;

  /**
   * Media (call) encryption keys received from other participants, either as
   * Element-style io.element.call.encryption_keys room events (megolm-wrapped
   * in encrypted rooms) or as to-device org.matrix.msc4143.rtc.encryption_key
   * messages (Element mobile). Consumed by the LiveKit E2EE layer.
   */
  private readonly _rtc = new MatrixRtc();

  private _since: string | null = null;
  private readonly _history: MatrixHistory;
  private _seen = new Set<string>();
  private readonly _messaging: MatrixMessaging;
  private _syncRunning = false;
  private _stopped = true;
  /** account data by event type (cross-signing keys, etc.) */
  private _accountData = new Map<string, Record<string, unknown>>();
  private _syncAbort: AbortController | null = null;
  private _backoffMs = 0;
  private _readyEmitted = false;
  private _selectedRoomId: string | null = null;
  private readonly _media: MatrixMedia;
  private readonly _timeline: MatrixTimeline;
  /**
   * Encryption state for rooms not yet synced (set by createRoom/joinRoom):
   * roomId -> is encrypted. Sends racing the first sync consult this so a
   * room created/joined encrypted can never receive plaintext.
   */
  private _pendingEncryption = new Map<string, boolean>();
  private readonly _listeners: { [K in keyof ClientEvents]: Set<Listener<K>> } = {
    sync: new Set(),
    ready: new Set(),
    room: new Set(),
    rooms: new Set(),
    invites: new Set(),
    connection: new Set(),
    error: new Set(),
    "auth-error": new Set(),
    "room-deleted": new Set(),
  };

  constructor(options: {
    baseUrl: string;
    accessToken?: string | null;
    userId?: string | null;
  }) {
    if (!options.baseUrl) throw new Error("MatrixClient requires baseUrl");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.accessToken = options.accessToken ?? null;
    this.userId = options.userId ?? null;
    this.deviceId = null;
    this._media = new MatrixMedia(this);
    const client = this;
    this._messaging = new MatrixMessaging({
      get userId() { return client.userId; },
      get crypto() { return client.crypto; },
      api: (method, path, options) => this.api(method, path, options),
      getRoom: roomId => this.getRoom(roomId),
      encryptionForRoom: roomId => this._encryptionForRoom(roomId),
      uploadMedia: (name, mimeType, bytes) => this._media.uploadMedia(name, mimeType, bytes),
      notify: update => this.emit("room", update),
      notifyRooms: () => this.emit("rooms", this.getRooms()),
    });
    this._timeline = new MatrixTimeline({
      get userId() { return client.userId; },
      get crypto() { return client.crypto; },
      get onCallEvent() { return client.onCallEvent?.bind(client) ?? null; },
      getRoom: roomId => this.getRoom(roomId),
      handleMediaKeys: (roomId, event) => this._rtc.handleRoomKeys(roomId, event),
      notify: update => this.emit("room", update),
      notifyRooms: () => this.emit("rooms", this.getRooms()),
    });
    this._history = new MatrixHistory({
      get crypto() { return client.crypto; },
      timeline: this._timeline,
      acknowledged: this._messaging.acknowledged,
      seen: this._seen,
      api: (method, path, options) => this.api(method, path, options),
      getRoom: roomId => this.getRoom(roomId),
      notify: update => this.emit("room", update),
    });
  }

  /* --------------------------- typed event bus --------------------------- */

  on<K extends keyof ClientEvents>(event: K, cb: Listener<K>): () => void {
    this._listeners[event].add(cb as unknown as Listener<K>);
    return () => this.off(event, cb);
  }

  off<K extends keyof ClientEvents>(event: K, cb: Listener<K>): void {
    this._listeners[event].delete(cb as unknown as Listener<K>);
  }

  protected emit<K extends keyof ClientEvents>(
    event: K,
    ...args: ClientEvents[K]
  ): void {
    for (const cb of [...this._listeners[event]]) {
      try {
        (cb as unknown as Listener<K>)(...args);
      } catch (e) {
        /* listener errors must not break the sync loop */
        console.error(e);
      }
    }
  }

  /* --------------------------- URL discovery ----------------------------- */

  /**
   * Turn user input ("matrix.org", "https://hs.example.com",
   * "127.0.0.1:8008") into a base URL, honoring .well-known/matrix/client
   * delegation like Element does; falls back to the origin itself.
   */
  static async resolveBaseUrl(input: string): Promise<string> {
    const raw = String(input ?? "").trim().replace(/\/+$/, "");
    if (!raw) throw new Error("Empty homeserver address");

    if (/^https?:\/\//i.test(raw)) {
      return new URL(raw).origin;
    }

    let isLocal = false;
    try {
      isLocal = isLocalHost(new URL(`https://${raw}`).hostname);
    } catch {
      throw new Error(`Invalid homeserver address: ${input}`);
    }
    const origin = new URL(`${isLocal ? "http" : "https"}://${raw}`).origin;

    /* Try .well-known delegation, then fall back to the origin. */
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 5_000);
    try {
      const res = await fetch(new URL("/.well-known/matrix/client", origin), {
        signal: ctrl.signal,
      });
      if (res.ok) {
        const wk = (await res.json()) as {
          "m.homeserver"?: { base_url?: string };
        };
        const base = wk["m.homeserver"]?.base_url;
        if (base && /^https?:\/\//i.test(base)) {
          return base.replace(/\/+$/, "");
        }
      }
    } catch {
      /* fall through to origin */
    }
    return origin;
  }

  versions(): Promise<{ versions?: string[] }> {
    return this.api("GET", "/_matrix/client/versions", { auth: false });
  }

  /* ------------------------------- HTTP ---------------------------------- */

  async api<T>(
    method: string,
    path: string,
    opts: ApiOptions = {}
  ): Promise<T> {
    const { body, auth = true, signal, timeoutMs = 35_000 } = opts;
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && this.accessToken) {
      headers["Authorization"] = `Bearer ${this.accessToken}`;
    }

    const ctrl = new AbortController();
    const timer =
      timeoutMs != null && timeoutMs > 0
        ? setTimeout(() => ctrl.abort(), timeoutMs)
        : null;
    const onExternalAbort = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }
      if (!res.ok) {
        throw new HttpError(
          res.status,
          data as { errcode?: string; error?: string } | null
        );
      }
      return data as T;
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }
  }

  /* ----------------------------- auth flows ------------------------------ */

  /** The login modes this homeserver offers (GET /login). */
  async loginFlows(): Promise<LoginFlow[]> {
    const res = await this.api<{ flows?: LoginFlow[] }>(
      "GET",
      `${CLIENT_PREFIX}/login`,
      { auth: false }
    );
    return res.flows ?? [];
  }

  /** Complete an SSO login by exchanging the loginToken from the redirect. */
  async loginWithToken(loginToken: string): Promise<LoginResult> {
    const res = await this.api<LoginResult>("POST", `${CLIENT_PREFIX}/login`, {
      auth: false,
      body: {
        type: "m.login.token",
        token: loginToken,
        initial_device_display_name: "Grungus",
      },
    });
    if (!res || !res.access_token) {
      throw new Error("Homeserver returned no access token");
    }
    this.accessToken = res.access_token;
    this.userId = res.user_id;
    this.deviceId = res.device_id ?? null;
    return res;
  }

  /**
   * The URL that starts the SSO redirect dance for one identity provider
   * (m.login.sso). null idpId uses the legacy no-idp endpoint.
   */
  ssoLoginUrl(idpId: string | null, redirectUrl: string): string {
    const suffix = idpId ? `/${encodeURIComponent(idpId)}` : "";
    return (
      `${this.baseUrl}${CLIENT_PREFIX}/login/sso/redirect${suffix}` +
      `?redirectUrl=${encodeURIComponent(redirectUrl)}`
    );
  }

  async loginWithPassword(credentials: LoginCredentials): Promise<LoginResult> {
    const username = String(credentials.username ?? "").trim();
    const password = credentials.password ?? "";
    if (!username || !password) {
      throw new Error("Username and password are required");
    }
    const res = await this.api<LoginResult>("POST", `${CLIENT_PREFIX}/login`, {
      auth: false,
      body: {
        type: "m.login.password",
        identifier: { type: "m.id.user", user: username },
        password,
        initial_device_display_name: "Grungus",
      },
    });
    if (!res || !res.access_token) {
      throw new Error("Homeserver returned no access token");
    }
    this.accessToken = res.access_token;
    this.userId = res.user_id;
    this.deviceId = res.device_id ?? null;
    return res;
  }

  /**
   * Probe the homeserver's registration UIA flows (POST /register with an
   * empty body). A 401 is the expected "here are the flows" challenge —
   * its body carries them; a 200 means the server registers without UIA.
   * 403 M_FORBIDDEN means registration is disabled entirely.
   */
  async registrationFlows(): Promise<RegistrationChallenge> {
    try {
      const res = await this.api<{ flows?: RegistrationFlow[] }>(
        "POST",
        `${CLIENT_PREFIX}/register`,
        { auth: false, body: {} }
      );
      return { flows: res.flows ?? [] };
    } catch (err) {
      if (err instanceof HttpError && err.status === 401 && err.body) {
        return {
          flows: (err.body.flows as RegistrationFlow[]) ?? [],
          session: err.body.session as string | undefined,
          params: (err.body.params as Record<string, unknown>) ?? undefined,
        };
      }
      throw err;
    }
  }

  /**
   * Create an account and log in with it (inhibit_login: false — the
   * server returns a fresh session). Satisfies the UIA stages Grungus
   * can do without a browser: m.login.dummy (open registration) and
   * m.login.registration_token (shared-token servers, e.g. conduwuit).
   * Servers demanding recaptcha/terms are declined with a clear message.
   */
  async registerWithPassword(credentials: RegisterCredentials): Promise<LoginResult> {
    const username = String(credentials.username ?? "").trim();
    const password = credentials.password ?? "";
    if (!username || !password) {
      throw new Error("Username and password are required");
    }
    const challenge = await this.registrationFlows();
    const stages = new Set(challenge.flows.flatMap((flow) => flow.stages ?? []));
    let auth: Record<string, unknown>;
    if (stages.size === 0 || stages.has("m.login.dummy")) {
      auth = { type: "m.login.dummy" };
    } else if (stages.has("m.login.registration_token")) {
      const token = credentials.registrationToken?.trim();
      if (!token) {
        throw new Error("This homeserver requires a registration token");
      }
      auth = { type: "m.login.registration_token", registration_token: token };
    } else {
      throw new Error(
        `Unsupported registration flow (${[...stages].join(", ")}) — ` +
          "create the account on your homeserver's website or in Element"
      );
    }
    if (challenge.session) auth.session = challenge.session;
    const res = await this.api<LoginResult>("POST", `${CLIENT_PREFIX}/register`, {
      auth: false,
      body: { username, password, auth, inhibit_login: false },
    });
    if (!res || !res.access_token) {
      throw new Error("Homeserver returned no access token");
    }
    this.accessToken = res.access_token;
    this.userId = res.user_id;
    this.deviceId = res.device_id ?? null;
    return res;
  }

  /**
   * Request a scoped OpenID token for THIS user (used to prove identity to
   * trusted services like the LiveKit token service without handing over
   * the session token).
   */
  async requestOpenIdToken(): Promise<{ access_token: string; matrix_server_name: string }> {
    const userId = this.userId ?? "";
    const res = await this.api<{ access_token?: string; matrix_server_name?: string }>(
      "POST",
      `${CLIENT_PREFIX}/user/${encodeURIComponent(userId)}/openid/request_token`,
      { body: {} }
    );
    if (!res.access_token) throw new Error("homeserver issued no OpenID token");
    return {
      access_token: res.access_token,
      matrix_server_name: res.matrix_server_name ?? "",
    };
  }

  /** Validate an access token; resolves the whoami payload or throws. */
  async whoami(): Promise<{ user_id: string }> {
    const res = await this.api<{ user_id?: string }>(
      "GET",
      `${CLIENT_PREFIX}/account/whoami`
    );
    if (!res || !res.user_id) throw new Error("whoami returned no user_id");
    this.userId = res.user_id;
    return { user_id: res.user_id };
  }

  async getProfile(userId: string): Promise<{ displayname?: string; avatar_url?: string }> {
    return this.api(
      "GET",
      `${CLIENT_PREFIX}/profile/${encodeURIComponent(userId)}`,
      { auth: false }
    );
  }

  async logout(): Promise<void> {
    this.stopSync();
    await this.api("POST", `${CLIENT_PREFIX}/logout`, { body: {} }).catch(() => {
      /* best effort — the token is being discarded anyway */
    });
    this.clearMediaCache();
    this.accessToken = null;
    this._since = null;
  }

  /* -------------------------------- sync --------------------------------- */

  startSync(): this {
    if (this._syncRunning) return this;
    this._syncRunning = true;
    this._stopped = false;
    this.connectionState = "connecting";
    this.emit("connection", "connecting");

    const step = async (): Promise<void> => {
      while (!this._stopped) {
        const ctrl = (this._syncAbort = new AbortController());
        const query: Record<string, string | number> = { timeout: SYNC_TIMEOUT_MS };
        if (this._since) query.since = this._since;
        try {
          const data = await this.api<SyncResponse>(
            "GET",
            `${CLIENT_PREFIX}/sync`,
            {
              query,
              timeoutMs: SYNC_TIMEOUT_MS + 20_000,
              signal: ctrl.signal,
            }
          );
          if (this._stopped) break;
          this._backoffMs = 0;
          this.connectionState = "online";
          this.emit("connection", "online");
          /* process BEFORE advancing the token: a throw mid-batch must not
             permanently skip events */
          this._applySync(data);
          this._since = data.next_batch || this._since;
          if (!this._readyEmitted) {
            this._readyEmitted = true;
            this.emit("ready");
          }
          this.emit("sync");
        } catch (err) {
          if (this._stopped) break;
          if (err instanceof HttpError && err.status === 401) {
            this._stopped = true;
            this.connectionState = "auth-error";
            this.emit("auth-error", err);
            break;
          }
          this.connectionState = "offline";
          this.emit("connection", "offline");
          this.emit("error", err);
          this._backoffMs = Math.min(
            this._backoffMs ? this._backoffMs * 2 : 2_000,
            MAX_BACKOFF_MS
          );
          await sleep(this._backoffMs);
        }
      }
      this._syncRunning = false;
    };
    void step();
    return this;
  }

  stopSync(): void {
    this._stopped = true;
    this._syncAbort?.abort();
    this.connectionState = "stopped";
  }

  /* ------------------------- account & profile ---------------------------- */

  /**
   * Set the display name (PUT /profile/{userId}/displayname). Other
   * devices see the change via the next profile fetch.
   */
  async setDisplayName(name: string): Promise<void> {
    await this.api(
      "PUT",
      `${CLIENT_PREFIX}/profile/${encodeURIComponent(this.userId ?? "")}/displayname`,
      { body: { displayname: name } }
    );
  }

  /** Set the avatar (PUT /profile/{userId}/avatar_url) from an mxc URI. */
  async setAvatarUrl(mxc: string): Promise<void> {
    await this.api(
      "PUT",
      `${CLIENT_PREFIX}/profile/${encodeURIComponent(this.userId ?? "")}/avatar_url`,
      { body: { avatar_url: mxc } }
    );
  }

  /**
   * Change the account password (POST /account/password). UIA: the
   * server challenges with m.login.password; the CURRENT password is
   * used once for the challenge and never stored. When logoutDevices is
   * true every other session is logged out (Element's wording).
   */
  async changePassword(
    currentPassword: string,
    newPassword: string,
    logoutDevices: boolean
  ): Promise<void> {
    const base = {
      new_password: newPassword,
      logout_devices: logoutDevices,
    };
    const authBody = {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: this.userId ?? "" },
      password: currentPassword,
    };
    try {
      await this.api("POST", `${CLIENT_PREFIX}/account/password`, { body: base });
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 401) throw err;
      const challenge = err.body as { session?: string } | null;
      await this.api("POST", `${CLIENT_PREFIX}/account/password`, {
        body: {
          ...base,
          auth: {
            ...authBody,
            ...(challenge?.session ? { session: challenge.session } : {}),
          },
        },
      });
    }
  }

  /** All sessions/devices of the account (GET /devices). */
  async getDevices(): Promise<
    { deviceId: string; displayName: string | null; lastSeenTs: number | null; lastSeenIp: string | null }[]
  > {
    const res = await this.api<{ devices?: { device_id: string; display_name?: string | null; last_seen_ts?: number; last_seen_ip?: string }[] }>(
      "GET",
      `${CLIENT_PREFIX}/devices`
    );
    return (res.devices ?? []).map((d) => ({
      deviceId: d.device_id,
      displayName: d.display_name ?? null,
      lastSeenTs: d.last_seen_ts ?? null,
      lastSeenIp: d.last_seen_ip ?? null,
    }));
  }

  /** Rename one of our devices (PUT /devices/{deviceId}). */
  async setDeviceName(deviceId: string, name: string): Promise<void> {
    await this.api(
      "PUT",
      `${CLIENT_PREFIX}/devices/${encodeURIComponent(deviceId)}`,
      { body: { display_name: name } }
    );
  }

  /**
   * Log out other devices (POST /delete_devices). UIA with the account
   * password, same one-shot pattern as changePassword.
   */
  async deleteDevices(deviceIds: string[], authPassword: string): Promise<void> {
    const base = { devices: deviceIds };
    const authBody = {
      type: "m.login.password",
      identifier: { type: "m.id.user", user: this.userId ?? "" },
      password: authPassword,
    };
    try {
      await this.api("POST", `${CLIENT_PREFIX}/delete_devices`, { body: base });
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 401) throw err;
      const challenge = err.body as { session?: string } | null;
      await this.api("POST", `${CLIENT_PREFIX}/delete_devices`, {
        body: {
          ...base,
          auth: {
            ...authBody,
            ...(challenge?.session ? { session: challenge.session } : {}),
          },
        },
      });
    }
  }

  /** The ignored-users list (m.ignored_user_list account data). */
  getIgnoredUsers(): string[] {
    const content = this.getAccountData("m.ignored_user_list");
    if (!content || typeof content.ignored_users !== "object" || !content.ignored_users) {
      return [];
    }
    return Object.keys(content.ignored_users as Record<string, unknown>);
  }

  /** Stop ignoring a user (rewrites m.ignored_user_list without them). */
  async unignoreUser(userId: string): Promise<void> {
    const remaining: Record<string, unknown> = {};
    for (const id of this.getIgnoredUsers()) {
      if (id !== userId) remaining[id] = {};
    }
    await this.setAccountData("m.ignored_user_list", { ignored_users: remaining });
  }

  /* ----------------------------- account data ---------------------------- */

  /** Latest account data content for a type (from sync), or null. */
  getAccountData(type: string): Record<string, unknown> | null {
    return this._accountData.get(type) ?? null;
  }

  /** Set account data for the current user. */
  async setAccountData(type: string, content: Record<string, unknown>): Promise<void> {
    await this.api(
      "PUT",
      `${CLIENT_PREFIX}/user/${encodeURIComponent(this.userId ?? "")}/account_data/${encodeURIComponent(type)}`,
      { body: content }
    );
    this._accountData.set(type, content);
  }

  /* --------------------------- key signing upload ------------------------- */

  /**
   * Publish cross-signing keys (POST /keys/device_signing/upload). Some
   * homeservers (Synapse, conduwuit) protect this with UIA — when the
   * server answers 401 with an m.login.password flow, the account
   * password is required; it is used once and never stored.
   */
  async uploadDeviceSigningKeys(
    payload: Record<string, unknown>,
    authPassword?: string
  ): Promise<{ uiaRequired: boolean }> {
    try {
      await this.api("POST", `${CLIENT_PREFIX}/keys/device_signing/upload`, {
        body: payload,
      });
      return { uiaRequired: false };
    } catch (err) {
      if (!(err instanceof HttpError) || err.status !== 401 || !authPassword) {
        throw err;
      }
      /* UIA challenge: retry with the password flow */
      const challenge = err.body as { session?: string } | null;
      await this.api("POST", `${CLIENT_PREFIX}/keys/device_signing/upload`, {
        body: {
          auth: {
            type: "m.login.password",
            identifier: { type: "m.id.user", user: this.userId ?? "" },
            password: authPassword,
            ...(challenge?.session ? { session: challenge.session } : {}),
          },
          ...payload,
        },
      });
      return { uiaRequired: false };
    }
  }

  /** Publish signatures over keys/devices (POST /keys/signatures/upload). */
  async uploadKeySignatures(
    payload: Record<string, Record<string, unknown>>
  ): Promise<void> {
    await this.api("POST", `${CLIENT_PREFIX}/keys/signatures/upload`, {
      body: payload,
    });
  }

  /* ----------------------------- spaces --------------------------------- */

  /** Add a room to a space (m.space.child state on the space room). */
  async addToSpace(spaceId: string, childRoomId: string): Promise<void> {
    /* the via server: our user id's homeserver part */
    const via = (this.userId ?? "").split(":")[1] ?? "localhost";
    await this.sendStateEvent(spaceId, "m.space.child", childRoomId, { via: [via] });
  }

  /** Remove a room from a space (empty m.space.child content). */
  async removeFromSpace(spaceId: string, childRoomId: string): Promise<void> {
    await this.sendStateEvent(spaceId, "m.space.child", childRoomId, {});
  }

  /* --------------------------- sync processing --------------------------- */

  private _ensureRoom(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = createRoomRecord(roomId);
      this.rooms.set(roomId, room);
    }
    return room;
  }

  /** Page backward without changing current room state or replaying historical calls. */
  async loadOlderMessages(roomId: string): Promise<void> {
    return this._history.loadOlderMessages(roomId);
  }

  /** Return from an older bounded window to the server's current timeline. */
  async loadLatestMessages(roomId: string): Promise<void> {
    return this._history.loadLatestMessages(roomId);
  }

  /**
   * Retry tracked undecryptable events (called when a forwarded room key
   * lands). Decrypted events replace their "unable to decrypt" system line
   * in place; the room update carries redraw so the view re-renders.
   */
  retryUndecrypted(roomId: string): void {
    return this._timeline.retryUndecrypted(roomId);
  }

  private _applySync(data: SyncResponse): void {
    /* account data (cross-signing keys, etc.) */
    let directMapChanged = false;
    for (const ev of data.account_data?.events ?? []) {
      if (ev.type && ev.content && typeof ev.content === "object") {
        this._accountData.set(ev.type, ev.content);
        if (ev.type === "m.direct") directMapChanged = true;
      }
    }
    /* to-device first: room keys must be processed before encrypted room
       events arriving in the same sync batch are handled. A crypto error
       must never abort room processing. */
    if (this.crypto || this.onToDevice) {
      try {
        const toDevice = data.to_device?.events ?? [];
        for (const event of toDevice) {
          if (event.type === "m.room.encrypted") continue; /* handled by crypto */
          /* Element mobile (matrix-rust-rtc) key transport:
             org.matrix.msc4143.rtc.encryption_key with a single media_key */
          if (
            event.type === "org.matrix.msc4143.rtc.encryption_key" ||
            event.type === "m.rtc.encryption_key"
          ) {
            this._rtc.handleToDeviceKeys(event);
            continue;
          }
          /* Element's rust stack sends verification REQUEST/READY/DONE/CANCEL
             as PLAINTEXT to-device events (only start/accept/key/mac ride
             olm) — surface those to the verification layer too */
          if (
            (event.type.startsWith("m.key.verification.") ||
              event.type.startsWith("m.verification.")) &&
            this.crypto
          ) {
            this.crypto.handlePlainToDevice(
              event.sender ?? "",
              event.type,
              (event.content ?? {}) as Record<string, unknown>
            );
            continue;
          }
          this.onToDevice?.(event);
        }
        if (this.crypto) {
          /* crypto filters internally: olm events, key requests */
          this.crypto.onToDeviceEvents(toDevice);
          const keyCounts = data.device_one_time_keys_count;
          if (keyCounts) void this.crypto.onOneTimeKeyCounts(keyCounts).catch(error => {
            if (!this._stopped) this.emit("error", error);
          });
          const changed = data.device_lists?.changed;
          if (changed && changed.length > 0) this.crypto.onDeviceListChange(changed);
        }
      } catch (err) {
        console.error("[grungus] crypto sync handling failed:", err);
      }
    }

    const joined = data.rooms?.join ?? {};
    const changedRooms: RoomUpdate[] = [];

    /* rooms we LEFT (from this or another device): delete locally. The
       server keeps sending them in the join/leave sections otherwise. */
    for (const leftRoomId of Object.keys(data.rooms?.leave ?? {})) {
      if (this.rooms.has(leftRoomId)) this._dropRoom(leftRoomId);
      else this._leftRooms.add(leftRoomId);
    }

    for (const [roomId, rd] of Object.entries(joined)) {
      if (this._leftRooms.has(roomId)) continue; /* deleted here — ignore */
      const room = this._ensureRoom(roomId);
      const newEvents: RoomEvent[] = [];
      const { limited, recoverGap } = this._history.beginSync(room, rd.timeline);
      let relationChanged = limited;

      for (const ev of rd.state?.events ?? []) {
        applyStateEvent(room, ev);
      }

      for (const ev of rd.timeline?.events ?? []) {
        if (!ev || typeof ev !== "object") continue;
        const evId = ev.event_id;
        if (evId) {
          if (this._seen.has(evId)) continue;
          this._seen.add(evId);
          if (this._seen.size > 20_000) this._seen.delete(this._seen.values().next().value!);
        }
        if (ev.state_key !== undefined) applyStateEvent(room, ev);
        /* key rotation on membership transitions in encrypted rooms: a
            fresh member (prev not "join" → join) must not read history, a
           departing one (join → not join) must not read the future. Both
           discard the outbound megolm session so the next send shares a
           fresh one. Initial-sync state never passes through here, so
           there are no spurious rotations at startup. */
        if (
          room.isEncrypted &&
          this.crypto &&
          ev.type === "m.room.member" &&
          typeof ev.state_key === "string"
        ) {
          const prev = ev.unsigned?.prev_content?.membership;
          const next =
            typeof ev.content?.membership === "string" ? ev.content.membership : "";
          const prevJoin = prev === "join";
          const nextJoin = next === "join";
          if (prevJoin !== nextJoin) {
            void this.crypto
              .discardOutboundSession(room.id)
              .catch((err) => console.error("[grungus] rotation failed:", err));
          }
        }
        if (evId && this._messaging.acknowledged.has(evId)) {
          const echoTxn = this._messaging.acknowledged.get(evId)!;
          this._timeline.removeEcho(room, echoTxn);
          this._messaging.acknowledged.delete(evId);
          newEvents.push({ kind: "echo-replaced", txnId: echoTxn });
        }
        const decrypted = room.isEncrypted && ev.type === "m.room.encrypted" && this.crypto
          ? this.crypto.decryptRoomEvent(ev) : null;
        const relationEvent = decrypted ? { ...ev, type: decrypted.type, content: decrypted.content } : ev;
        const item = decrypted ? this._timeline.toItem(room, relationEvent)
          : room.isEncrypted && ev.type === "m.room.encrypted"
            ? this.crypto ? this._timeline.decryptItem(room, ev) : {
                kind: "system" as const, id: ev.event_id ?? null,
                ts: ev.origin_server_ts ?? Date.now(), text: "🔒 Unable to decrypt (E2EE unavailable)",
              }
            : this._timeline.toItem(room, ev);
        this._history.rememberRelation(room, relationEvent, item);
        if (item) {
          /* relation processing: edits, reactions, replies, redactions.
             Returns true when the event is fully handled as a relation
             (edit/reaction/redaction) and must NOT become a new
             timeline item. */
          const handled = applyRelations(room, relationEvent, item);
          if (handled) {
            relationChanged = true;
          } else {
            if (room.atLiveEdge !== false) room.timeline.push(item);
            this._history.recordArrival(roomId, item);
            newEvents.push(item);
          }
        } else {
          /* events that produce no timeline item may still carry relations */
          if (applyRelations(room, relationEvent, null)) {
            relationChanged = true;
          }
        }
      }

      if (rd.summary?.["m.joined_member_count"] != null) {
        room.summaryJoinedCount = rd.summary["m.joined_member_count"];
      }

      /* ephemeral: typing notifications */
      const typingEvent = rd.ephemeral?.events?.find((event) => event.type === "m.typing");
      if (typingEvent) {
        const raw = (typingEvent.content as { user_ids?: unknown }).user_ids;
        const typingUsers = Array.isArray(raw)
          ? (raw as string[]).filter((userId) => userId !== this.userId)
          : [];
        const typingChanged =
          typingUsers.length !== room.typingUsers.length ||
          typingUsers.some((userId) => !room.typingUsers.includes(userId));
        room.typingUsers = typingUsers;
        if (typingChanged) changedRooms.push({ room, newEvents: [] });
      }

      /* ephemeral: other users' read receipts (m.receipt) —
         content = { [eventId]: { "m.read": { [userId]: { ts } } } } */
      const receiptEvent = rd.ephemeral?.events?.find((event) => event.type === "m.receipt");
      if (receiptEvent && receiptEvent.content && typeof receiptEvent.content === "object") {
        let receiptsChanged = false;
        for (const [eventId, byType] of Object.entries(
          receiptEvent.content as Record<string, Record<string, Record<string, { ts?: number }>>>
        )) {
          const reads = byType?.["m.read"];
          if (!reads) continue;
          for (const [userId, meta] of Object.entries(reads)) {
            if (userId === this.userId) continue;
            const ts = typeof meta?.ts === "number" ? meta.ts : Date.now();
            const prev = room.readReceipts.get(userId);
            if (!prev || prev.eventId !== eventId || prev.ts !== ts) {
              room.readReceipts.set(userId, { eventId, ts });
              receiptsChanged = true;
            }
          }
        }
        if (receiptsChanged) changedRooms.push({ room, newEvents: [] });
      }

      /* room-scoped account data: the m.fully_read read marker */
      for (const ev of rd.account_data?.events ?? []) {
        if (
          ev.type === "m.fully_read" &&
          ev.content &&
          typeof ev.content.event_id === "string"
        ) {
          room.fullyReadEventId = ev.content.event_id;
        }
      }

      if (rd.unread_notifications?.notification_count != null) {
        room.serverNotifications = rd.unread_notifications.notification_count;
      }

      resolveRoomMeta(room, this.userId, this.getAccountData("m.direct"));

      if (newEvents.length > 0) {
        const last = newEvents[newEvents.length - 1]!;
        if ("ts" in last && typeof last.ts === "number") {
          room.lastActivityTs = last.ts || room.lastActivityTs;
        }
      }

      if (
        this._readyEmitted &&
        this._selectedRoomId !== roomId &&
        newEvents.some((e) => e.kind === "message")
      ) {
        let msgCount = 0;
        for (const e of newEvents) if (e.kind === "message") msgCount++;
        room.unread = Math.min(room.unread + msgCount, 99);
      }

      if (this._history.trimLiveTimeline(room)) relationChanged = true;
      changedRooms.push({ room, newEvents, redraw: relationChanged ? true : undefined });
      if (recoverGap && room.historyCursor) {
        void this.loadOlderMessages(roomId).catch(error => this.emit("error", error));
      }
    }

    /* the m.direct map changed: DM flags may have flipped — re-resolve
       every room's metadata and notify */
    if (directMapChanged) {
      for (const room of this.rooms.values()) {
        const wasDirect = room.isDirect;
        const wasPeer = room.directUserId;
        resolveRoomMeta(room, this.userId, this.getAccountData("m.direct"));
        if (room.isDirect !== wasDirect || room.directUserId !== wasPeer) {
          changedRooms.push({ room, newEvents: [] });
        }
      }
    }

    for (const update of changedRooms) {
      this.emit("room", update);
    }
    if (changedRooms.length > 0) {
      this.emit("rooms", this.getRooms());
    }

    /* rooms we are invited to (rooms.invite) */
    const invited = data.rooms?.invite ?? {};
    let invitesChanged = false;
    for (const [roomId, rd] of Object.entries(invited)) {
      if (this.rooms.has(roomId)) {
        /* already joined via this or an earlier sync */
        if (this.invites.delete(roomId)) invitesChanged = true;
        continue;
      }
      let name: string | null = null;
      let inviterId: string | null = null;
      let isEncrypted = false;
      let isSpace = false;
      let stillInvited = false;
      for (const ev of rd.invite_state?.events ?? []) {
        if (ev.type === "m.room.name" && typeof ev.content?.name === "string") {
          name = ev.content.name;
        } else if (ev.type === "m.room.encryption") {
          isEncrypted = true;
        } else if (
          ev.type === "m.room.create" &&
          ev.content?.type === "m.space"
        ) {
          isSpace = true;
        } else if (
          ev.type === "m.room.member" &&
          ev.state_key === this.userId
        ) {
          if (ev.content?.membership === "invite") {
            stillInvited = true;
            inviterId = ev.sender;
          }
        }
      }
      if (!stillInvited) {
        /* revoked: our membership in the stripped state is no longer invite */
        if (this.invites.delete(roomId)) invitesChanged = true;
        continue;
      }
      const existingInvite = this.invites.get(roomId);
      const nextInvite: InvitedRoom = { id: roomId, name, inviterId, isEncrypted, isSpace };
      if (
        !existingInvite ||
        existingInvite.name !== name ||
        existingInvite.inviterId !== inviterId
      ) {
        this.invites.set(roomId, nextInvite);
        invitesChanged = true;
      }
    }
    /* invites whose room became joined (rooms.join) are consumed above or by
       accept; never drop an invite merely because a sync omitted the
       section — incremental syncs omit unchanged data. */
    for (const roomId of [...this.invites.keys()]) {
      if (this.rooms.has(roomId)) {
        this.invites.delete(roomId);
        invitesChanged = true;
      }
    }
    if (invitesChanged) {
      this.emit("invites", this.getInvites());
    }
  }

  /* --------------------------- room operations --------------------------- */

  /**
   * Mark a room as read: clears the local unread, sends a public
   * m.read receipt (what others see) and the m.fully_read marker
   * (notification state). Fire-and-forget on the wire.
   */
  markRoomRead(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) room.unread = 0;
    this._selectedRoomId = roomId;
    void this._sendReadMarkers(roomId).catch((err) =>
      console.warn("[grungus] read markers failed:", err)
    );
  }

  /** The latest message event id in a room's timeline (null if none). */
  latestTimelineEventId(roomId: string): string | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    for (let i = room.timeline.length - 1; i >= 0; i--) {
      const item = room.timeline[i]!;
      if (item.kind === "message" && item.id) return item.id;
    }
    return null;
  }

  /**
   * True when the user's read receipt covers the given event (their
   * receipt is the event itself or a LATER timeline entry).
   */
  receiptCoversEvent(roomId: string, userId: string, eventId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    const receipt = room.readReceipts.get(userId);
    if (!receipt) return false;
    if (receipt.eventId === eventId) return true;
    /* compare by timeline position */
    let receiptIdx = -1;
    let eventIdx = -1;
    room.timeline.forEach((item, idx) => {
      if (item.kind !== "message") return;
      if (item.id === receipt.eventId) receiptIdx = idx;
      if (item.id === eventId) eventIdx = idx;
    });
    return receiptIdx >= 0 && eventIdx >= 0 && receiptIdx >= eventIdx;
  }

  /** POST a public m.read receipt for the latest read event. */
  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    await this.api(
      "POST",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
      { body: {} }
    );
  }

  /** Set room-scoped account data (the m.fully_read marker lives here). */
  async setRoomAccountData(
    roomId: string,
    type: string,
    content: Record<string, unknown>
  ): Promise<void> {
    await this.api(
      "PUT",
      `${CLIENT_PREFIX}/user/${encodeURIComponent(this.userId ?? "")}/rooms/${encodeURIComponent(roomId)}/account_data/${encodeURIComponent(type)}`,
      { body: content }
    );
  }

  private async _sendReadMarkers(roomId: string): Promise<void> {
    const eventId = this.latestTimelineEventId(roomId);
    if (!eventId) return;
    await this.sendReadReceipt(roomId, eventId);
    await this.setRoomAccountData(roomId, "m.fully_read", { event_id: eventId });
  }

  clearSelectedRoom(): void {
    this._selectedRoomId = null;
  }

  private _encryptionForRoom(roomId: string): boolean | undefined {
    // A partially-created room can arrive in sync before its encryption state.
    if (this._pendingEncryption.get(roomId) === true) return true;
    return this.rooms.get(roomId)?.isEncrypted ?? this._pendingEncryption.get(roomId);
  }

  /**
   * Send a text message with a local echo. The echo is removed and replaced
   * by the server event when /sync delivers it.
   */
  async sendMessage(roomId: string, body: string): Promise<string | null> {
    return this._messaging.sendMessage(roomId, body);
  }

  /* ------------------------- media keys (calls) ------------------------- */

  /**
   * Subscribe to other participants' media-encryption keys (Element-style
   * io.element.call.encryption_keys room events + rust to-device
   * org.matrix.msc4143.rtc.encryption_key). Returns an unsubscribe function.
   */
  onMediaKeys(cb: (keys: MediaKeysEvent) => void): () => void {
    return this._rtc.onKeys(cb);
  }

  /**
   * Send a non-message room event (e.g. io.element.call.encryption_keys).
   * Megolm-encrypted when the room is — the same fail-closed rules as
   * sendMessage. Returns the server event id.
   */
  async sendRoomEvent(
    roomId: string,
    type: string,
    content: Record<string, unknown>
  ): Promise<string | null> {
    return this._messaging.sendRoomEvent(roomId, type, content);
  }

  async createRoom(opts: CreateRoomOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      name: opts.name ?? "",
      preset: opts.isPublic ? "public_chat" : "private_chat",
    };
    if (opts.topic) body.topic = opts.topic;
    if (opts.isSpace) body.creation_content = { type: "m.space" };
    if (opts.encrypted) {
      body.initial_state = [
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ];
    }
    /* MSC3401 calls: every member must be able to publish their call
       membership state — grant m.call.member at power level 0 (the same
       thing Element Call does for call rooms). */
    body.power_level_content_override = {
      events: { "m.call.member": 0 },
    };
    const res = await this.api<{ room_id?: string }>(
      "POST",
      `${CLIENT_PREFIX}/createRoom`,
      { body }
    );
    if (!res?.room_id) throw new Error("createRoom returned no room_id");

    /* remember the encryption flag we asked for: a send racing ahead of the
       first sync must never leak plaintext into a room created encrypted */
    this._pendingEncryption.set(res.room_id, opts.encrypted === true);
    return res.room_id;
  }

  async joinRoom(roomIdOrAlias: string): Promise<string> {
    const res = await this.api<{ room_id?: string }>(
      "POST",
      `${CLIENT_PREFIX}/join/${encodeURIComponent(roomIdOrAlias)}`,
      { body: {} }
    );
    const roomId = res?.room_id ?? roomIdOrAlias;

    /* probe the encryption state as part of the join so sends racing the
       first sync still encrypt correctly */
    if (!this.rooms.has(roomId) && !this._pendingEncryption.has(roomId)) {
      try {
        const state = await this.api<{ algorithm?: string }>(
          "GET",
          `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`
        );
        this._pendingEncryption.set(roomId, typeof state.algorithm === "string");
      } catch {
        /* state unreadable — leave unknown; sends fail closed */
      }
    }
    return roomId;
  }

  async invite(roomId: string, userId: string): Promise<void> {
    await this.api(
      "POST",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/invite`,
      { body: { user_id: userId } }
    );
  }

  /** Leave a room (also used to decline an invite). */
  async leaveRoom(roomId: string): Promise<void> {
    await this.api(
      "POST",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/leave`,
      { body: {} }
    );
  }

  /**
   * Rooms this user has left (here or from another device). Sync entries
   * for these are ignored — a leave must never resurrect a deleted chat.
   */
  private readonly _leftRooms = new Set<string>();

  /**
   * Delete a chat: leave it on the server and drop it locally. The room
   * vanishes from the list immediately; the ignore set keeps the next
   * sync (which carries the leave event) from re-adding it.
   */
  async deleteRoom(roomId: string): Promise<void> {
    await this.leaveRoom(roomId);
    this._dropRoom(roomId);
  }

  /** Remove a room locally and notify. */
  private _dropRoom(roomId: string): void {
    this._leftRooms.add(roomId);
    this.rooms.delete(roomId);
    this._timeline.clear(roomId);
    this._history.dropRoom(roomId);
    this._pendingEncryption.delete(roomId);
    this.clearMediaCache();
    this.invites.delete(roomId);
    this.emit("room-deleted", roomId);
    this.emit("rooms", this.getRooms());
  }

  /** Accept a pending invite by joining the room. */
  async acceptInvite(roomId: string): Promise<void> {
    await this.joinRoom(roomId);
    if (this.invites.delete(roomId)) {
      this.emit("invites", this.getInvites());
    }
  }

  /** Decline a pending invite (leave without joining). */
  async declineInvite(roomId: string): Promise<void> {
    await this.leaveRoom(roomId);
    if (this.invites.delete(roomId)) {
      this.emit("invites", this.getInvites());
    }
  }

  /** Send/overwrite a room state event (e.g. m.call.member). */
  async sendStateEvent(
    roomId: string,
    type: string,
    stateKey: string,
    content: Record<string, unknown>
  ): Promise<string | null> {
    return this._messaging.sendStateEvent(roomId, type, stateKey, content);
  }

  /** Send a plaintext to-device message to one device. */
  async sendToDevice(
    targetUserId: string,
    targetDeviceId: string,
    type: string,
    content: Record<string, unknown>
  ): Promise<void> {
    return this._messaging.sendToDevice(targetUserId, targetDeviceId, type, content);
  }

  /** Upload raw bytes to the media store; resolves the mxc:// URI. */
  async uploadMedia(
    filename: string,
    mimeType: string,
    bytes: Uint8Array
  ): Promise<string> {
    return this._media.uploadMedia(filename, mimeType, bytes);
  }

  /** Upload attachments only after resolving room encryption, before any bytes leave the device. */
  async uploadAndSendMedia(roomId: string, name: string, mimeType: string, bytes: Uint8Array, dimensions: { width?: number; height?: number } = {}): Promise<string | null> {
    return this._messaging.uploadAndSendMedia(roomId, name, mimeType, bytes, dimensions);
  }

  /**
   * Send an image (m.image) — megolm-encrypted in encrypted rooms (the
   * mxc URI is then only visible to room members). Echoes locally with
   * media metadata so it renders instantly.
   */
  async sendMedia(
    roomId: string,
media: MediaMessage
  ): Promise<string | null> {
    return this._messaging.sendMedia(roomId, media);
  }

  /* --------------------------- message relations -------------------------- */

  /** Edit one of your own messages (sends m.replace). */
  async editMessage(roomId: string, eventId: string, newBody: string): Promise<string | null> {
    return this._messaging.editMessage(roomId, eventId, newBody);
  }

  /** React to a message with an emoji (m.reaction / m.annotation). */
  async sendReaction(roomId: string, targetEventId: string, emoji: string): Promise<string | null> {
    return this._messaging.sendReaction(roomId, targetEventId, emoji);
  }

  /** Redact (remove) an event — used to remove your own reaction. */
  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<void> {
    return this._messaging.redactEvent(roomId, eventId, reason);
  }

  /** Reply to a message (m.in_reply_to). */
  async replyMessage(
    roomId: string,
    parentEventId: string,
    parentSender: string,
    parentBody: string,
    body: string
  ): Promise<string | null> {
    return this._messaging.replyMessage(roomId, parentEventId, parentSender, parentBody, body);
  }

  /** Publish (or clear) typing state for the current user in a room. */
  async setTyping(
    roomId: string,
    typing: boolean,
    timeoutMs = 30_000
  ): Promise<void> {
    return this._messaging.setTyping(roomId, typing, timeoutMs);
  }

  /* ------------------------------- queries ------------------------------- */

  /** Joined rooms (spaces excluded), most recently active first. */
  getRooms(): Room[] {
    return [...this.rooms.values()]
      .filter((room) => !room.isSpace)
      .sort((a, b) => b.lastActivityTs - a.lastActivityTs);
  }

  /** Joined spaces (m.space rooms). */
  getSpaces(): Room[] {
    return [...this.rooms.values()].filter((room) => room.isSpace);
  }

  /** Rooms with a pending invite. */
  getInvites(): InvitedRoom[] {
    return [...this.invites.values()];
  }

  getRoom(roomId: string): Room | null {
    return this.rooms.get(roomId) ?? null;
  }

  /* -------------------------------- media -------------------------------- */

  clearMediaCache(): void {
    return this._media.clearMediaCache();
  }

  /**
   * Resolve an mxc:// avatar URI to a displayable thumbnail URL. Fetches
   * through the authenticated-media path (Bearer header) and caches blobs,
   * so it works against homeservers that require authenticated media
   * (e.g. matrix.org) as well as open ones.
   */
  async avatarSrc(mxc: string | null | undefined, size = 64): Promise<string | null> {
    return this._media.avatarSrc(mxc, size);
  }

  /**
   * Resolve an mxc:// media URI (images, GIFs) to an object URL via the
   * authenticated download endpoint. GIFs animate natively once rendered in
   * an <img>; the blob cache dedupes repeat renders.
   */
  async mediaSrc(mxc: string | null | undefined, file?: EncryptedFile, mimeType = "application/octet-stream"): Promise<string | null> {
    return this._media.mediaSrc(mxc, file, mimeType);
  }
}
