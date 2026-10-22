/** Bounded backward pagination, sync-gap boundaries, and deferred relation replay. */
import type { E2eeCrypto } from "./e2ee.ts";
import type { MatrixTimeline } from "./matrix-timeline.ts";
import type { Room, MatrixEvent, TimelineItem, ApiOptions, RoomUpdate, SyncJoinedRoom } from "./matrix-types.ts";
import { applyRelations } from "./matrix-relations.ts";
const CLIENT_PREFIX = "/_matrix/client/v3";
const TIMELINE_LIMIT = 1000;
export interface HistoryHost {
  readonly crypto: E2eeCrypto | null;
  readonly timeline: MatrixTimeline;
  readonly acknowledged: Map<string, string>;
  readonly seen: Set<string>;
  api<T>(method: string, path: string, options?: ApiOptions): Promise<T>;
  getRoom(roomId: string): Room | null;
  notify(update: RoomUpdate): void;
}
export class MatrixHistory {
  private host: HistoryHost;
  private _latestHistoryCursor = new Map<string, string | null>();
  private _historyEpoch = new Map<string, number>();
  private _historyArrivals = new Map<string, TimelineItem[]>();
  private _historyRelations = new Map<string, Map<string, { event: MatrixEvent; item: TimelineItem | null }>>();
  constructor(host: HistoryHost) { this.host = host; }

  /** Start a contiguous window after a limited sync; callers fetch backward to fill gaps. */
  beginSync(room: Room, timeline: SyncJoinedRoom["timeline"]): { limited: boolean; recoverGap: boolean } {
    const limited = timeline?.limited === true;
    const recoverGap = limited && room.timeline.length > 0;
    if (timeline?.prev_batch !== undefined) this._latestHistoryCursor.set(room.id, timeline.prev_batch);
    if (limited) {
      this._historyEpoch.set(room.id, (this._historyEpoch.get(room.id) ?? 0) + 1);
      room.historyLoading = false;
      room.atLiveEdge = true;
      room.timeline = room.timeline.filter(item => item.kind === "message" && item.pending);
      this.host.timeline.clear(room.id);
      this._historyRelations.delete(room.id);
      for (const event of timeline?.events ?? []) if (event.event_id) this.host.seen.delete(event.event_id);
    }
    if (limited || room.historyCursor === undefined) room.historyCursor = timeline?.prev_batch ?? null;
    return { limited, recoverGap };
  }

  recordArrival(roomId: string, item: TimelineItem): void {
    const arriving = this._historyArrivals.get(roomId);
    if (arriving) { arriving.push(item); if (arriving.length > TIMELINE_LIMIT) arriving.shift(); }
  }

  trimLiveTimeline(room: Room): boolean {
    if (room.timeline.length <= TIMELINE_LIMIT) return false;
    room.timeline.splice(0, room.timeline.length - TIMELINE_LIMIT);
    room.historyCursor = this._latestHistoryCursor.get(room.id) ?? room.historyCursor;
    this.host.timeline.prune(room);
    return true;
  }

  dropRoom(roomId: string): void {
    this.initialLoads.delete(roomId);
    this._latestHistoryCursor.delete(roomId);
    this._historyEpoch.delete(roomId);
    this._historyArrivals.delete(roomId);
    this._historyRelations.delete(roomId);
  }

  rememberRelation(room: Room, event: MatrixEvent, item: TimelineItem | null): void {
    const relation = event.content?.["m.relates_to"] as { rel_type?: string } | undefined;
    if (!event.event_id || !(relation?.rel_type === "m.replace" || event.type === "m.reaction" || event.type === "m.room.redaction")) return;
    let deferred = this._historyRelations.get(room.id);
    if (!deferred) { deferred = new Map(); this._historyRelations.set(room.id, deferred); }
    deferred.set(event.event_id, { event, item });
    while (deferred.size > TIMELINE_LIMIT) deferred.delete(deferred.keys().next().value!);
  }

  private initialHistory = new WeakMap<Room, number>();
  private initialLoads = new Map<string, Promise<void>>();
  /** Hydrate a selected room whose initial sync contained no visible chat messages. */
  ensureRoomHistory(roomId: string): Promise<void> {
    const room = this.host.getRoom(roomId);
    if (!room || room.isSpace || room.timeline.some(item => item.kind === "message")) return Promise.resolve();
    const running = this.initialLoads.get(roomId); if (running) return running;
    const epoch = this._historyEpoch.get(roomId) ?? 0;
    if (room.historyLoading || this.initialHistory.get(room) === epoch) return Promise.resolve();
    const load = (async () => {
      // Skip a few pages of non-message events without scanning unbounded history.
      for (let page = 0; page < 5; page++) {
        if (this.host.getRoom(roomId) !== room || (this._historyEpoch.get(roomId) ?? 0) !== epoch || room.timeline.some(item => item.kind === "message")) return;
        if (room.historyCursor) await this.loadOlderMessages(roomId);
        else if (page === 0) await this.loadLatestMessages(roomId);
        else break;
        if (!room.historyCursor) break;
      }
      if (this.host.getRoom(roomId) === room && (this._historyEpoch.get(roomId) ?? 0) === epoch) this.initialHistory.set(room, epoch);
    })();
    this.initialLoads.set(roomId, load);
    void load.finally(() => { if (this.initialLoads.get(roomId) === load) this.initialLoads.delete(roomId); }).catch(() => {});
    return load;
  }

