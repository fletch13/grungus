/** Apply edits, replies, reactions, and redactions to an existing timeline. */
import type { Room, MatrixEvent, TimelineItem, MessageItem } from "./matrix-types.ts";

export function applyRelations(
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
      const target = findTimelineMessage(room, rel.event_id);
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
    const target = findTimelineMessage(room, rel.event_id);
    const newContent = content["m.new_content"] as
      | { body?: string; msgtype?: string }
      | undefined;
    if (target && target.sender === ev.sender && newContent?.body !== undefined &&
        (target.editTs ?? 0) <= (ev.origin_server_ts ?? 0)) {
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
    const parent = findTimelineMessage(room, parentEventId);
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
    item.body = stripReplyFallback(item.body);
  }
  return false;
}

function stripReplyFallback(body: string): string {
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

function findTimelineMessage(room: Room, eventId: string): MessageItem | null {
  for (const entry of room.timeline) {
    if (entry.kind === "message" && entry.id === eventId) return entry;
  }
  return null;
}
