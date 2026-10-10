import {
  CLOSE_BANNED,
  parseClientMessage,
  type ErrorCode,
  type HelloMessage,
  type Identity,
  type Message,
  type PostMessage,
  type ServerMessage,
} from "@hobbychat/protocol";
import type { AppRegistry, RateLimit } from "./config.ts";
import { newId, randomName, signToken, verifyToken, type Hmac } from "./identity.ts";
import type { BanStore, MessageStore } from "./stores.ts";

/**
 * Everything the server remembers about one connection. Must stay small and
 * JSON-serializable: on Cloudflare it lives in the socket's hibernation attachment.
 */
export interface PeerState {
  app: string;
  room: string;
  ipHash: string | null;
  /** Set once the client has said hello. */
  user: Identity | null;
  /** Token bucket for rate limiting. */
  bucket: { tokens: number; at: number };
}

/** One connected socket, as seen by core. */
export interface Peer {
  readonly state: PeerState;
  setState(state: PeerState): void;
  send(message: ServerMessage): void;
  close(code?: number, reason?: string): void;
}

/** Owns the sockets for one room (a Durable Object on Cloudflare; a Map in a single process). */
export interface RoomHub {
  peers(): Peer[];
}

export interface RoomDeps {
  messages: MessageStore;
  bans: BanStore;
  registry: AppRegistry;
  hmac: Hmac;
  now?: () => number;
  newId?: (now: number) => string;
  random?: () => number;
}

export interface KickTarget {
  uid?: string | null;
  ipHash?: string | null;
}

/**
 * Room logic as stateless handlers over injected stores and per-peer state.
 * Nothing is kept in memory between calls, which is what lets a Durable Object hibernate.
 */
export class RoomService {
  private readonly now: () => number;
  private readonly newId: (now: number) => string;
  private readonly random: () => number;

  constructor(private readonly deps: RoomDeps) {
    this.now = deps.now ?? Date.now;
    this.newId = deps.newId ?? newId;
    this.random = deps.random ?? Math.random;
  }

  /** State for a freshly connected peer. The caller has already authorized the connection. */
  initialState(app: string, room: string, ipHash: string | null): PeerState {
    const settings = this.deps.registry.settings(app);
    const capacity = settings?.rateLimit.count ?? 0;
    return { app, room, ipHash, user: null, bucket: { tokens: capacity, at: this.now() } };
  }

  /** Handle one text frame from a peer. */
  async handleFrame(hub: RoomHub, peer: Peer, raw: string): Promise<void> {
    const message = parseClientMessage(raw);
    if (!message) return sendError(peer, "invalid", "Malformed message");
    if (message.type === "hello") return this.hello(peer, message);
    return this.post(hub, peer, message);
  }

  /** Tell everyone in the room that messages were deleted (e.g. by an admin). */
  broadcastDeleted(hub: RoomHub, ids: string[]): void {
    for (const id of ids) broadcast(hub, { type: "deleted", id });
  }

  /** Disconnect peers matching a newly banned uid or IP hash. Returns how many were closed. */
  kick(hub: RoomHub, target: KickTarget): number {
    let closed = 0;
    for (const peer of hub.peers()) {
      const { user, ipHash } = peer.state;
      const uidMatch = target.uid && user?.uid === target.uid;
      const ipMatch = target.ipHash && ipHash === target.ipHash;
      if (uidMatch || ipMatch) {
        ban(peer);
        closed++;
      }
    }
    return closed;
  }

  private async hello(peer: Peer, message: HelloMessage): Promise<void> {
    const state = peer.state;
    if (state.user) return sendError(peer, "invalid", "Already joined");
    const settings = this.deps.registry.settings(state.app);
    if (!settings) return sendError(peer, "invalid", "Unknown app");

    const now = this.now();
    let user = message.token ? await verifyToken(this.deps.hmac, message.token) : null;
    let token = message.token;
    if (!user || !token) {
      user = { uid: this.newId(now), name: randomName(this.random) };
      token = await signToken(this.deps.hmac, user, now);
    }

    if (await this.deps.bans.find({ uid: user.uid, ipHash: state.ipHash }, now)) return ban(peer);

    const history = settings.historyOnJoin
      ? await this.deps.messages.listRecent(state.app, state.room, settings.historyOnJoin)
      : [];
    peer.setState({ ...state, user });
    peer.send({ type: "welcome", you: user, token, history });
  }

  private async post(hub: RoomHub, peer: Peer, message: PostMessage): Promise<void> {
    const state = peer.state;
    const user = state.user;
    if (!user) return sendError(peer, "invalid", "Send hello first");
    const settings = this.deps.registry.settings(state.app);
    if (!settings) return sendError(peer, "invalid", "Unknown app");

    const body = message.body.trim();
    if (!body) return sendError(peer, "invalid", "Empty message");
    if ([...body].length > settings.maxMessageLength) {
      return sendError(peer, "too_long", `Max ${settings.maxMessageLength} characters`);
    }

    // Rate limit before any storage reads so floods stay cheap.
    const now = this.now();
    const bucket = takeToken(state.bucket, settings.rateLimit, now);
    peer.setState({ ...state, bucket: bucket.next });
    if (!bucket.allowed) return sendError(peer, "rate_limited", "Slow down");

    if (await this.deps.bans.find({ uid: user.uid, ipHash: state.ipHash }, now)) return ban(peer);

    // A room only "exists" once it has a message, so the cap is checked on its first post.
    // Concurrent first posts in different rooms can overshoot slightly; the cap is a soft guard.
    if (!(await this.deps.messages.hasMessages(state.app, state.room))) {
      const active = await this.deps.messages.countActiveRooms(state.app);
      if (active >= settings.maxActiveRooms) {
        return sendError(peer, "room_limit", "This app has reached its room limit");
      }
    }

    const stored: Message = {
      id: this.newId(now),
      room: state.room,
      uid: user.uid,
      name: user.name,
      body,
      createdAt: now,
      clientId: message.clientId,
    };
    await this.deps.messages.append({ ...stored, app: state.app, ipHash: state.ipHash });
    broadcast(hub, { type: "message", message: stored });
  }
}

function sendError(peer: Peer, code: ErrorCode, message?: string): void {
  peer.send({ type: "error", code, message });
}

function ban(peer: Peer): void {
  peer.send({ type: "banned" });
  peer.close(CLOSE_BANNED, "banned");
}

function broadcast(hub: RoomHub, message: ServerMessage): void {
  for (const peer of hub.peers()) {
    if (peer.state.user) peer.send(message);
  }
}

/** Token bucket: `count` tokens refilled evenly over `windowMs`. */
export function takeToken(
  bucket: PeerState["bucket"],
  limit: RateLimit,
  now: number,
): { allowed: boolean; next: PeerState["bucket"] } {
  const elapsed = Math.max(0, now - bucket.at);
  const tokens = Math.min(limit.count, bucket.tokens + (elapsed * limit.count) / limit.windowMs);
  if (tokens < 1) return { allowed: false, next: { tokens, at: now } };
  return { allowed: true, next: { tokens: tokens - 1, at: now } };
}
