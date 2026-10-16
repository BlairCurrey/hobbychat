import {
  createAppRegistry,
  RoomService,
  webCryptoHmac,
  type ChatConfig,
  type PeerState,
  type RoomDeps,
} from "../src/index.ts";
import { MemoryBanStore, MemoryMessageStore, MemoryRoomHub } from "../src/memory/index.ts";

export const SECRET = "test-secret-at-least-16-chars";

/** Accepts any app ID unless the test's config says otherwise, so tests needn't list apps. */
export function setup(config: ChatConfig = {}, extra: Partial<RoomDeps> = {}) {
  let time = 1_700_000_000_000;
  const clock = {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
  const messages = new MemoryMessageStore();
  const bans = new MemoryBanStore();
  const registry = createAppRegistry({ allowUnlistedApps: true, ...config });
  const hmac = webCryptoHmac(SECRET);
  const service = new RoomService({ messages, bans, registry, hmac, now: clock.now, ...extra });
  const hubs = new Map<string, MemoryRoomHub>();

  const hub = (app = "app", room = "lobby") => {
    const key = `${app}:${room}`;
    if (!hubs.has(key)) hubs.set(key, new MemoryRoomHub());
    return hubs.get(key)!;
  };

  /** Connect a peer without saying hello. */
  const connect = (opts: { app?: string; room?: string; ipHash?: string | null } = {}) => {
    const app = opts.app ?? "app";
    const room = opts.room ?? "lobby";
    const h = hub(app, room);
    const peer = h.join(service.initialState(app, room, opts.ipHash ?? "iphash-1"));
    const frame = (data: unknown) =>
      service.handleFrame(h, peer, typeof data === "string" ? data : JSON.stringify(data));
    return { peer, hub: h, frame };
  };

  /** Connect and say hello. */
  const join = async (opts: Parameters<typeof connect>[0] & { token?: string } = {}) => {
    const conn = connect(opts);
    await conn.frame({ type: "hello", token: opts.token });
    let n = 0;
    const post = (body: string) => conn.frame({ type: "post", body, clientId: `c${n++}` });
    return { ...conn, post, welcome: conn.peer.last("welcome")! };
  };

  return { clock, messages, bans, registry, hmac, service, hubs, hub, connect, join };
}

export type { PeerState };
