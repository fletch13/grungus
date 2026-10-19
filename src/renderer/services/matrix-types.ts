/** Matrix wire types, client events, and shared data contracts. */
import type { EncryptedFile } from "./attachments.ts";

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

export interface SyncJoinedRoom {
  state?: { events?: MatrixEvent[] };
  timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string };
  ephemeral?: { events?: MatrixEvent[] };
  summary?: {
    "m.joined_member_count"?: number;
    "m.invited_member_count"?: number;
  };
  unread_notifications?: { notification_count?: number };
  account_data?: { events?: MatrixEvent[] };
}

export interface SyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<string, SyncJoinedRoom>;
    invite?: Record<string, { invite_state?: { events?: MatrixEvent[] } }>;
    /** rooms we left (from this or another device) — final events + the leave */
    leave?: Record<string, { timeline?: { events?: MatrixEvent[] } }>;
  };
  to_device?: { events?: ToDeviceEvent[] };
  device_one_time_keys_count?: Record<string, number>;
  device_lists?: { changed?: string[]; new?: string[] };
  account_data?: { events?: MatrixEvent[] };
}

export interface ToDeviceEvent {
  sender: string;
  type: string;
  content: unknown;
}

/** A participant's media-encryption keys for a call (Element interop). */
export interface MediaKeysEvent {
  roomId: string | null;
  sender: string;
  deviceId: string | null;
  keys: Array<{ index: number; key: string }>;
}

export interface MemberRecord {
  userId: string;
  displayname: string | null;
  avatarMxc: string | null;
  membership: string;
}

export interface MediaInfo {
  file?: EncryptedFile;
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

export interface RtcMembership {
  sender: string;
  deviceId: string;
  callId: string;
  /** absolute expiry (ms epoch); Infinity when no expiry is given */
  expiresTs: number;
  /** the LiveKit service URL from the membership's focus, when present */
  focusUrl: string | null;
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
  /**
   * Parsed MatrixRTC memberships (m.call.member state, both the legacy
   * per-user and the MSC4143 per-device formats) — non-expired only,
   * with the LiveKit focus URL when present.
   */
  rtcMemberships: RtcMembership[];
  /** com.grungus.livekit state: the room's LiveKit call service, if any. */
  livekitService: {
    url: string;
    room: string;
    authUrl: string;
    authMode?: "openid" | "whoami";
  } | null;
  /** Users currently typing (from ephemeral m.typing), self excluded. */
  typingUsers: string[];
  /** Other users' read receipts (m.read, from ephemeral events):
   *  userId -> { eventId, ts }. */
  readReceipts: Map<string, { eventId: string; ts: number }>;
  /** this user's fully-read marker (m.fully_read room account data) */
  fullyReadEventId: string | null;
  children: Set<string>;
  members: Map<string, MemberRecord>;
  timeline: TimelineItem[];
  historyCursor?: string | null;
  historyLoading?: boolean;
  /** False while browsing an older window; live events still update notifications. */
  atLiveEdge?: boolean;
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
  /** the raw error body (UIA challenges carry flows/session here) */
  readonly body: Record<string, unknown> | null;

  constructor(status: number, body: { errcode?: string; error?: string } | null) {
    const message =
      (body && (body.error || body.errcode)) || `HTTP ${status} from homeserver`;
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.errcode = (body && body.errcode) || null;
    this.body = body as Record<string, unknown> | null;
  }
}

export type ConnectionState =
  | "connecting"
  | "online"
  | "offline"
  | "stopped"
  | "auth-error";

/* ------------------------------ client types ----------------------------- */

export interface ClientEvents {
  sync: [];
  ready: [];
  room: [RoomUpdate];
  rooms: [Room[]];
  invites: [InvitedRoom[]];
  connection: [ConnectionState];
  error: [unknown];
  "auth-error": [HttpError];
  /** a room was deleted/left — the UI clears it from selection */
  "room-deleted": [string];
}

export type Listener<K extends keyof ClientEvents> = (...args: ClientEvents[K]) => void;

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

/** One UIA flow advertised by POST /register (a list of stages). */
export interface RegistrationFlow {
  stages?: string[];
}

/** The UIA challenge from POST /register: available flows + session. */
export interface RegistrationChallenge {
  flows: RegistrationFlow[];
  session?: string;
  params?: Record<string, unknown>;
}

export interface RegisterCredentials {
  username: string;
  password: string;
  /** Required when the server's flow demands m.login.registration_token. */
  registrationToken?: string | null;
}

export interface CreateRoomOptions {
  name?: string;
  topic?: string;
  isPublic?: boolean;
  isSpace?: boolean;
  /** Enable megolm encryption in the room (initial m.room.encryption state). */
  encrypted?: boolean;
}

export interface ApiOptions {
  body?: unknown;
  auth?: boolean;
  query?: Record<string, string | number | undefined>;
  timeoutMs?: number | null;
  signal?: AbortSignal;
}

export interface MediaMessage {
  mxc: string;
  file?: EncryptedFile;
  name: string;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  size?: number | null;
}
