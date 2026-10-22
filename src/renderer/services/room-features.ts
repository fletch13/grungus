import type { MatrixClient, Room, MessageItem, MatrixEvent } from "./matrix-client.ts";
import { HttpError } from "./matrix-types.ts";
import { canChangeState, userPowerLevel } from "./room-permissions.ts";
export type NotificationMode = "inherit" | "all" | "mentions" | "mute";
export interface SearchFilter { text: string; sender?: string; after?: number; before?: number; type?: string; }
export interface PollDefinition { question: string; answers: { id: string; text: string }[]; maxSelections: number; disclosed: boolean; }
const prefix = "/_matrix/client/v3";
export function parsePoll(content: Record<string, unknown>): PollDefinition | null {
  const raw = (content["org.matrix.msc3381.poll.start"] ?? content["m.poll.start"]) as any;
  const text = (value: any): string => typeof value?.["org.matrix.msc1767.text"] === "string" ? value["org.matrix.msc1767.text"] : typeof value?.["m.text"] === "string" ? value["m.text"] : "";
  if (!raw || !text(raw.question) || !Array.isArray(raw.answers)) return null;
  const answers = raw.answers.filter((answer: any) => typeof answer.id === "string" && text(answer)).map((answer: any) => ({ id: answer.id, text: text(answer) }));
  if (answers.length < 2 || new Set(answers.map((a: any) => a.id)).size !== answers.length) return null;
  return { question: text(raw.question), answers, maxSelections: Math.max(1, Math.min(Number(raw.max_selections) || 1, answers.length)), disclosed: ["m.poll.disclosed", "org.matrix.msc3381.poll.disclosed"].includes(raw.kind) };
}
export function tallyPoll(root: MessageItem, events: MessageItem[]): { counts: Map<string, number>; votes: Map<string, string[]>; ended: boolean } {
  const poll = root.pollEvent ? parsePoll(root.pollEvent.content) : null;
  const counts = new Map(poll?.answers.map(answer => [answer.id, 0]) ?? []);
  const related = events.filter(event => (event.pollEvent?.content["m.relates_to"] as { event_id?: string } | undefined)?.event_id === root.id && event.ts >= root.ts);
  const end = related.filter(event => /poll.end$/.test(event.pollEvent?.type ?? "") && event.sender === root.sender).sort((a, b) => a.ts - b.ts)[0];
  const votes = new Map<string, string[]>();
  for (const event of [...related].sort((a, b) => a.ts - b.ts || (a.id ?? "").localeCompare(b.id ?? ""))) {
    if (!/poll.response$/.test(event.pollEvent?.type ?? "") || (end && event.ts > end.ts)) continue;
    const response = (event.pollEvent!.content["org.matrix.msc3381.poll.response"] ?? event.pollEvent!.content["m.poll.response"]) as { answers?: unknown } | undefined;
    const answers = response?.answers;
    if (!Array.isArray(answers) || answers.length > (poll?.maxSelections ?? 1) || answers.some(answer => typeof answer !== "string" || !counts.has(answer)) || new Set(answers).size !== answers.length) continue;
    votes.set(event.sender, answers as string[]);
  }
  for (const answers of votes.values()) for (const answer of answers) counts.set(answer, counts.get(answer)! + 1);
  return { counts, votes, ended: !!end };
}
export function searchLoaded(room: Room, filter: SearchFilter, ignored: string[] = []): MessageItem[] {
  const term = filter.text.trim().toLocaleLowerCase();
  return room.timeline.filter((item): item is MessageItem => item.kind === "message" && !ignored.includes(item.sender)
    && (!term || item.body.toLocaleLowerCase().includes(term)) && (!filter.sender || item.sender === filter.sender)
    && (!filter.after || item.ts >= filter.after) && (!filter.before || item.ts < filter.before)
    && (!filter.type || item.msgtype === filter.type)).sort((a, b) => b.ts - a.ts);
}
export class RoomFeatures {
  private client: MatrixClient;
  constructor(client: MatrixClient) { this.client = client; }
  private writes: Promise<unknown> = Promise.resolve();
  private serial<T>(action: () => Promise<T>): Promise<T> { const task = this.writes.catch(() => {}).then(action); this.writes = task; return task; }
  async state(roomId: string, type: string): Promise<Record<string, any>> {
    try { return await this.client.api("GET", `${prefix}/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(type)}`); }
    catch (error) { if (error instanceof HttpError && error.errcode === "M_NOT_FOUND") return {}; throw error; }
  }
  async pins(roomId: string): Promise<string[]> { const state = await this.state(roomId, "m.room.pinned_events"); return Array.isArray(state.pinned) ? state.pinned.filter((id: unknown) => typeof id === "string") : []; }
  async pin(room: Room, eventId: string, pinned: boolean): Promise<void> {
    return this.serial(async () => {
      const power = await this.client.getRoomPowerLevels(room.id);
      if (!canChangeState(power, this.client.userId ?? "", room.creator, "m.room.pinned_events")) throw new Error("You do not have permission to change pinned messages");
      const ids = await this.pins(room.id);
      await this.client.sendStateEvent(room.id, "m.room.pinned_events", "", { pinned: pinned ? [...new Set([...ids, eventId])] : ids.filter(id => id !== eventId) });
    });
  }
  notificationMode(roomId: string): NotificationMode { const mode = this.client.getAccountData("org.grungus.notifications")?.[roomId]; return ["all", "mentions", "mute"].includes(String(mode)) ? mode as NotificationMode : "inherit"; }
  async setNotificationMode(roomId: string, mode: NotificationMode): Promise<void> {
    if (!["inherit", "all", "mentions", "mute"].includes(mode)) throw new Error("Invalid notification mode");
    return this.serial(async () => {
      let data: Record<string, unknown>;
      try { data = await this.client.api("GET", `${prefix}/user/${encodeURIComponent(this.client.userId!)}/account_data/org.grungus.notifications`); }
      catch (error) { if (!(error instanceof HttpError) || error.errcode !== "M_NOT_FOUND") throw error; data = {}; }
      const updated = { ...data }; if (mode === "inherit") delete updated[roomId]; else updated[roomId] = mode;
      await this.client.setAccountData("org.grungus.notifications", updated);
    });
  }
  shouldNotify(room: Room, sender: string, body: string, mentions: string[] = [], roomMention = false): boolean {
    if (sender === this.client.userId || this.client.getIgnoredUsers().includes(sender)) return false;
    let mode = this.notificationMode(room.id);
    if (mode === "inherit") {
      const spaces = this.client.getSpaces();
      const contains = (space: Room, visited = new Set<string>()): boolean => {
        if (visited.has(space.id)) return false; visited.add(space.id);
        return space.children.has(room.id) || spaces.some(child => space.children.has(child.id) && contains(child, visited));
      };
      const parents = spaces.filter(space => contains(space)).map(space => this.notificationMode(space.id));
      mode = parents.includes("mute") ? "mute" : parents.includes("mentions") ? "mentions" : "all";
    }
    if (mode === "mute") return false;
    if (mode === "all") return true;
    return roomMention || mentions.includes(this.client.userId ?? "") || (!!this.client.userId && body.includes(this.client.userId));
  }
  async setMemberLevel(room: Room, userId: string, level: number): Promise<void> {
    if (!/^@[^:\s]+:[^\s]+$/.test(userId) || !Number.isInteger(level) || level < 0 || level > 100 || userId === this.client.userId) throw new Error("Choose another member and a level between 0 and 100");
    return this.serial(async () => {
      const power = await this.client.getRoomPowerLevels(room.id);
      const own = userPowerLevel(power, this.client.userId!, room.creator);
      const target = power.users?.[userId] ?? power.users_default ?? 0;
      if (!canChangeState(power, this.client.userId!, room.creator, "m.room.power_levels") || target >= own || level > own) throw new Error("Your permissions do not allow this role change");
      await this.client.sendStateEvent(room.id, "m.room.power_levels", "", { ...power, users: { ...power.users, [userId]: level } });
    });
  }
  async setThresholds(room: Room, levels: Record<string, number>): Promise<void> {
    return this.serial(async () => {
      const power = await this.client.getRoomPowerLevels(room.id);
      const own = userPowerLevel(power, this.client.userId!, room.creator);
      if (!canChangeState(power, this.client.userId!, room.creator, "m.room.power_levels")) throw new Error("You cannot change room permissions");
      if (Object.entries(levels).some(([key, level]) => !["events_default", "state_default", "invite", "kick", "ban", "redact"].includes(key) || !Number.isInteger(level) || level < 0 || level > own)) throw new Error("Permission thresholds must be whole numbers between 0 and your own power level");
      await this.client.sendStateEvent(room.id, "m.room.power_levels", "", { ...power, ...levels });
    });
  }
  async moderate(room: Room, userId: string, action: "kick" | "ban" | "unban", reason: string): Promise<void> {
    if (!/^@[^:\s]+:[^\s]+$/.test(userId)) throw new Error("Enter a full Matrix user ID");
    const power = await this.client.getRoomPowerLevels(room.id);
    const own = userPowerLevel(power, this.client.userId!, room.creator);
    const target = power.users?.[userId] ?? power.users_default ?? 0;
    if (userId === this.client.userId || own < (power[action === "kick" ? "kick" : "ban"] ?? 50) || target >= own) throw new Error("Your permissions do not allow this moderation action");
    await this.client.api("POST", `${prefix}/rooms/${encodeURIComponent(room.id)}/${action}`, { body: { user_id: userId, reason } });
  }
  async createPoll(roomId: string, question: string, answers: string[], multiple: boolean): Promise<string | null> {
    const choices = answers.map(answer => answer.trim()).filter(Boolean);
    if (!question.trim() || question.length > 500 || choices.length < 2 || choices.length > 20 || choices.some(answer => answer.length > 200) || new Set(choices).size !== choices.length) throw new Error("Enter a question and 2–20 different answers (up to 200 characters each)");
    return this.client.sendRoomEvent(roomId, "org.matrix.msc3381.poll.start", { "org.matrix.msc1767.text": question.trim(), "org.matrix.msc3381.poll.start": { question: { "org.matrix.msc1767.text": question.trim() }, kind: "org.matrix.msc3381.poll.disclosed", max_selections: multiple ? choices.length : 1, answers: choices.map((text, i) => ({ id: `answer-${i}`, "org.matrix.msc1767.text": text })) } });
  }
  private pollEvents = new Map<string, Map<string, { item: MessageItem; local: boolean }>>();
  private pollListeners = new Map<string, Set<() => void>>();
  private redactedPollEvents = new Set<string>();
  private pollKey(roomId: string, rootId: string): string { return `${roomId}\0${rootId}`; }
  cachedPollRelations(roomId: string, rootId: string): MessageItem[] {
    return [...(this.pollEvents.get(this.pollKey(roomId, rootId))?.values() ?? [])].map(event => event.item);
  }
  subscribePoll(roomId: string, rootId: string, listener: () => void): () => void {
    const key = this.pollKey(roomId, rootId); let listeners = this.pollListeners.get(key);
    if (!listeners) { listeners = new Set(); this.pollListeners.set(key, listeners); } listeners.add(listener);
    return () => { listeners!.delete(listener); if (!listeners!.size) this.pollListeners.delete(key); };
  }
  private notifyPoll(key: string): void { for (const listener of this.pollListeners.get(key) ?? []) listener(); }
  recordPollEvent(roomId: string, item: MessageItem, local = false): void {
    if (!item.id || !item.pollEvent || !/poll\.(?:response|end)$/.test(item.pollEvent.type)) return;
    if (this.redactedPollEvents.has(this.pollKey(roomId, item.id))) return;
    const relation = item.pollEvent.content["m.relates_to"] as { event_id?: unknown } | undefined;
    if (typeof relation?.event_id !== "string") return;
    const key = this.pollKey(roomId, relation.event_id);
    let events = this.pollEvents.get(key);
    if (!events) { events = new Map(); this.pollEvents.set(key, events); if (this.pollEvents.size > 128) this.pollEvents.delete(this.pollEvents.keys().next().value!); }
    const previous = events.get(item.id);
    if (previous && !previous.local && local) return;
    if (previous && previous.item.ts === item.ts && previous.item.sender === item.sender && JSON.stringify(previous.item.pollEvent) === JSON.stringify(item.pollEvent)) {
      if (!local) previous.local = false;
      return;
    }
    events.set(item.id, { item, local });
    if (events.size > 10000) events.delete(events.keys().next().value!);
    this.notifyPoll(key);
  }
  redactPollEvent(roomId: string, eventId: string): void {
    this.redactedPollEvents.add(this.pollKey(roomId, eventId));
    if (this.redactedPollEvents.size > 20000) this.redactedPollEvents.delete(this.redactedPollEvents.values().next().value!);
    for (const [key, events] of this.pollEvents) if (key.startsWith(`${roomId}\0`) && events.delete(eventId)) this.notifyPoll(key);
  }
  async pollRelations(roomId: string, eventId: string): Promise<MessageItem[]> {
    const result: MessageItem[] = []; let from: string | undefined; const seen = new Set<string>();
    do {
      const page = await this.client.api<{ chunk: MatrixEvent[]; next_batch?: string }>("GET", `/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(eventId)}/m.reference`, { query: { dir: "f", limit: 100, from } });
      for (const event of page.chunk ?? []) {
        const item = this.client.decodeMessageEvent(roomId, event);
        if (!item && event.type === "m.room.encrypted" && typeof event.content.ciphertext === "string") throw new Error("Some poll responses could not be decrypted. Recover message keys and retry.");
        if (event.unsigned?.redacted_because && event.event_id) this.redactPollEvent(roomId, event.event_id);
        if (item) { this.recordPollEvent(roomId, item); result.push(item); }
      }
      from = page.next_batch; if (from && seen.has(from)) throw new Error("The server repeated a poll results page"); if (from) seen.add(from);
      if (seen.size > 100) throw new Error("Too many poll response pages to load safely");
    } while (from);
    const combined = new Map(result.filter(item => item.id && !this.redactedPollEvents.has(this.pollKey(roomId, item.id))).map(item => [item.id!, item]));
    for (const [id, event] of this.pollEvents.get(this.pollKey(roomId, eventId)) ?? []) combined.set(id, event.item);
    return [...combined.values()];
  }
  async vote(roomId: string, root: MessageItem, answers: string[]): Promise<void> {
    if (!root.id || !root.pollEvent) throw new Error("Poll unavailable"); const poll = parsePoll(root.pollEvent.content);
    if (!poll || answers.length > poll.maxSelections || new Set(answers).size !== answers.length || answers.some(id => !poll.answers.some(answer => answer.id === id))) throw new Error("Choose valid poll answers");
    if (tallyPoll(root, await this.pollRelations(roomId, root.id)).ended) throw new Error("This poll has ended");
    const type = "org.matrix.msc3381.poll.response";
    const content = { "m.relates_to": { rel_type: "m.reference", event_id: root.id }, "org.matrix.msc3381.poll.response": { answers } };
    const id = await this.client.sendRoomEvent(roomId, type, content);
    if (!id) throw new Error("The server did not confirm the vote");
    this.recordPollEvent(roomId, { kind: "message", id, ts: Math.max(Date.now(), root.ts), sender: this.client.userId!, senderName: "You", msgtype: type, body: "Poll response", media: null, pollEvent: { type, content } }, true);
  }
  async endPoll(roomId: string, root: MessageItem): Promise<void> {
    if (!root.id || root.sender !== this.client.userId) throw new Error("Only the poll creator can end this poll");
    const type = "org.matrix.msc3381.poll.end";
    const content = { "m.relates_to": { rel_type: "m.reference", event_id: root.id }, "org.matrix.msc3381.poll.end": {}, "org.matrix.msc1767.text": "Poll ended" };
    const id = await this.client.sendRoomEvent(roomId, type, content);
    if (!id) throw new Error("The server did not confirm closing the poll");
    this.recordPollEvent(roomId, { kind: "message", id, ts: Math.max(Date.now(), root.ts), sender: this.client.userId!, senderName: "You", msgtype: type, body: "Poll ended", media: null, pollEvent: { type, content } }, true);
  }
}
