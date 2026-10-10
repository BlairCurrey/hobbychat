/**
 * In-memory adapters. Used by tests to prove the seams, and a starting point
 * for a single-process (e.g. Node) host.
 */
import type { Message, ServerMessage } from "@hobbychat/protocol";
import type { RoomNotifier } from "../admin.ts";
import type { KickTarget, Peer, PeerState, RoomHub, RoomService } from "../room.ts";
import type {
  AppScope,
  Ban,
  BanKind,
  BanStore,
  MessageQuery,
  MessageStore,
  RoomSummary,
  StoredMessage,
} from "../stores.ts";

function inScope(app: string, scope: AppScope): boolean {
  return "app" in scope ? app === scope.app : !scope.excludeApps.includes(app);
}

function newestFirst(a: StoredMessage, b: StoredMessage): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

function toWire({ app: _app, ipHash: _ip, ...message }: StoredMessage): Message {
  return message;
}

export class MemoryMessageStore implements MessageStore {
  readonly rows: StoredMessage[] = [];

  async append(message: StoredMessage): Promise<void> {
    this.rows.push({ ...message });
  }

  async listRecent(app: string, room: string, limit: number): Promise<Message[]> {
    return this.rows
      .filter((m) => m.app === app && m.room === room)
      .sort(newestFirst)
      .slice(0, limit)
      .reverse()
      .map(toWire);
  }

  async hasMessages(app: string, room: string): Promise<boolean> {
    return this.rows.some((m) => m.app === app && m.room === room);
  }

  async countActiveRooms(app: string): Promise<number> {
    return new Set(this.rows.filter((m) => m.app === app).map((m) => m.room)).size;
  }

  async delete(id: string): Promise<StoredMessage | null> {
    const index = this.rows.findIndex((m) => m.id === id);
    if (index === -1) return null;
    return this.rows.splice(index, 1)[0]!;
  }

  async deleteRoom(app: string, room: string): Promise<string[]> {
    return this.remove((m) => m.app === app && m.room === room).map((m) => m.id);
  }

  async adminQuery(q: MessageQuery): Promise<StoredMessage[]> {
    return this.rows
      .filter(
        (m) =>
          (!q.app || m.app === q.app) &&
          (!q.room || m.room === q.room) &&
          (!q.uid || m.uid === q.uid) &&
          (!q.before ||
            m.createdAt < q.before.createdAt ||
            (m.createdAt === q.before.createdAt && m.id < q.before.id)),
      )
      .sort(newestFirst)
      .slice(0, q.limit)
      .map((m) => ({ ...m }));
  }

  async listRooms(app?: string): Promise<RoomSummary[]> {
    const rooms = new Map<string, RoomSummary>();
    for (const m of this.rows) {
      if (app && m.app !== app) continue;
      const key = `${m.app}:${m.room}`;
      const summary = rooms.get(key) ?? { app: m.app, room: m.room, count: 0, lastAt: 0 };
      summary.count++;
      summary.lastAt = Math.max(summary.lastAt, m.createdAt);
      rooms.set(key, summary);
    }
    return [...rooms.values()].sort((a, b) => b.lastAt - a.lastAt);
  }

  async purgeOlderThan(scope: AppScope, cutoff: number): Promise<number> {
    return this.remove((m) => inScope(m.app, scope) && m.createdAt < cutoff).length;
  }

  async trimRooms(scope: AppScope, max: number): Promise<number> {
    const doomed = new Set<StoredMessage>();
    const byRoom = new Map<string, StoredMessage[]>();
    for (const m of this.rows) {
      if (!inScope(m.app, scope)) continue;
      const key = `${m.app}:${m.room}`;
      byRoom.set(key, [...(byRoom.get(key) ?? []), m]);
    }
    for (const messages of byRoom.values()) {
      for (const m of messages.sort(newestFirst).slice(max)) doomed.add(m);
    }
    return this.remove((m) => doomed.has(m)).length;
  }

  private remove(predicate: (m: StoredMessage) => boolean): StoredMessage[] {
    const removed: StoredMessage[] = [];
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (predicate(this.rows[i]!)) removed.push(...this.rows.splice(i, 1));
    }
    return removed.reverse();
  }
}

export class MemoryBanStore implements BanStore {
  private readonly bans = new Map<string, Ban>();

  async find(target: { uid?: string | null; ipHash?: string | null }, now: number): Promise<Ban | null> {
    const candidates = [
      target.uid ? this.bans.get(`uid:${target.uid}`) : undefined,
      target.ipHash ? this.bans.get(`ip:${target.ipHash}`) : undefined,
    ];
    return candidates.find((b) => b && (b.expiresAt === null || b.expiresAt > now)) ?? null;
  }

  async add(ban: Ban): Promise<void> {
    this.bans.set(`${ban.kind}:${ban.value}`, { ...ban });
  }

  async remove(kind: BanKind, value: string): Promise<boolean> {
    return this.bans.delete(`${kind}:${value}`);
  }

  async list(now: number): Promise<Ban[]> {
    return [...this.bans.values()]
      .filter((b) => b.expiresAt === null || b.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async purgeExpired(now: number): Promise<number> {
    let count = 0;
    for (const [key, ban] of this.bans) {
      if (ban.expiresAt !== null && ban.expiresAt <= now) {
        this.bans.delete(key);
        count++;
      }
    }
    return count;
  }
}

/** A fake socket that records what the server sent it. */
export class MemoryPeer implements Peer {
  readonly sent: ServerMessage[] = [];
  closed: { code?: number; reason?: string } | null = null;

  constructor(
    private hub: MemoryRoomHub,
    public state: PeerState,
  ) {}

  setState(state: PeerState): void {
    this.state = state;
  }

  send(message: ServerMessage): void {
    if (!this.closed) this.sent.push(structuredClone(message));
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.hub.remove(this);
  }

  /** Most recent message of a given type. */
  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    return this.sent.findLast((m) => m.type === type) as Extract<ServerMessage, { type: T }> | undefined;
  }
}

export class MemoryRoomHub implements RoomHub {
  private readonly members = new Set<MemoryPeer>();

  join(state: PeerState): MemoryPeer {
    const peer = new MemoryPeer(this, state);
    this.members.add(peer);
    return peer;
  }

  remove(peer: MemoryPeer): void {
    this.members.delete(peer);
  }

  peers(): MemoryPeer[] {
    return [...this.members];
  }
}

/** Routes admin notifications to in-memory hubs keyed by `app:room`. */
export class MemoryNotifier implements RoomNotifier {
  constructor(
    private readonly hubs: Map<string, MemoryRoomHub>,
    private readonly service: RoomService,
  ) {}

  async deleted(app: string, room: string, ids: string[]): Promise<void> {
    const hub = this.hubs.get(`${app}:${room}`);
    if (hub) this.service.broadcastDeleted(hub, ids);
  }

  async kick(app: string, room: string, target: KickTarget): Promise<void> {
    const hub = this.hubs.get(`${app}:${room}`);
    if (hub) this.service.kick(hub, target);
  }
}
