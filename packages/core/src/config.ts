import { compileOrigins, type OriginMatcher } from "./origin.ts";
import { isValidSlug } from "./rooms.ts";

/** Which room names an app accepts. */
export type RoomPolicy = "open" | readonly string[] | RegExp;

/** Settings an app can have. Every field is optional in config; unset fields fall back to `defaults`. */
export interface AppSettings {
  /** Allowed page origins. Supports `*` wildcards for subdomains (`https://*.example.com`) and ports (`http://localhost:*`). */
  origins: string[];
  rooms: RoomPolicy;
  /** Max rooms with at least one stored message, per app. */
  maxActiveRooms: number;
  /** How long messages are kept, e.g. `"30d"`, `"12h"`, or `"forever"`. */
  retention: string;
  /** Optional cap per room; the oldest messages are trimmed by the daily cleanup. */
  maxMessagesPerRoom: number | null;
  maxMessageLength: number;
  /** Per connection, e.g. `"10/min"`. Units: sec, min, hour, day. */
  rateLimit: string;
  /** Number of recent messages sent to a client when it joins. */
  historyOnJoin: number;
}

export interface ChatConfig {
  /**
   * Accept app IDs that have no entry under `apps` (using `defaults`). Default false: only
   * the apps you list work, so strangers can't invent app IDs to get more rooms.
   */
  allowUnlistedApps?: boolean;
  defaults?: Partial<AppSettings>;
  apps?: Record<string, Partial<AppSettings>>;
}

/** Identity helper that gives `chat.config.ts` type checking. */
export function defineConfig(config: ChatConfig): ChatConfig {
  return config;
}

export const BUILTIN_DEFAULTS: AppSettings = {
  // Nothing by default: list your sites here or in ALLOWED_ORIGINS. Local dev adds localhost.
  origins: [],
  rooms: "open",
  maxActiveRooms: 50,
  retention: "30d",
  maxMessagesPerRoom: null,
  maxMessageLength: 500,
  rateLimit: "10/min",
  historyOnJoin: 50,
};

export interface RateLimit {
  count: number;
  windowMs: number;
}

/** App settings after parsing and validation. */
export interface ResolvedSettings {
  origins: OriginMatcher;
  rooms: RoomPolicy;
  maxActiveRooms: number;
  /** null = keep forever. */
  retentionMs: number | null;
  maxMessagesPerRoom: number | null;
  maxMessageLength: number;
  rateLimit: RateLimit;
  historyOnJoin: number;
}

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  m: 60_000,
  min: 60_000,
  h: 3_600_000,
  hour: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  w: 7 * 86_400_000,
};

/** Parse `"30d"`, `"12h"`, `"90m"`, `"2w"`, `"45s"`. Returns null for `"forever"`. */
export function parseDuration(value: string): number | null {
  if (value === "forever") return null;
  const match = /^(\d+)\s*(s|m|h|d|w)$/.exec(value.trim());
  if (!match) throw new Error(`Invalid duration "${value}" (expected e.g. "30d", "12h", or "forever")`);
  return Number(match[1]) * UNIT_MS[match[2]!]!;
}

/** Parse `"10/min"` style rate limits. */
export function parseRateLimit(value: string): RateLimit {
  const match = /^(\d+)\s*\/\s*(sec|min|hour|day)$/.exec(value.trim());
  if (!match || Number(match[1]) < 1) {
    throw new Error(`Invalid rateLimit "${value}" (expected e.g. "10/min"; units: sec, min, hour, day)`);
  }
  return { count: Number(match[1]), windowMs: UNIT_MS[match[2]!]! };
}

