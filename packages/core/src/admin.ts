import type { KickTarget } from "./room.ts";
import { isValidSlug } from "./rooms.ts";
import type { BanKind, BanStore, MessageStore, StoredMessage } from "./stores.ts";

/** Pushes admin actions into live rooms (Durable Object RPC on Cloudflare). */
export interface RoomNotifier {
  deleted(app: string, room: string, ids: string[]): Promise<void>;
  kick(app: string, room: string, target: KickTarget): Promise<void>;
}

export interface AdminDeps {
  messages: MessageStore;
  bans: BanStore;
  notifier: RoomNotifier;
  now?: () => number;
}

/** Wire shape of a message in the admin API. */
export type AdminMessage = StoredMessage & { cursor: string };

export interface BanRequest {
  kind: BanKind;
  value: string;
  reason?: string | null;
  /** Omit or null for a permanent ban. */
  durationMs?: number | null;
  /** Room to disconnect the user from right away (e.g. where the offending message was posted). */
  app?: string;
  room?: string;
}

const MAX_LIMIT = 200;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function fail(status: number, error: string): Response {
  return json({ error }, status);
}

function encodeCursor(m: StoredMessage): string {
  return `${m.createdAt}_${m.id}`;
}

function decodeCursor(value: string | null): { createdAt: number; id: string } | undefined {
  if (!value) return undefined;
  const [time, id] = value.split("_");
  const createdAt = Number(time);
  if (!id || !Number.isFinite(createdAt)) return undefined;
  return { createdAt, id };
}

/**
 * The admin JSON API as a plain `Request → Response` handler. The caller is
 * responsible for authenticating the request and stripping the `/admin/api` prefix.
 *
 * Routes:
 * - `GET    /messages?app&room&uid&before&limit`
 * - `DELETE /messages/:id`
 * - `GET    /rooms?app`
 * - `DELETE /rooms/:app/:room`
 * - `GET    /bans`
 * - `POST   /bans` body: {@link BanRequest}
 * - `DELETE /bans/:kind/:value`
 */
export function createAdminApi(deps: AdminDeps): (request: Request, path: string) => Promise<Response> {
  const now = deps.now ?? Date.now;

  return async (request, path) => {
    const url = new URL(request.url);
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const method = request.method;
    const [resource, a, b] = parts;

    if (resource === "messages" && parts.length === 1 && method === "GET") {
      const limit = Math.min(Number(url.searchParams.get("limit")) || 50, MAX_LIMIT);
      const rows = await deps.messages.adminQuery({
        app: url.searchParams.get("app") || undefined,
        room: url.searchParams.get("room") || undefined,
        uid: url.searchParams.get("uid") || undefined,
        before: decodeCursor(url.searchParams.get("before")),
        limit,
      });
      const messages: AdminMessage[] = rows.map((m) => ({ ...m, cursor: encodeCursor(m) }));
      return json({ messages, next: rows.length === limit ? encodeCursor(rows.at(-1)!) : null });
    }

    if (resource === "messages" && parts.length === 2 && method === "DELETE") {
      const deleted = await deps.messages.delete(a!);
      if (!deleted) return fail(404, "Message not found");
      await deps.notifier.deleted(deleted.app, deleted.room, [deleted.id]);
      return json({ deleted: deleted.id });
    }

    if (resource === "rooms" && parts.length === 1 && method === "GET") {
      return json({ rooms: await deps.messages.listRooms(url.searchParams.get("app") || undefined) });
    }

    if (resource === "rooms" && parts.length === 3 && method === "DELETE") {
      if (!isValidSlug(a!) || !isValidSlug(b!)) return fail(400, "Invalid app or room");
      const ids = await deps.messages.deleteRoom(a!, b!);
      if (ids.length) await deps.notifier.deleted(a!, b!, ids);
      return json({ deleted: ids.length });
    }

    if (resource === "bans" && parts.length === 1 && method === "GET") {
      return json({ bans: await deps.bans.list(now()) });
    }

    if (resource === "bans" && parts.length === 1 && method === "POST") {
      let body: BanRequest;
      try {
        body = (await request.json()) as BanRequest;
      } catch {
        return fail(400, "Invalid JSON");
      }
      if (body.kind !== "uid" && body.kind !== "ip") return fail(400, 'kind must be "uid" or "ip"');
      if (typeof body.value !== "string" || !body.value) return fail(400, "value is required");
      const duration = body.durationMs ?? null;
      if (duration !== null && !(Number.isFinite(duration) && duration > 0)) {
        return fail(400, "durationMs must be a positive number or null");
      }
      const createdAt = now();
      const ban = {
        kind: body.kind,
        value: body.value,
        reason: typeof body.reason === "string" && body.reason ? body.reason.slice(0, 500) : null,
        createdAt,
        expiresAt: duration === null ? null : createdAt + duration,
      };
      await deps.bans.add(ban);
      if (body.app && body.room && isValidSlug(body.app) && isValidSlug(body.room)) {
        await deps.notifier.kick(body.app, body.room, body.kind === "uid" ? { uid: body.value } : { ipHash: body.value });
      }
      return json({ ban }, 201);
    }

    if (resource === "bans" && parts.length === 3 && method === "DELETE") {
      if (a !== "uid" && a !== "ip") return fail(400, 'kind must be "uid" or "ip"');
      if (!(await deps.bans.remove(a, b!))) return fail(404, "Ban not found");
      return json({ removed: true });
    }

    return fail(404, "Not found");
  };
}
