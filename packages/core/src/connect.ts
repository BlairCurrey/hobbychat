import type { AppRegistry, ResolvedSettings } from "./config.ts";
import { hashIp, type Hmac } from "./identity.ts";
import { isRoomAllowed } from "./rooms.ts";
import type { BanStore } from "./stores.ts";

export interface ConnectRequest {
  app: string | null;
  room: string | null;
  origin: string | null;
  ip: string | null;
}

export type ConnectResult =
  | { ok: true; app: string; room: string; ipHash: string | null; settings: ResolvedSettings }
  | { ok: false; status: 400 | 403; reason: string };

/**
 * Validate a WebSocket upgrade before it reaches a room: app config, origin
 * allowlist, room policy, and IP bans. Runs in the stateless router.
 */
export async function authorizeConnect(
  deps: { registry: AppRegistry; bans: BanStore; hmac: Hmac; now?: () => number },
  req: ConnectRequest,
): Promise<ConnectResult> {
  if (!req.app || !req.room) return { ok: false, status: 400, reason: "app and room are required" };
  const resolved = deps.registry.resolve(req.app, req.origin);
  if (!resolved.ok) {
    if (resolved.reason === "invalid_app") return { ok: false, status: 400, reason: "Invalid app ID" };
    if (resolved.reason === "unknown_app") return { ok: false, status: 403, reason: "Unknown app" };
    return { ok: false, status: 403, reason: "Origin not allowed" };
  }
  if (!isRoomAllowed(resolved.settings.rooms, req.room)) {
    return { ok: false, status: 403, reason: "Room not allowed" };
  }
  const ipHash = req.ip ? await hashIp(deps.hmac, req.ip) : null;
  if (ipHash && (await deps.bans.find({ ipHash }, (deps.now ?? Date.now)()))) {
    return { ok: false, status: 403, reason: "Banned" };
  }
  return { ok: true, app: req.app, room: req.room, ipHash, settings: resolved.settings };
}