function positiveInt(name: string, value: number, allowZero = false): number {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer, got ${value}`);
  }
  return value;
}

function resolveSettings(label: string, s: AppSettings): ResolvedSettings {
  try {
    if (Array.isArray(s.rooms)) {
      for (const room of s.rooms) {
        if (!isValidSlug(room)) throw new Error(`room "${room}" must match ^[a-z0-9_-]{1,64}$`);
      }
    } else if (s.rooms !== "open" && !(s.rooms instanceof RegExp)) {
      throw new Error(`rooms must be "open", a list of names, or a RegExp`);
    }
    return {
      origins: compileOrigins(s.origins),
      rooms: s.rooms,
      maxActiveRooms: positiveInt("maxActiveRooms", s.maxActiveRooms),
      retentionMs: parseDuration(s.retention),
      maxMessagesPerRoom:
        s.maxMessagesPerRoom === null ? null : positiveInt("maxMessagesPerRoom", s.maxMessagesPerRoom),
      maxMessageLength: positiveInt("maxMessageLength", s.maxMessageLength),
      rateLimit: parseRateLimit(s.rateLimit),
      historyOnJoin: positiveInt("historyOnJoin", s.historyOnJoin, true),
    };
  } catch (err) {
    throw new Error(`chat config (${label}): ${(err as Error).message}`);
  }
}

export type ResolveResult =
  | { ok: true; settings: ResolvedSettings }
  | { ok: false; reason: "invalid_app" | "unknown_app" | "origin_not_allowed" };

/** Turns an app ID (and the connecting page's origin) into effective settings. */
export interface AppRegistry {
  /** Settings for an app ID regardless of origin, or null if the ID is malformed or not accepted. */
  settings(appId: string): ResolvedSettings | null;
  /** Settings for a connecting browser; rejects disallowed origins. */
  resolve(appId: string, origin: string | null): ResolveResult;
  /** Apps with explicit entries in config. */
  configuredApps(): string[];
  /** Settings used by apps without an explicit entry. */
  defaults(): ResolvedSettings;
}

export interface RegistryOptions {
  /** Extra origins added to `defaults.origins`, e.g. from an `ALLOWED_ORIGINS` env var. */
  extraOrigins?: string[];
  /** Overrides `allowUnlistedApps` from config (e.g. always allow in local development). */
  allowUnlistedApps?: boolean;
}

/** Origins that local development (`pnpm dev`) accepts on top of the config. */
export const LOCAL_ORIGINS = ["http://localhost:*", "http://127.0.0.1:*"];

/** Build an {@link AppRegistry} from config. Validates everything eagerly and throws on bad config. */
export function createAppRegistry(config: ChatConfig, options: RegistryOptions = {}): AppRegistry {
  const baseDefaults: AppSettings = { ...BUILTIN_DEFAULTS, ...config.defaults };
  const defaultsRaw: AppSettings = {
    ...baseDefaults,
    origins: [...baseDefaults.origins, ...(options.extraOrigins ?? [])],
  };
  const defaults = resolveSettings("defaults", defaultsRaw);
  const apps = new Map<string, ResolvedSettings>();
  for (const [appId, overrides] of Object.entries(config.apps ?? {})) {
    if (!isValidSlug(appId)) throw new Error(`chat config: app ID "${appId}" must match ^[a-z0-9_-]{1,64}$`);
    apps.set(appId, resolveSettings(`apps.${appId}`, { ...defaultsRaw, ...overrides }));
  }

  const allowUnlisted = options.allowUnlistedApps ?? config.allowUnlistedApps ?? false;

  const settings = (appId: string): ResolvedSettings | null => {
    if (!isValidSlug(appId)) return null;
    return apps.get(appId) ?? (allowUnlisted ? defaults : null);
  };

  return {
    settings,
    resolve(appId, origin) {
      const s = settings(appId);
      if (!s) return { ok: false, reason: isValidSlug(appId) ? "unknown_app" : "invalid_app" };
      if (!origin || !s.origins.matches(origin)) return { ok: false, reason: "origin_not_allowed" };
      return { ok: true, settings: s };
    },
    configuredApps: () => [...apps.keys()],
    defaults: () => defaults,
  };
}

/** Split a comma/whitespace separated env var into origin patterns. */
export function parseOriginList(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
