import { describe, expect, it } from "vitest";
import {
  compileOrigins,
  createAppRegistry,
  isRoomAllowed,
  parseDuration,
  parseOriginList,
  parseRateLimit,
} from "../src/index.ts";

describe("origin matching", () => {
  const m = compileOrigins(["https://*.yourname.dev", "http://localhost:*", "https://example.com"]);

  it.each([
    ["https://chat.yourname.dev", true],
    ["https://a.b.yourname.dev", true],
    ["https://yourname.dev", false],
    ["http://chat.yourname.dev", false],
    ["https://evilyourname.dev", false],
    ["https://chat.yourname.dev.evil.com", false],
    ["http://localhost:5173", true],
    ["http://localhost", true],
    ["https://localhost:5173", false],
    ["https://example.com", true],
    ["https://example.com:443", true],
    ["https://example.com:8443", false],
    ["https://EXAMPLE.com", true],
    ["null", false],
    ["", false],
  ])("%s → %s", (origin, expected) => {
    expect(m.matches(origin)).toBe(expected);
  });

  it("supports * for any origin", () => {
    expect(compileOrigins(["*"]).matches("https://anything.example")).toBe(true);
  });

  it("rejects malformed patterns", () => {
    expect(() => compileOrigins(["example.com"])).toThrow(/Invalid origin pattern/);
    expect(() => compileOrigins(["https://example.com/path"])).toThrow();
  });

  it("parses comma/space separated env lists", () => {
    expect(parseOriginList(" https://a.dev, https://b.dev  https://c.dev ")).toEqual([
      "https://a.dev",
      "https://b.dev",
      "https://c.dev",
    ]);
    expect(parseOriginList(undefined)).toEqual([]);
  });
});

describe("room policy", () => {
  it("open accepts any valid slug", () => {
    expect(isRoomAllowed("open", "game-1")).toBe(true);
    expect(isRoomAllowed("open", "Bad Room")).toBe(false);
    expect(isRoomAllowed("open", "a:b")).toBe(false);
    expect(isRoomAllowed("open", "x".repeat(65))).toBe(false);
  });

  it("list accepts only listed rooms", () => {
    expect(isRoomAllowed(["lobby"], "lobby")).toBe(true);
    expect(isRoomAllowed(["lobby"], "other")).toBe(false);
  });

  it("regex is tested safely even with the global flag", () => {
    const re = /^game-\d+$/g;
    expect(isRoomAllowed(re, "game-1")).toBe(true);
    expect(isRoomAllowed(re, "game-1")).toBe(true);
    expect(isRoomAllowed(re, "lobby")).toBe(false);
  });
});

describe("parsing", () => {
  it("durations", () => {
    expect(parseDuration("30d")).toBe(30 * 86_400_000);
    expect(parseDuration("12h")).toBe(12 * 3_600_000);
    expect(parseDuration("forever")).toBeNull();
    expect(() => parseDuration("soon")).toThrow(/Invalid duration/);
  });

  it("rate limits", () => {
    expect(parseRateLimit("10/min")).toEqual({ count: 10, windowMs: 60_000 });
    expect(() => parseRateLimit("0/min")).toThrow();
    expect(() => parseRateLimit("10 per minute")).toThrow();
  });
});

describe("app registry", () => {
  const registry = createAppRegistry(
    {
      allowUnlistedApps: true,
      defaults: { origins: ["https://*.me.dev"], retention: "7d" },
      apps: {
        scores: { rooms: /^game-\d+$/, retention: "3d" },
        pets: { origins: ["https://pets.example"], rooms: ["lobby"] },
      },
    },
    { extraOrigins: ["https://extra.dev"] },
  );

  it("can accept unlisted apps from default origins", () => {
    const r = registry.resolve("anything", "https://x.me.dev");
    expect(r.ok && r.settings.retentionMs).toBe(7 * 86_400_000);
    expect(registry.resolve("anything", "https://extra.dev").ok).toBe(true);
  });

  it("rejects missing or disallowed origins and bad app IDs", () => {
    expect(registry.resolve("anything", null)).toEqual({ ok: false, reason: "origin_not_allowed" });
    expect(registry.resolve("anything", "https://evil.com")).toEqual({ ok: false, reason: "origin_not_allowed" });
    expect(registry.resolve("Bad App", "https://x.me.dev")).toEqual({ ok: false, reason: "invalid_app" });
  });

  it("applies per-app overrides on top of defaults", () => {
    const scores = registry.settings("scores")!;
    expect(scores.retentionMs).toBe(3 * 86_400_000);
    expect(scores.maxMessageLength).toBe(500);
    expect(scores.origins.matches("https://x.me.dev")).toBe(true);
  });

  it("explicit origins replace defaults", () => {
    expect(registry.resolve("pets", "https://pets.example").ok).toBe(true);
    expect(registry.resolve("pets", "https://x.me.dev").ok).toBe(false);
  });

  it("allows no origins out of the box", () => {
    const bare = createAppRegistry({ apps: { anything: {} } });
    expect(bare.resolve("anything", "http://localhost:5173")).toEqual({ ok: false, reason: "origin_not_allowed" });
    expect(bare.resolve("anything", "https://example.com")).toEqual({ ok: false, reason: "origin_not_allowed" });
  });

  it("accepts only listed apps by default, which local dev can override", () => {
    const config = { defaults: { origins: ["https://me.dev"] }, apps: { listed: {} } };
    const strict = createAppRegistry(config);
    expect(strict.resolve("listed", "https://me.dev").ok).toBe(true);
    expect(strict.resolve("made-up", "https://me.dev")).toEqual({ ok: false, reason: "unknown_app" });
    expect(strict.resolve("Bad App", "https://me.dev")).toEqual({ ok: false, reason: "invalid_app" });
    expect(strict.settings("made-up")).toBeNull();
    expect(createAppRegistry(config, { allowUnlistedApps: true }).resolve("made-up", "https://me.dev").ok).toBe(true);
  });

  it("validates config eagerly with helpful errors", () => {
    expect(() => createAppRegistry({ apps: { x: { retention: "1 year" } } })).toThrow(/apps\.x.*Invalid duration/);
    expect(() => createAppRegistry({ apps: { "Bad App": {} } })).toThrow(/app ID/);
    expect(() => createAppRegistry({ defaults: { rooms: ["Lobby"] } })).toThrow(/room "Lobby"/);
  });
});
