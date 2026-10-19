/** Room creation defaults, current state application, and derived display metadata. */
import type { Room, MatrixEvent, MemberRecord } from "./matrix-types.ts";
import { mxidLocalpart } from "./matrix-identifiers.ts";
import { rebuildRtcMemberships } from "./matrix-rtc.ts";

export function createRoomRecord(roomId: string): Room {
  return {
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
    rtcMemberships: [],
    livekitService: null,
    typingUsers: [],
    readReceipts: new Map(),
    fullyReadEventId: null,
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
}

export function applyStateEvent(room: Room, ev: MatrixEvent): void {
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
        url && lkRoom && authUrl ? { url, room: lkRoom, authUrl, authMode: content.auth_mode === "whoami" ? "whoami" : "openid" } : null;
      break;
    }
    case "m.call.member":
    case "org.matrix.msc3401.call.member": {
      if (typeof ev.state_key !== "string") break;
      const calls = content["m.calls"];
      const hasDevices =
        Array.isArray(calls) &&
        (calls as { "m.devices"?: unknown[] }[]).some(
          (call) => Array.isArray(call["m.devices"]) && call["m.devices"]!.length > 0
        );
      /* MSC4143 session format: flattened per-device content */
      const isSessionMembership =
        content.application === "m.call" &&
        typeof content.device_id === "string" &&
        content.device_id !== "";
      if (hasDevices || isSessionMembership) {
        room.callMembers.set(ev.state_key, content);
      } else {
        room.callMembers.delete(ev.state_key);
      }
      rebuildRtcMemberships(room);
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

function applyDirectByAccountData(room: Room, joinedOthers: MemberRecord[], directData: Record<string, unknown> | null): boolean {
  if (joinedOthers.length !== 1) return false;
  const direct = directData as
    | Record<string, string[]>
    | undefined;
  if (!direct) return false;
  const peer = joinedOthers[0]!;
  const roomIds = direct[peer.userId];
  if (Array.isArray(roomIds) && roomIds.includes(room.id)) {
    room.directUserId = peer.userId;
    return true;
  }
  return false;
}

export function resolveRoomMeta(room: Room, userId: string | null, directData: Record<string, unknown> | null): void {
  const joinedOthers: MemberRecord[] = [];
  for (const member of room.members.values()) {
    if (member.membership === "join" && member.userId !== userId) {
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
    ((!room.name && !room.canonicalAlias && joinedOthers.length === 1) ||
      applyDirectByAccountData(room, joinedOthers, directData));
  room.joinedMemberCount =
    joinedOthers.length +
    (isMember(room, userId) ? 1 : 0);
}

function isMember(room: Room, userId: string | null): boolean {
  if (!userId) return false;
  const member = room.members.get(userId);
  return !!member && member.membership === "join";
}

export function displayNameFor(room: Room, sender: string | null, userId: string | null): string {
  if (!sender) return "unknown";
  const member = room.members.get(sender);
  if (member?.displayname) return member.displayname;
  if (sender === userId) return "You";
  return mxidLocalpart(sender);
}
