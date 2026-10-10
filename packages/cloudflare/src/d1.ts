import type { Message } from "@hobbychat/protocol";
import type {
  AppScope,
  Ban,
  BanKind,
  BanStore,
  MessageQuery,
  MessageStore,
  RoomSummary,
  StoredMessage,
} from "@hobbychat/core";

interface MessageRow {
  id: string;
  app: string;
  room: string;
  uid: string;
  name: string;
  ip_hash: string | null;
  body: string;
  created_at: number;
}

interface BanRow {
  kind: BanKind;
  value: string;
  reason: string | null;
  created_at: number;
  expires_at: number | null;
}

function toMessage(r: MessageRow): Message {
  return { id: r.id, room: r.room, uid: r.uid, name: r.name, body: r.body, createdAt: r.created_at };
}

function toStored(r: MessageRow): StoredMessage {
  return { ...toMessage(r), app: r.app, ipHash: r.ip_hash };
}

function toBan(r: BanRow): Ban {
  return { kind: r.kind, value: r.value, reason: r.reason, createdAt: r.created_at, expiresAt: r.expires_at };
}

/** SQL fragment + params restricting a bulk operation to an {@link AppScope}. */
function scopeClause(scope: AppScope): { sql: string; params: string[] } {
  if ("app" in scope) return { sql: "app = ?", params: [scope.app] };
  if (!scope.excludeApps.length) return { sql: "1 = 1", params: [] };
  return { sql: `app NOT IN (${scope.excludeApps.map(() => "?").join(", ")})`, params: scope.excludeApps };
}

export class D1MessageStore implements MessageStore {
  constructor(private readonly db: D1Database) {}

  async append(m: StoredMessage): Promise<void> {
    await this.db
      .prepare(
        "INSERT INTO messages (id, app, room, uid, name, ip_hash, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(m.id, m.app, m.room, m.uid, m.name, m.ipHash, m.body, m.createdAt)
      .run();
  }

  async listRecent(app: string, room: string, limit: number): Promise<Message[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM messages WHERE app = ? AND room = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .bind(app, room, limit)
      .all<MessageRow>();
    return results.reverse().map(toMessage);
  }

  async hasMessages(app: string, room: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 AS found FROM messages WHERE app = ? AND room = ? LIMIT 1")
      .bind(app, room)
      .first();
    return row !== null;
  }

  async countActiveRooms(app: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(DISTINCT room) AS n FROM messages WHERE app = ?")
      .bind(app)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  async delete(id: string): Promise<StoredMessage | null> {
    const row = await this.db
      .prepare("DELETE FROM messages WHERE id = ? RETURNING *")
      .bind(id)
      .first<MessageRow>();
    return row ? toStored(row) : null;
  }

  async deleteRoom(app: string, room: string): Promise<string[]> {
    const { results } = await this.db
      .prepare("DELETE FROM messages WHERE app = ? AND room = ? RETURNING id")
      .bind(app, room)
      .all<{ id: string }>();
    return results.map((r) => r.id);
  }

  async adminQuery(q: MessageQuery): Promise<StoredMessage[]> {
    const where: string[] = [];
    const params: (string | number)[] = [];
    for (const [column, value] of [["app", q.app], ["room", q.room], ["uid", q.uid]] as const) {
      if (value) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (q.before) {
      where.push("(created_at < ? OR (created_at = ? AND id < ?))");
      params.push(q.before.createdAt, q.before.createdAt, q.before.id);
    }
    const sql = `SELECT * FROM messages ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY created_at DESC, id DESC LIMIT ?`;
    const { results } = await this.db.prepare(sql).bind(...params, q.limit).all<MessageRow>();
    return results.map(toStored);
  }

  async listRooms(app?: string): Promise<RoomSummary[]> {
    const sql = `SELECT app, room, COUNT(*) AS count, MAX(created_at) AS lastAt FROM messages
      ${app ? "WHERE app = ?" : ""} GROUP BY app, room ORDER BY lastAt DESC`;
    const stmt = this.db.prepare(sql);
    const { results } = await (app ? stmt.bind(app) : stmt).all<RoomSummary>();
    return results;
  }

  async purgeOlderThan(scope: AppScope, cutoff: number): Promise<number> {
    const { sql, params } = scopeClause(scope);
    const result = await this.db
      .prepare(`DELETE FROM messages WHERE created_at < ? AND ${sql}`)
      .bind(cutoff, ...params)
      .run();
    return result.meta.changes;
  }

  async trimRooms(scope: AppScope, max: number): Promise<number> {
    const { sql, params } = scopeClause(scope);
    const result = await this.db
      .prepare(
        `DELETE FROM messages WHERE id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY app, room ORDER BY created_at DESC, id DESC) AS rn
            FROM messages WHERE ${sql}
          ) WHERE rn > ?
        )`,
      )
      .bind(...params, max)
      .run();
    return result.meta.changes;
  }
}

export class D1BanStore implements BanStore {
  constructor(private readonly db: D1Database) {}

  async find(target: { uid?: string | null; ipHash?: string | null }, now: number): Promise<Ban | null> {
    const match: string[] = [];
    const params: (string | number)[] = [];
    if (target.uid) {
      match.push("(kind = 'uid' AND value = ?)");
      params.push(target.uid);
    }
    if (target.ipHash) {
      match.push("(kind = 'ip' AND value = ?)");
      params.push(target.ipHash);
    }
    if (!match.length) return null;
    const row = await this.db
      .prepare(
        `SELECT * FROM bans WHERE (${match.join(" OR ")}) AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`,
      )
      .bind(...params, now)
      .first<BanRow>();
    return row ? toBan(row) : null;
  }

  async add(ban: Ban): Promise<void> {
    await this.db
      .prepare(
        "INSERT OR REPLACE INTO bans (kind, value, reason, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(ban.kind, ban.value, ban.reason, ban.createdAt, ban.expiresAt)
      .run();
  }

  async remove(kind: BanKind, value: string): Promise<boolean> {
    const result = await this.db.prepare("DELETE FROM bans WHERE kind = ? AND value = ?").bind(kind, value).run();
    return result.meta.changes > 0;
  }

  async list(now: number): Promise<Ban[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM bans WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC")
      .bind(now)
      .all<BanRow>();
    return results.map(toBan);
  }

  async purgeExpired(now: number): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM bans WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .bind(now)
      .run();
    return result.meta.changes;
  }
}
