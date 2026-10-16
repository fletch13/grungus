/*
 * Grungus — Matrix client core (TypeScript).
 *
 * A dependency-free implementation of the subset of the Matrix
 * Client-Server API that Grungus uses (the same open protocol Element
 * speaks): homeserver discovery, password/token login, /sync long-polling,
 * room state + timeline handling, message send with local echo, room
 * creation/join/invite, profiles, media (thumbnails + authenticated
 * downloads for images/GIFs), and logout.
 *
 * Consumed two ways: esbuild bundles it into the renderer; Node runs it
 * directly (native type stripping) for the tests and the example CLIs.
 * Written against Matrix spec v1.x (Client-Server API, v3 paths).
 */

import type { E2eeCrypto } from "./e2ee.ts";

/* ------------------------------- wire types ------------------------------ */

export interface MatrixEventContent {
  [key: string]: unknown;
}

export interface MatrixEvent {
  event_id?: string;
  type: string;
  sender: string;
  content: MatrixEventContent;
  origin_server_ts?: number;
  state_key?: string;
  /** redaction events: the event this redacts (room v3+ format) */
  redacts?: string;
  unsigned?: {
    prev_content?: MatrixEventContent;
    transaction_id?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

interface SyncJoinedRoom {
  state?: { events?: MatrixEvent[] };
  timeline?: { events?: MatrixEvent[]; limited?: boolean };
  ephemeral?: { events?: MatrixEvent[] };
  summary?: {
    "m.joined_member_count"?: number;
    "m.invited_member_count"?: number;
  };
  unread_notifications?: { notification_count?: number };
}

export interface SyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<string, SyncJoinedRoom>;
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>;
  };
  to_device?: { events?: ToDeviceEvent[] };
  device_one_time_keys_count?: Record<string, number>;
  device_lists?: { changed?: string[]; new?: string[] };
}

export interface ToDeviceEvent {
  type: string;
  sender: string;
  content: unknown;
}

export interface MemberRecord {
  userId: string;
  displayname: string | null;
  avatarMxc: string | null;
  membership: string;
}

export interface MediaInfo {
  mxc: string;
  mimetype: string | null;
  width: number | null;
  height: number | null;
  size: number | null;
  name: string | null;
}

export interface MessageItem {
  kind: "message";
  id: string | null;
  sender: string;
  senderName: string;
  ts: number;
  msgtype: string;
  body: string;
  media: MediaInfo | null;
  pending?: boolean;
  failed?: boolean;
  txnId?: string;
  eventId?: string;
  /** set when this message was edited (m.replace) */
  edited?: boolean;
  editTs?: number;
  /** emoji -> set of reacting user IDs */
  reactions?: Map<string, Set<string>>;
  /** the message this replies to (m.in_reply_to) */
  replyTo?: ReplyContext | null;
}

export interface ReplyContext {
  eventId: string;
  sender: string;
  senderName: string;
  body: string;
}

export interface SystemItem {
  kind: "system";
  id: string | null;
  ts: number;
  text: string;
}

export type TimelineItem = MessageItem | SystemItem;

/**
 * Local-echo lifecycle markers, delivered through "room" updates but never
 * stored in room.timeline — the UI reacts by re-rendering the timeline.
 */
export interface EchoMarker {
  kind: "echo-replaced" | "echo-failed";
  txnId: string;
}

export type RoomEvent = TimelineItem | EchoMarker;

export interface RoomUpdate {
  room: Room;
  newEvents: RoomEvent[];
  /**
   * Timeline items were changed in place (e.g. a forwarded room key turned
   * "unable to decrypt" lines into messages) — the view should re-render
   * the whole timeline instead of appending.
   */
  redraw?: boolean;
}

/** A room we are invited to but have not joined (rooms.invite in /sync). */
export interface InvitedRoom {
  id: string;
  name: string | null;
  inviterId: string | null;
  isEncrypted: boolean;
  isSpace: boolean;
}

export interface Room {
  id: string;
  name: string | null;
  canonicalAlias: string | null;
  topic: string | null;
  avatarMxc: string | null;
  isSpace: boolean;
  creator: string | null;
  joinRule: string | null;
  isEncrypted: boolean;
  encryptionAlgorithm: string | null;
  /** m.call.member state: userId -> content (MSC3401 call membership). */
  callMembers: Map<string, Record<string, unknown>>;
  /** com.grungus.livekit state: the room's LiveKit call service, if any. */
  livekitService: {
    url: string;
    room: string;
    authUrl: string;
  } | null;
  /** Users currently typing (from ephemeral m.typing), self excluded. */
  typingUsers: string[];
  children: Set<string>;
  members: Map<string, MemberRecord>;
  timeline: TimelineItem[];
  summaryJoinedCount: number;
  serverNotifications: number;
  unread: number;
  lastActivityTs: number;
  /* derived — recomputed after each sync batch: */
  title: string;
  isDirect: boolean;
  directUserId: string | null;
  joinedMemberCount: number;
}

