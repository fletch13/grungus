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
  summary?: {
    "m.joined_member_count"?: number;
    "m.invited_member_count"?: number;
  };
  unread_notifications?: { notification_count?: number };
}

export interface SyncResponse {
  next_batch?: string;
  rooms?: { join?: Record<string, SyncJoinedRoom> };
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
  connectionState: ConnectionState = "connecting";
  /** E2EE layer — attached by the app after login; null in plain mode. */
  crypto: E2eeCrypto | null = null;

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
  private readonly _listeners: { [K in keyof ClientEvents]: Set<Listener<K>> } = {
    sync: new Set(),
    ready: new Set(),
    room: new Set(),
    rooms: new Set(),
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
      return {
        kind: "system",
        id: ev.event_id ?? null,
        ts: ev.origin_server_ts ?? Date.now(),
        text: "🔒 Unable to decrypt this message (key not shared with this device)",
      };
    }
    const inner: MatrixEvent = {
      ...ev,
      type: decrypted.type,
      content: decrypted.content,
    };
    return this._toTimelineItem(room, inner);
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
    if (this.crypto) {
      try {
        const toDevice = data.to_device?.events ?? [];
        if (toDevice.length > 0) this.crypto.onToDeviceEvents(toDevice);
        const keyCounts = data.device_one_time_keys_count;
        if (keyCounts) void this.crypto.onOneTimeKeyCounts(keyCounts);
        const changed = data.device_lists?.changed;
        if (changed && changed.length > 0) this.crypto.onDeviceListChange(changed);
      } catch (err) {
        console.error("[grungus] crypto sync handling failed:", err);
      }
    }

    const joined = data.rooms?.join ?? {};
    const changedRooms: RoomUpdate[] = [];

    for (const [roomId, rd] of Object.entries(joined)) {
      const room = this._ensureRoom(roomId);
      const newEvents: RoomEvent[] = [];

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
          room.timeline.push(item);
          newEvents.push(item);
        }
      }

      if (rd.summary?.["m.joined_member_count"] != null) {
        room.summaryJoinedCount = rd.summary["m.joined_member_count"];
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

      changedRooms.push({ room, newEvents });
    }

    for (const update of changedRooms) {
      this.emit("room", update);
    }
    if (changedRooms.length > 0) {
      this.emit("rooms", this.getRooms());
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
    const encrypted = room?.isEncrypted === true;
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
    const res = await this.api<{ room_id?: string }>(
      "POST",
      `${CLIENT_PREFIX}/createRoom`,
      { body }
    );
    if (!res?.room_id) throw new Error("createRoom returned no room_id");
    return res.room_id;
  }

  async joinRoom(roomIdOrAlias: string): Promise<string> {
    const res = await this.api<{ room_id?: string }>(
      "POST",
      `${CLIENT_PREFIX}/join/${encodeURIComponent(roomIdOrAlias)}`,
      { body: {} }
    );
    return res?.room_id ?? roomIdOrAlias;
  }

  async invite(roomId: string, userId: string): Promise<void> {
    await this.api(
      "POST",
      `${CLIENT_PREFIX}/rooms/${encodeURIComponent(roomId)}/invite`,
      { body: { user_id: userId } }
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
