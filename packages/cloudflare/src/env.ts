import {
  createAppRegistry,
  parseOriginList,
  webCryptoHmac,
  type AppRegistry,
  type BanStore,
  type Hmac,
  type MessageStore,
} from "@hobbychat/core";
import config from "../../../chat.config.ts";
import { D1BanStore, D1MessageStore } from "./d1.ts";
import type { ChatRoom } from "./room.ts";

export interface Env {
  DB: D1Database;
  ROOMS: DurableObjectNamespace<ChatRoom>;
  ASSETS: Fetcher;
  /** Secret: signs user tokens and hashes IPs. */
  HMAC_SECRET: string;
  /** Comma-separated origins added to `defaults.origins`. */
  ALLOWED_ORIGINS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** "true" in .dev.vars only: serves /demo and lets localhost into /admin without Access. */
  DEV_MODE?: string;
}

export interface Deps {
  registry: AppRegistry;
  hmac: Hmac;
  messages: MessageStore;
  bans: BanStore;
}

const cache = new WeakMap<Env, Deps>();

/** Build (once per isolate) the core dependencies from the Worker environment. */
export function deps(env: Env): Deps {
  let d = cache.get(env);
  if (!d) {
    if (!env.HMAC_SECRET) {
      throw new Error("HMAC_SECRET is not set. Run `wrangler secret put HMAC_SECRET` (or add it to .dev.vars).");
    }
    d = {
      registry: createAppRegistry(config, { extraOrigins: parseOriginList(env.ALLOWED_ORIGINS) }),
      hmac: webCryptoHmac(env.HMAC_SECRET),
      messages: new D1MessageStore(env.DB),
      bans: new D1BanStore(env.DB),
    };
    cache.set(env, d);
  }
  return d;
}

export function isDev(env: Env): boolean {
  return env.DEV_MODE === "true";
}

/** Durable Object name for a room. App IDs and room names can't contain ":". */
export function roomName(app: string, room: string): string {
  return `${app}:${room}`;
}

/** Headers the Worker uses to hand authorized connection details to the room. */
export const HEADER = {
  app: "x-hobbychat-app",
  room: "x-hobbychat-room",
  ipHash: "x-hobbychat-ip-hash",
} as const;