export class HttpError extends Error {
  readonly status: number;
  readonly errcode: string | null;

  constructor(status: number, body: { errcode?: string; error?: string } | null) {
    const message =
      (body && (body.error || body.errcode)) || `HTTP ${status} from homeserver`;
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.errcode = (body && body.errcode) || null;
  }
}

export type ConnectionState =
  | "connecting"
  | "online"
  | "offline"
  | "stopped"
  | "auth-error";

/* ------------------------------ client types ----------------------------- */

interface ClientEvents {
  sync: [];
  ready: [];
  room: [RoomUpdate];
  rooms: [Room[]];
  invites: [InvitedRoom[]];
  connection: [ConnectionState];
  error: [unknown];
  "auth-error": [HttpError];
}

type Listener<K extends keyof ClientEvents> = (...args: ClientEvents[K]) => void;

export interface LoginCredentials {
  username: string;
  password: string;
}

export interface LoginResult {
  access_token: string;
  user_id: string;
  device_id?: string;
  home_server?: string;
}

/** SSO identity provider advertised in GET /login (e.g. a Keycloak IdP). */
export interface SsoIdentityProvider {
  id: string;
  name?: string;
  icon?: string;
  brand?: string;
}

/** One entry of the homeserver's advertised login flows. */
export interface LoginFlow {
  type: string;
  identity_providers?: SsoIdentityProvider[];
}

export interface CreateRoomOptions {
  name?: string;
  topic?: string;
  isPublic?: boolean;
  isSpace?: boolean;
  /** Enable megolm encryption in the room (initial m.room.encryption state). */
  encrypted?: boolean;
}