  async loadOlderMessages(roomId: string): Promise<void> {
    const room = this.host.getRoom(roomId);
    if (!room || room.historyLoading || !room.historyCursor) return;
    await this._loadHistory(room, room.historyCursor, false);
  }

  async loadLatestMessages(roomId: string): Promise<void> {
    const room = this.host.getRoom(roomId);
    if (!room || room.historyLoading) return;
    await this._loadHistory(room, undefined, true);
  }

  private async _loadHistory(room: Room, from: string | undefined, latest: boolean): Promise<void> {
    const epoch = this._historyEpoch.get(room.id) ?? 0;
    const arrivals: TimelineItem[] = [];
    if (latest) this._historyArrivals.set(room.id, arrivals);
    room.historyLoading = true;
    this.host.notify({ room, newEvents: [] });
    try {
      const query: Record<string, string | number> = { dir: "b", limit: 100 };
      if (from) query.from = from;
      const page = await this.host.api<{ chunk?: MatrixEvent[]; end?: string }>(
        "GET", `${CLIENT_PREFIX}/rooms/${encodeURIComponent(room.id)}/messages`, { query }
      );
      if (this.host.getRoom(room.id) !== room || (this._historyEpoch.get(room.id) ?? 0) !== epoch) return;
      const events = [...(page.chunk ?? [])].reverse();
      if (latest) { room.timeline = room.timeline.filter(item => item.kind === "message" && item.pending); room.atLiveEdge = true; this.host.timeline.clear(room.id); }
      const ids = new Set(room.timeline.map(item => item.id));
      const added: TimelineItem[] = [];
      const relations: Array<{ event: MatrixEvent; item: TimelineItem | null }> = [];
      for (const raw of events) {
        if (!raw.event_id || ids.has(raw.event_id)) continue;
        const echoTxn = this.host.acknowledged.get(raw.event_id);
        if (echoTxn) { this.host.timeline.removeEcho(room, echoTxn); this.host.acknowledged.delete(raw.event_id); }
        ids.add(raw.event_id);
        let event = raw;
        if (raw.type === "m.room.encrypted" && this.host.crypto) {
          const decrypted = this.host.crypto.decryptRoomEvent(raw);
          if (decrypted) event = { ...raw, type: decrypted.type, content: decrypted.content };
        }
        if (raw.state_key === undefined && !event.type.startsWith("m.call.") && event.type !== "io.element.call.encryption_keys") {
          this.host.seen.add(raw.event_id);
          if (this.host.seen.size > 20_000) this.host.seen.delete(this.host.seen.values().next().value!);
        }
        const item = event.type === "m.room.encrypted"
          ? this.host.timeline.decryptItem(room, event, true)
          : this.host.timeline.toItem(room, event, true);
        const relation = event.content?.["m.relates_to"] as { rel_type?: string } | undefined;
        if (item && relation?.rel_type !== "m.replace" && !/^(?:m|org.matrix.msc3381)\.poll\.(?:response|end)$/.test(event.type)) added.push(item);
        relations.push({ event, item });
      }
      room.timeline.unshift(...added);
      if (latest) {
        const loaded = new Set(room.timeline.map(item => item.id));
        for (const item of arrivals) if (!loaded.has(item.id)) { room.timeline.push(item); loaded.add(item.id); }
      }
      for (const { event, item } of relations) {
        applyRelations(room, event, item);
        this.rememberRelation(room, event, item);
      }
      for (const { event, item } of this._historyRelations.get(room.id)?.values() ?? []) applyRelations(room, event, item);
      room.historyCursor = page.end && page.end !== from ? page.end : null;
      if (room.timeline.length > TIMELINE_LIMIT) {
        room.timeline.splice(TIMELINE_LIMIT);
        room.atLiveEdge = false;
      }
      this.host.timeline.prune(room);
      this.host.notify({ room, newEvents: [], redraw: true });
    } finally {
      if (this._historyArrivals.get(room.id) === arrivals) this._historyArrivals.delete(room.id);
      if ((this._historyEpoch.get(room.id) ?? 0) === epoch) {
        room.historyLoading = false;
        if (this.host.getRoom(room.id) === room) this.host.notify({ room, newEvents: [] });
      }
    }
  }
}
