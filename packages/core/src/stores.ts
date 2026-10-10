import type { Message } from "@hobbychat/protocol";

/** A message as persisted, with the fields the wire format doesn't expose. */
export interface StoredMessage extends Message {
  app: string;
  ipHash: string | null;
}

export interface MessageQuery {
  app?: string;
  room?: string;
  uid?: string;
  /** Return messages strictly older than this cursor (for paging). */
  before?: { createdAt: number; id: string };
  limit: number;
}

export interface RoomSummary {
  app: string;
  room: string;
  count: number;
  lastAt: number;
}

/** Scope for bulk maintenance: one app, or every app except some. */
export type AppScope = { app: string } | { excludeApps: string[] };

export interface MessageStore {
  append(message: StoredMessage): Promise<void>;
  /** Most recent `limit` messages in a room, oldest first. */
  listRecent(app: string, room: string, limit: number): Promise<Message[]>;
  hasMessages(app: string, room: string): Promise<boolean>;
  /** Number of rooms in an app with at least one stored message. */
  countActiveRooms(app: string): Promise<number>;
  /** Hard-delete a message. Returns it, or null if it didn't exist. */
  delete(id: string): Promise<StoredMessage | null>;
  /** Hard-delete every message in a room. Returns the deleted IDs. */
  deleteRoom(app: string, room: string): Promise<string[]>;
  /** Newest first. */
  adminQuery(query: MessageQuery): Promise<StoredMessage[]>;
  /** Rooms with at least one message, most recently active first. */
  listRooms(app?: string): Promise<RoomSummary[]>;
  /** Delete messages created before `cutoff`. Returns the number deleted. */
  purgeOlderThan(scope: AppScope, cutoff: number): Promise<number>;
  /** Keep only the newest `max` messages in each room. Returns the number deleted. */
  trimRooms(scope: AppScope, max: number): Promise<number>;
}

export type BanKind = "uid" | "ip";

export interface Ban {
  kind: BanKind;
  value: string;
  reason: string | null;
  createdAt: number;
  /** null = permanent. */
  expiresAt: number | null;
}

export interface BanStore {
  /** The first active ban matching either the uid or the IP hash, if any. */
  find(target: { uid?: string | null; ipHash?: string | null }, now: number): Promise<Ban | null>;
  /** Insert or replace a ban. */
  add(ban: Ban): Promise<void>;
  remove(kind: BanKind, value: string): Promise<boolean>;
  /** Active bans, newest first. */
  list(now: number): Promise<Ban[]>;
  purgeExpired(now: number): Promise<number>;
}