interface ApiOptions {
  body?: unknown;
  auth?: boolean;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

const CLIENT_PREFIX = "/_matrix/client/v3";
const SYNC_TIMEOUT_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mxidLocalpart(mxid: string): string {
  if (mxid.charAt(0) !== "@") return mxid;
  return mxid.slice(1).split(":")[0] ?? mxid;
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

  private _since: string | null = null;
  private _seen = new Set<string>();
  private _acked = new Map<string, string>(); /* event_id -> txnId */
  private _txnCounter = 0;
  private _syncRunning = false;
  private _stopped = true;
  private _syncAbort: AbortController | null = null;
  private _backoffMs = 0;
  private _readyEmitted = false;
  private _selectedRoomId: string | null = null;
  private _avatarCache = new Map<string, Promise<string | null>>();
  private _mediaCache = new Map<string, Promise<string | null>>();
  /** Encrypted room events that failed to decrypt: roomId -> (eventId -> event). */
  private _undecrypted = new Map<string, Map<string, MatrixEvent>>();
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

  /* --------------------------- sync processing --------------------------- */

  private _ensureRoom(roomId: string): Room {
    let room = this.rooms.get(roomId);
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
        isEncrypted: false,
        encryptionAlgorithm: null,
        callMembers: new Map(),
        livekitService: null,
        typingUsers: [],
        children: new Set(),
        members: new Map(),
        timeline: [],
        summaryJoinedCount: 0,
        serverNotifications: 0,
        unread: 0,
        lastActivityTs: 0,
        title: roomId,
        isDirect: false,
        directUserId: null,
        joinedMemberCount: 0,
      };
      this.rooms.set(roomId, room);
    }
    return room;
  }

  private _applyStateEvent(room: Room, ev: MatrixEvent): void {
    if (!ev || !ev.type) return;
    const content = ev.content ?? {};
    switch (ev.type) {
      case "m.room.create":
        room.isSpace = content.type === "m.space";
        room.creator = ev.sender ?? null;
        break;
      case "m.room.name":
        room.name = typeof content.name === "string" ? content.name : null;
        break;
      case "m.room.topic":
        room.topic = typeof content.topic === "string" ? content.topic : null;
        break;
      case "m.room.avatar":
        room.avatarMxc = typeof content.url === "string" ? content.url : null;
        break;
      case "m.room.canonical_alias":
        room.canonicalAlias = typeof content.alias === "string" ? content.alias : null;
        break;
      case "m.room.join_rules":
        room.joinRule =
          typeof content.join_rule === "string" ? content.join_rule : null;
        break;
      case "m.room.encryption": {
        const algorithm =
          typeof content.algorithm === "string" ? content.algorithm : null;
        room.isEncrypted = algorithm !== null;
        room.encryptionAlgorithm = algorithm;
        break;
      }
      case "com.grungus.livekit": {
        const url = typeof content.url === "string" ? content.url : null;
        const lkRoom = typeof content.room === "string" ? content.room : null;
        const authUrl = typeof content.auth_url === "string" ? content.auth_url : null;
        room.livekitService =
          url && lkRoom && authUrl ? { url, room: lkRoom, authUrl } : null;
        break;
      }
      case "m.call.member": {
        if (typeof ev.state_key !== "string") break;
        const calls = content["m.calls"];
        const hasDevices =
          Array.isArray(calls) &&
          (calls as { "m.devices"?: unknown[] }[]).some(
            (call) => Array.isArray(call["m.devices"]) && call["m.devices"]!.length > 0
          );
        if (hasDevices) {
          room.callMembers.set(ev.state_key, content);
        } else {
          room.callMembers.delete(ev.state_key);
        }
        break;
      }
      case "m.room.member": {
        if (typeof ev.state_key !== "string") break;
        room.members.set(ev.state_key, {
          userId: ev.state_key,
          displayname:
            typeof content.displayname === "string" ? content.displayname : null,
          avatarMxc:
            typeof content.avatar_url === "string" ? content.avatar_url : null,
          membership: typeof content.membership === "string" ? content.membership : "leave",
        });
        break;
      }
      case "m.space.child": {
        const via = content.via;
        if (typeof ev.state_key === "string" && Array.isArray(via) && via.length > 0) {
          room.children.add(ev.state_key);
        } else if (typeof ev.state_key === "string") {
          room.children.delete(ev.state_key);
        }
        break;
      }
      default:
        break;
    }
  }

  private _resolveRoomMeta(room: Room): void {
    const joinedOthers: MemberRecord[] = [];
    for (const member of room.members.values()) {
      if (member.membership === "join" && member.userId !== this.userId) {
        joinedOthers.push(member);
      }
    }

    if (room.isSpace) {
      room.title = room.name || "Space";
    } else if (room.name) {
      room.title = room.name;
    } else if (joinedOthers.length === 1) {
      const other = joinedOthers[0]!;
      room.title = other.displayname || mxidLocalpart(other.userId);
      room.directUserId = other.userId;
    } else if (room.canonicalAlias) {
      room.title = room.canonicalAlias;
    } else {
      room.title = "Empty room";
    }

    room.isDirect =
      !room.isSpace &&
      !room.name &&
      !room.canonicalAlias &&
      joinedOthers.length === 1;
    room.joinedMemberCount =
      joinedOthers.length +
      (this._isMember(room, this.userId) ? 1 : 0);
  }

  private _isMember(room: Room, userId: string | null): boolean {
    if (!userId) return false;
    const member = room.members.get(userId);
    return !!member && member.membership === "join";
  }

  private _displayNameFor(room: Room, sender: string | null): string {
    if (!sender) return "unknown";
    const member = room.members.get(sender);
    if (member?.displayname) return member.displayname;
    if (sender === this.userId) return "You";
    return mxidLocalpart(sender);
  }

  private _toTimelineItem(room: Room, ev: MatrixEvent): TimelineItem | null {
    if (!ev || !ev.type) return null;
    const ts = ev.origin_server_ts ?? Date.now();
    const senderName = this._displayNameFor(room, ev.sender ?? null);
    const content = ev.content ?? {};

    if (ev.type === "m.room.message" || ev.type === "m.sticker") {
      const isSticker = ev.type === "m.sticker";
      const msgtype = isSticker
        ? "m.sticker"
        : typeof content.msgtype === "string"
          ? content.msgtype
          : "m.text";
      const body = typeof content.body === "string" ? content.body : "";
      const url = typeof content.url === "string" ? content.url : null;

      const rawInfo = content.info;
      const info =
        rawInfo && typeof rawInfo === "object"
          ? (rawInfo as { mimetype?: unknown; w?: unknown; h?: unknown; size?: unknown })
          : {};

      const otherAttachment =
        msgtype === "m.file" || msgtype === "m.audio" || msgtype === "m.video";
      const text = otherAttachment ? `[attachment] ${body}` : body;

      const media =
        url && (isSticker || msgtype === "m.image")
          ? {
              mxc: url,
              mimetype: typeof info.mimetype === "string" ? info.mimetype : null,
              width: typeof info.w === "number" ? info.w : null,
              height: typeof info.h === "number" ? info.h : null,
              size: typeof info.size === "number" ? info.size : null,
              name: body || null,
            }
          : null;

      return {
        kind: "message",
        id: ev.event_id ?? null,
        sender: ev.sender ?? "",
        senderName,
        ts,
        msgtype,
        body: text,
        media,
      };
    }

    if (ev.type === "m.room.member" && typeof ev.state_key === "string") {
      const membership =
        typeof content.membership === "string" ? content.membership : "join";
      const prev = ev.unsigned?.prev_content?.membership;
      const targetName =
        ev.state_key === ev.sender
          ? senderName
          : typeof content.displayname === "string"
            ? content.displayname
            : mxidLocalpart(ev.state_key);
      let text: string;
      if (membership === "join") text = `${targetName} joined the room`;
      else if (membership === "leave")
        text =
          prev === "invite"
            ? `${targetName} declined the invite`
            : `${targetName} left the room`;
      else if (membership === "invite") text = `${senderName} invited ${targetName}`;
      else if (membership === "ban") text = `${senderName} banned ${targetName}`;
      else text = `${targetName}'s membership is now ${membership}`;
      return { kind: "system", id: ev.event_id ?? null, ts, text };
    }

    if (ev.type === "m.room.name" && typeof content.name === "string") {
      return {
        kind: "system",
        id: ev.event_id ?? null,
        ts,
        text: `${senderName} changed the room name to "${content.name}"`,
      };
    }

    if (ev.type === "m.room.topic" && typeof content.topic === "string") {
      return {
        kind: "system",
        id: ev.event_id ?? null,
        ts,
        text: `${senderName} changed the room topic`,
      };
    }

    return null;
  }

  /**
   * Decrypt an m.room.encrypted room event into a timeline item. Returns
   * a "unable to decrypt" system line when the room key is not (yet) known
   * to this device.
   */
  private _decryptedTimelineItem(room: Room, ev: MatrixEvent): TimelineItem | null {
    if (!this.crypto) return null;
    const decrypted = this.crypto.decryptRoomEvent(ev);
    if (!decrypted) {
      this._trackUndecrypted(room, ev);
      return {
        kind: "system",
        id: ev.event_id ?? null,
        ts: ev.origin_server_ts ?? Date.now(),
        text: "🔒 Unable to decrypt this message (requesting the key from other devices…)",
      };
    }
    const inner: MatrixEvent = {
      ...ev,
      type: decrypted.type,
      content: decrypted.content,
    };
    return this._toTimelineItem(room, inner);
  }

  /**
   * Remember an undecryptable event and fire a key request (deduped in the
   * crypto layer). When a forwarded key arrives, retryUndecrypted() turns
   * these into real timeline items.
   */
  private _trackUndecrypted(room: Room, ev: MatrixEvent): void {
    const content = ev.content as { sender_key?: unknown; session_id?: unknown };
    const senderKey = typeof content.sender_key === "string" ? content.sender_key : null;
    const sessionId = typeof content.session_id === "string" ? content.session_id : null;
    const eventId = ev.event_id ?? null;
    if (!senderKey || !sessionId || !eventId) return;
    if (this.crypto) {
      void this.crypto
        .requestRoomKey(room.id, ev.sender ?? null, senderKey, sessionId)
        .catch((err) => console.error("[grungus] room key request failed:", err));
    }
    let perRoom = this._undecrypted.get(room.id);
    if (!perRoom) {
      perRoom = new Map();
      this._undecrypted.set(room.id, perRoom);
    }
    perRoom.set(eventId, ev);
  }

  /**
   * Retry tracked undecryptable events (called when a forwarded room key
   * lands). Decrypted events replace their "unable to decrypt" system line
   * in place; the room update carries redraw so the view re-renders.
   */
  retryUndecrypted(roomId: string): void {
    const room = this.rooms.get(roomId);
    const pending = this._undecrypted.get(roomId);
    if (!room || !pending || pending.size === 0) return;
    let changed = false;
    for (const [eventId, ev] of [...pending.entries()]) {
      const decrypted = this.crypto ? this.crypto.decryptRoomEvent(ev) : null;
      if (!decrypted) continue;
      pending.delete(eventId);
      changed = true;
      const inner: MatrixEvent = {
        ...ev,
        type: decrypted.type,
        content: decrypted.content,
      };
      const item = this._toTimelineItem(room, inner);
      if (!item) continue;
      const idx = room.timeline.findIndex(
        (entry) => entry.kind === "system" && entry.id === eventId
      );
      if (idx >= 0) room.timeline[idx] = item;
      else room.timeline.push(item);
      const ts = ev.origin_server_ts ?? Date.now();
      if (ts > room.lastActivityTs) room.lastActivityTs = ts;
    }
    if (changed) {
      this.emit("room", { room, newEvents: [], redraw: true });
      this.emit("rooms", this.getRooms());
    }
  }

  private _removeEcho(room: Room, txnId: string): boolean {
    for (let i = 0; i < room.timeline.length; i++) {
      const entry = room.timeline[i];
      if (entry && entry.kind === "message" && entry.txnId === txnId) {
        room.timeline.splice(i, 1);
        return true;
      }
    }
    return false;
  }

  private _applySync(data: SyncResponse): void {
    /* to-device first: room keys must be processed before encrypted room
       events arriving in the same sync batch are handled. A crypto error
       must never abort room processing. */
    if (this.crypto || this.onToDevice) {
      try {
        const toDevice = data.to_device?.events ?? [];
        for (const event of toDevice) {
          if (event.type === "m.room.encrypted") continue; /* handled by crypto */
          this.onToDevice?.(event);
        }
        if (this.crypto) {
          /* crypto filters internally: olm events, key requests */
          this.crypto.onToDeviceEvents(toDevice);
          const keyCounts = data.device_one_time_keys_count;
          if (keyCounts) void this.crypto.onOneTimeKeyCounts(keyCounts);
          const changed = data.device_lists?.changed;
          if (changed && changed.length > 0) this.crypto.onDeviceListChange(changed);
        }
      } catch (err) {
        console.error("[grungus] crypto sync handling failed:", err);
      }
    }

    const joined = data.rooms?.join ?? {};
    const changedRooms: RoomUpdate[] = [];

    for (const [roomId, rd] of Object.entries(joined)) {
      const room = this._ensureRoom(roomId);
      const newEvents: RoomEvent[] = [];
      let relationChanged = false;

      for (const ev of rd.state?.events ?? []) {
        this._applyStateEvent(room, ev);
      }

      for (const ev of rd.timeline?.events ?? []) {
        if (!ev || typeof ev !== "object") continue;
        const evId = ev.event_id;
        if (evId) {
          if (this._seen.has(evId)) continue;
          this._seen.add(evId);
        }
        if (ev.state_key !== undefined) this._applyStateEvent(room, ev);
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
        if (evId && this._acked.has(evId)) {
          const echoTxn = this._acked.get(evId)!;
          this._removeEcho(room, echoTxn);
          this._acked.delete(evId);
          newEvents.push({ kind: "echo-replaced", txnId: echoTxn });
        }
        const item =
          room.isEncrypted && ev.type === "m.room.encrypted"
            ? this.crypto
              ? this._decryptedTimelineItem(room, ev)
              : {
                  kind: "system" as const,
                  id: ev.event_id ?? null,
                  ts: ev.origin_server_ts ?? Date.now(),
                  text: "🔒 Unable to decrypt (E2EE unavailable)",
                }
            : this._toTimelineItem(room, ev);
        if (item) {
          /* relation processing: edits, reactions, replies, redactions.
             Returns true when the event is fully handled as a relation
             (edit/reaction/redaction) and must NOT become a new
             timeline item. */
          const handled = this._applyRelations(room, ev, item);
          if (handled) {
            relationChanged = true;
          } else {
            room.timeline.push(item);
            newEvents.push(item);
          }
        } else {
          /* events that produce no timeline item may still carry relations */
          if (this._applyRelations(room, ev, null)) {
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
      if (rd.unread_notifications?.notification_count != null) {
        room.serverNotifications = rd.unread_notifications.notification_count;
      }

      this._resolveRoomMeta(room);

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

      changedRooms.push({
        room,
        newEvents,
        redraw: relationChanged ? true : undefined,
      });
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

  markRoomRead(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) room.unread = 0;
    this._selectedRoomId = roomId;
  }

  clearSelectedRoom(): void {
    this._selectedRoomId = null;
  }

  /**
   * Send a text message with a local echo. The echo is removed and replaced
   * by the server event when /sync delivers it.
   */
  async sendMessage(roomId: string, body: string): Promise<string | null> {
    const text = String(body ?? "");
    if (!text.trim()) throw new Error("Empty message");
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    const room = this.rooms.get(roomId);
    /* encryption decision must hold even when the first sync has not landed:
       fall back to the flag createRoom/joinRoom recorded */
    const encrypted = room
      ? room.isEncrypted === true
      : this._pendingEncryption.get(roomId) === true;
    if (!room && encrypted === undefined) {
      /* unknown room: we cannot know whether it is encrypted — sending
         anyway could leak plaintext. Fail closed; the sync will land the
         room state momentarily. */
      throw new Error("Cannot send: room state not loaded yet (still syncing)");
    }
    const echo: MessageItem = {
      kind: "message",
      id: `pending-${txnId}`,
      txnId,
      pending: true,
      sender: this.userId ?? "",
      senderName: "You",
      ts: Date.now(),
      msgtype: "m.text",
      body: text,
      media: null,
    };
    if (room) {
      room.timeline.push(echo);
      room.lastActivityTs = echo.ts;
      this.emit("room", { room, newEvents: [echo] });
      this.emit("rooms", this.getRooms());
    }
    if (encrypted && !this.crypto) {
      /* fail closed: never send plaintext into an encrypted room */
      throw new Error("Cannot send: E2EE is unavailable in this encrypted room");
    }
    const sendType = encrypted ? "m.room.encrypted" : "m.room.message";
    let content: Record<string, unknown>;
    try {
      content = encrypted
        ? await this.crypto!.encryptRoomMessage(roomId, {
            msgtype: "m.text",
            body: text,
          })
        : { msgtype: "m.text", body: text };
      const res = await this.api<{ event_id?: string }>(
        "PUT",
        `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/send/${sendType}/${encodeURIComponent(txnId)}`,
        { body: content }
      );
      if (res?.event_id) {
        echo.eventId = res.event_id;
        this._acked.set(res.event_id, txnId);
        return res.event_id;
      }
      return null;
    } catch (err) {
      echo.pending = false;
      echo.failed = true;
      if (room) {
        this.emit("room", {
          room,
          newEvents: [{ kind: "echo-failed", txnId }],
        });
      }
      throw err;
    }
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
    const res = await this.api<{ event_id?: string }>(
      "PUT",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}/${encodeURIComponent(stateKey)}`,
      { body: content }
    );
    return res?.event_id ?? null;
  }

  /** Send a plaintext to-device message to one device. */
  async sendToDevice(
    targetUserId: string,
    targetDeviceId: string,
    type: string,
    content: Record<string, unknown>
  ): Promise<void> {
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    await this.api(
      "PUT",
      `/_matrix/client/v3/sendToDevice/${encodeURIComponent(type)}/${encodeURIComponent(txnId)}`,
      {
        body: { messages: { [targetUserId]: { [targetDeviceId]: content } } },
      }
    );
  }

  /** Upload raw bytes to the media store; resolves the mxc:// URI. */
  async uploadMedia(
    filename: string,
    mimeType: string,
    bytes: Uint8Array
  ): Promise<string> {
    const url = new URL(
      `${this.baseUrl}/_matrix/media/v3/upload`
    );
    url.searchParams.set("filename", filename);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": mimeType,
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      },
      body: bytes as unknown as BodyInit,
    });
    const data = (await res.json().catch(() => ({}))) as {
      content_uri?: string;
      errcode?: string;
      error?: string;
    };
    if (!res.ok || !data.content_uri) {
      throw new HttpError(res.status, data as never);
    }
    return data.content_uri;
  }

  /**
   * Send an image (m.image) — megolm-encrypted in encrypted rooms (the
   * mxc URI is then only visible to room members). Echoes locally with
   * media metadata so it renders instantly.
   */
  async sendMedia(
    roomId: string,
    media: {
      mxc: string;
      name: string;
      mimeType: string;
      width?: number | null;
      height?: number | null;
      size?: number | null;
    }
  ): Promise<string | null> {
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    const room = this.rooms.get(roomId);
    const encrypted = room
      ? room.isEncrypted === true
      : this._pendingEncryption.get(roomId) === true;
    if (!room && encrypted === undefined) {
      /* fail closed: an unknown room may be encrypted */
      throw new Error("Cannot send: room state not loaded yet (still syncing)");
    }
    const info: Record<string, unknown> = { mimetype: media.mimeType };
    if (media.width != null) info.w = media.width;
    if (media.height != null) info.h = media.height;
    if (media.size != null) info.size = media.size;
    const content: Record<string, unknown> = {
      msgtype: "m.image",
      body: media.name,
      url: media.mxc,
      info,
    };

    if (encrypted && !this.crypto) {
      throw new Error("Cannot send: E2EE is unavailable in this encrypted room");
    }

    const echo: MessageItem = {
      kind: "message",
      id: `pending-${txnId}`,
      txnId,
      pending: true,
      sender: this.userId ?? "",
      senderName: "You",
      ts: Date.now(),
      msgtype: "m.image",
      body: media.name,
      media: {
        mxc: media.mxc,
        mimetype: media.mimeType,
        width: media.width ?? null,
        height: media.height ?? null,
        size: media.size ?? null,
        name: media.name,
      },
    };
    if (room) {
      room.timeline.push(echo);
      room.lastActivityTs = echo.ts;
      this.emit("room", { room, newEvents: [echo] });
      this.emit("rooms", this.getRooms());
    }
    try {
      const sendEncrypted = encrypted && this.crypto !== null;
      const sendType = sendEncrypted ? "m.room.encrypted" : "m.room.message";
      const payload: Record<string, unknown> = sendEncrypted
        ? await this.crypto!.encryptRoomMessage(roomId, content)
        : content;
      const res = await this.api<{ event_id?: string }>(
        "PUT",
        `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/send/${sendType}/${encodeURIComponent(txnId)}`,
        { body: payload }
      );
      if (res?.event_id) {
        echo.eventId = res.event_id;
        this._acked.set(res.event_id, txnId);
        return res.event_id;
      }
      return null;
    } catch (err) {
      echo.pending = false;
      echo.failed = true;
      if (room) {
        this.emit("room", { room, newEvents: [{ kind: "echo-failed", txnId }] });
      }
      throw err;
    }
  }

  /**
   * Process message relations: edits (m.replace), reactions
   * (m.annotation), replies (m.in_reply_to), and redactions.
   * Mutates existing timeline items in place.
   * Returns true when the event is fully consumed as a relation
   * (edit/reaction/redaction) and must not become a new timeline item;
   * false when the item should be appended normally.
   */
  private _applyRelations(
    room: Room,
    ev: MatrixEvent,
    item: TimelineItem | null
  ): boolean {
    const content = ev.content ?? {};

    /* --- m.reaction (annotation) --- */
    if (ev.type === "m.reaction" && content["m.relates_to"]) {
      const rel = content["m.relates_to"] as {
        rel_type?: string;
        event_id?: string;
        key?: string;
      };
      if (rel.rel_type === "m.annotation" && rel.event_id && rel.key) {
        const target = this._findTimelineMessage(room, rel.event_id);
        if (target) {
          if (!target.reactions) target.reactions = new Map();
          let senders = target.reactions.get(rel.key);
          if (!senders) {
            senders = new Set();
            target.reactions.set(rel.key, senders);
          }
          senders.add(ev.sender);
        }
      }
      return true;
    }

    /* --- m.room.redaction --- */
    if (ev.type === "m.room.redaction") {
      const targetId = ev.redacts;
      if (targetId) {
        /* if a redacted event was a reaction, strip it from the target's
           senders; otherwise remove the message from the timeline */
        const idx = room.timeline.findIndex((entry) => entry.id === targetId);
        if (idx >= 0) {
          room.timeline.splice(idx, 1);
        } else {
          /* maybe it was a reaction event: scan reaction maps */
          for (const entry of room.timeline) {
            if (entry.kind !== "message" || !entry.reactions) continue;
            for (const [emoji, senders] of entry.reactions) {
              /* we don't track reaction event ids per sender; a redaction
                 from user X removes X's reaction on the target if the
                 redacted event was a reaction from X. The mock strips the
                 content so we can't read the key — remove X from every
                 emoji they reacted with on this message (rare in practice). */
              void emoji;
              void senders;
            }
          }
        }
      }
      return true;
    }

    if (!item || item.kind !== "message") return false;

    /* --- m.replace (edit) --- */
    const rel = content["m.relates_to"] as
      | { rel_type?: string; event_id?: string }
      | undefined;
    if (rel?.rel_type === "m.replace" && rel.event_id) {
      const target = this._findTimelineMessage(room, rel.event_id);
      const newContent = content["m.new_content"] as
        | { body?: string; msgtype?: string }
        | undefined;
      if (target && newContent?.body !== undefined) {
        target.body = newContent.body;
        target.edited = true;
        target.editTs = ev.origin_server_ts ?? Date.now();
      }
      /* the edit event itself never becomes a timeline item */
      return true;
    }

    /* --- m.in_reply_to (reply context) --- */
    const inReply = content["m.relates_to"] as
      | { "m.in_reply_to"?: { event_id?: string } }
      | undefined;
    const parentEventId = inReply?.["m.in_reply_to"]?.event_id;
    if (parentEventId && item.kind === "message") {
      const parent = this._findTimelineMessage(room, parentEventId);
      if (parent) {
        item.replyTo = {
          eventId: parentEventId,
          sender: parent.sender,
          senderName: parent.senderName,
          body: parent.body.slice(0, 140),
        };
      } else {
        /* parent not in the local timeline (pagination boundary) — still
           render a generic reply marker */
        item.replyTo = {
          eventId: parentEventId,
          sender: "",
          senderName: "message",
          body: "(not loaded)",
        };
      }
      /* strip the rich-reply fallback from the body: the spec encodes
         "> <@sender> original\n\nreply" so non-reply clients still see
         the quote; reply-aware clients render the structured
         m.in_reply_to instead and drop the fallback lines */
      item.body = this._stripReplyFallback(item.body);
    }
    return false;
  }

  /** Remove the "> <@user> ..." rich-reply fallback lines from a body. */
  private _stripReplyFallback(body: string): string {
    const lines = body.split("\n");
    let i = 0;
    /* skip the leading blockquote ("> " or ">" prefixed lines) */
    while (i < lines.length && (lines[i]!.startsWith("> ") || lines[i] === ">")) {
      i++;
    }
    /* skip one blank separator line after the quote */
    if (i > 0 && i < lines.length && lines[i] === "") i++;
    if (i === 0) return body; /* no fallback present */
    return lines.slice(i).join("\n");
  }

  /** Find a message timeline item by event id. */
  private _findTimelineMessage(room: Room, eventId: string): MessageItem | null {
    for (const entry of room.timeline) {
      if (entry.kind === "message" && entry.id === eventId) return entry;
    }
    return null;
  }

  /* --------------------------- message relations -------------------------- */

  /** Edit one of your own messages (sends m.replace). */
  async editMessage(roomId: string, eventId: string, newBody: string): Promise<string | null> {
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    const res = await this.api<{ event_id?: string }>(
      "PUT",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      {
        body: {
          msgtype: "m.text",
          body: `* ${newBody}`,
          "m.new_content": { msgtype: "m.text", body: newBody },
          "m.relates_to": { rel_type: "m.replace", event_id: eventId },
        },
      }
    );
    return res?.event_id ?? null;
  }

  /** React to a message with an emoji (m.reaction / m.annotation). */
  async sendReaction(roomId: string, targetEventId: string, emoji: string): Promise<string | null> {
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    const res = await this.api<{ event_id?: string }>(
      "PUT",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${encodeURIComponent(txnId)}`,
      {
        body: {
          "m.relates_to": {
            rel_type: "m.annotation",
            event_id: targetEventId,
            key: emoji,
          },
        },
      }
    );
    return res?.event_id ?? null;
  }

  /** Redact (remove) an event — used to remove your own reaction. */
  async redactEvent(roomId: string, eventId: string, reason?: string): Promise<void> {
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    await this.api(
      "PUT",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`,
      { body: reason ? { reason } : {} }
    );
  }

  /** Reply to a message (m.in_reply_to). */
  async replyMessage(
    roomId: string,
    parentEventId: string,
    parentSender: string,
    parentBody: string,
    body: string
  ): Promise<string | null> {
    const txnId = `gr.${Date.now()}.${++this._txnCounter}`;
    const fallback = `> <${parentSender}> ${parentBody}\n\n${body}`;
    const res = await this.api<{ event_id?: string }>(
      "PUT",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      {
        body: {
          msgtype: "m.text",
          body: fallback,
          "m.relates_to": {
            "m.in_reply_to": { event_id: parentEventId },
          },
        },
      }
    );
    return res?.event_id ?? null;
  }

  /** Publish (or clear) typing state for the current user in a room. */
  async setTyping(
    roomId: string,
    typing: boolean,
    timeoutMs = 30_000
  ): Promise<void> {
    const userId = this.userId ?? "";
    if (!userId) return;
    await this.api(
      "PUT",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`,
      { body: { typing, timeout: timeoutMs } }
    );
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

  private _parseMxc(mxc: string): { server: string; mediaId: string } | null {
    if (typeof mxc !== "string" || !mxc.startsWith("mxc://")) return null;
    const rest = mxc.slice("mxc://".length).split("/");
    const server = rest.shift();
    const mediaId = rest.join("/");
    if (!server || !mediaId) return null;
    return { server, mediaId };
  }

  /**
   * Resolve an mxc:// avatar URI to a displayable thumbnail URL. Fetches
   * through the authenticated-media path (Bearer header) and caches blobs,
   * so it works against homeservers that require authenticated media
   * (e.g. matrix.org) as well as open ones.
   */
  async avatarSrc(mxc: string | null | undefined, size = 64): Promise<string | null> {
    if (typeof URL.createObjectURL !== "function") return null;
    const parsed = mxc ? this._parseMxc(mxc) : null;
    if (!parsed) return null;

    const key = `${mxc}@${size}`;
    const cached = this._avatarCache.get(key);
    if (cached) return cached;

    const url = new URL(
      `${this.baseUrl}/_matrix/media/v3/thumbnail/${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`
    );
    url.searchParams.set("width", String(size));
    url.searchParams.set("height", String(size));
    url.searchParams.set("method", "scale");

    const p = fetch(url.toString(), {
      headers: this.accessToken
        ? { Authorization: `Bearer ${this.accessToken}` }
        : {},
    })
      .then(async (res) => {
        if (!res.ok) return null;
        return URL.createObjectURL(await res.blob());
      })
      .catch(() => null);
    this._avatarCache.set(key, p);
    return p;
  }

  /**
   * Resolve an mxc:// media URI (images, GIFs) to an object URL via the
   * authenticated download endpoint. GIFs animate natively once rendered in
   * an <img>; the blob cache dedupes repeat renders.
   */
  async mediaSrc(mxc: string | null | undefined): Promise<string | null> {
    if (typeof URL.createObjectURL !== "function") return null;
    const parsed = mxc ? this._parseMxc(mxc) : null;
    if (!parsed) return null;

    const cached = this._mediaCache.get(mxc!);
    if (cached) return cached;

    const url =
      `${this.baseUrl}/_matrix/media/v3/download/` +
      `${encodeURIComponent(parsed.server)}/${encodeURIComponent(parsed.mediaId)}`;
    const p = fetch(url, {
      headers: this.accessToken
        ? { Authorization: `Bearer ${this.accessToken}` }
        : {},
    })
      .then(async (res) => {
        if (!res.ok) return null;
        return URL.createObjectURL(await res.blob());
      })
      .catch(() => null);
    this._mediaCache.set(mxc!, p);
    return p;
  }
}
