import { describe, expect, it } from "vitest";
import { authorizeConnect, createAdminApi, hashIp, runMaintenance } from "../src/index.ts";
import { MemoryNotifier } from "../src/memory/index.ts";
import { setup } from "./helpers.ts";

function adminFor(t: ReturnType<typeof setup>) {
  const api = createAdminApi({
    messages: t.messages,
    bans: t.bans,
    notifier: new MemoryNotifier(t.hubs, t.service),
    now: t.clock.now,
  });
  return async (method: string, path: string, body?: unknown) => {
    const res = await api(
      new Request(`https://chat.test/admin/api${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      path.split("?")[0]!,
    );
    return { status: res.status, body: (await res.json()) as any };
  };
}

describe("admin api", () => {
  it("lists, filters and pages messages newest first", async () => {
    const t = setup({ defaults: { rateLimit: "100/min" } });
    const a = await t.join({ room: "r1" });
    const b = await t.join({ room: "r2" });
    for (let i = 0; i < 3; i++) {
      await a.post(`a${i}`);
      t.clock.advance(1);
      await b.post(`b${i}`);
      t.clock.advance(10);
    }
    const admin = adminFor(t);

    const all = await admin("GET", "/messages?limit=4");
    expect(all.body.messages.map((m: any) => m.body)).toEqual(["b2", "a2", "b1", "a1"]);
    const page2 = await admin("GET", `/messages?limit=4&before=${all.body.next}`);
    expect(page2.body.messages.map((m: any) => m.body)).toEqual(["b0", "a0"]);
    expect(page2.body.next).toBeNull();

    const r1 = await admin("GET", "/messages?room=r1");
    expect(r1.body.messages.every((m: any) => m.room === "r1")).toBe(true);
    const byUser = await admin("GET", `/messages?uid=${b.welcome.you.uid}`);
    expect(byUser.body.messages).toHaveLength(3);
  });

  it("deleting a message removes it live for everyone in the room", async () => {
    const t = setup();
    const a = await t.join();
    const b = await t.join();
    await a.post("bad");
    const id = a.peer.last("message")!.message.id;

    const res = await adminFor(t)("DELETE", `/messages/${id}`);
    expect(res.status).toBe(200);
    expect(t.messages.rows).toHaveLength(0);
    expect(b.peer.last("deleted")).toEqual({ type: "deleted", id });
    expect((await adminFor(t)("DELETE", `/messages/${id}`)).status).toBe(404);
  });

  it("deletes a whole room and lists rooms", async () => {
    const t = setup();
    const a = await t.join({ room: "r1" });
    await a.post("x");
    await (await t.join({ room: "r2" })).post("y");
    const admin = adminFor(t);

    expect((await admin("GET", "/rooms")).body.rooms).toHaveLength(2);
    expect((await admin("DELETE", "/rooms/app/r1")).body).toEqual({ deleted: 1 });
    expect(a.peer.last("deleted")).toBeDefined();
    expect((await admin("GET", "/rooms")).body.rooms.map((r: any) => r.room)).toEqual(["r2"]);
  });

  it("bans a user from a message row, kicks them, then lifts the ban", async () => {
    const t = setup();
    const a = await t.join();
    const admin = adminFor(t);
    const uid = a.welcome.you.uid;

    const res = await admin("POST", "/bans", { kind: "uid", value: uid, reason: "spam", app: "app", room: "lobby" });
    expect(res.status).toBe(201);
    expect(res.body.ban.expiresAt).toBeNull();
    expect(a.peer.last("banned")).toBeDefined();
    expect((await admin("GET", "/bans")).body.bans).toHaveLength(1);

    expect((await admin("DELETE", `/bans/uid/${uid}`)).status).toBe(200);
    expect((await admin("GET", "/bans")).body.bans).toHaveLength(0);
  });

  it("supports expiring IP bans and validates input", async () => {
    const t = setup();
    const admin = adminFor(t);
    const res = await admin("POST", "/bans", { kind: "ip", value: "h", durationMs: 86_400_000 });
    expect(res.body.ban.expiresAt).toBe(t.clock.now() + 86_400_000);
    expect((await admin("POST", "/bans", { kind: "email", value: "x" })).status).toBe(400);
    expect((await admin("POST", "/bans", { kind: "ip", value: "x", durationMs: -1 })).status).toBe(400);
    expect((await admin("GET", "/nope")).status).toBe(404);
  });
});

describe("authorizeConnect", () => {
  const origin = "http://localhost:3000";

  const local = { origins: ["http://localhost:*"] };

  it("accepts a valid request and hashes the IP", async () => {
    const t = setup({ defaults: local });
    const r = await authorizeConnect(t, { app: "app", room: "lobby", origin, ip: "1.2.3.4" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.ipHash).toBe(await hashIp(t.hmac, "1.2.3.4"));
  });

  it("rejects bad origin, room policy, and banned IPs", async () => {
    const t = setup({ defaults: local, apps: { fixed: { rooms: ["lobby"] } } });
    const bad = (req: object) => authorizeConnect(t, { app: "app", room: "lobby", origin, ip: "1.1.1.1", ...req });
    expect(await bad({ origin: "https://evil.com" })).toMatchObject({ ok: false, status: 403 });
    expect(await bad({ origin: null })).toMatchObject({ ok: false, status: 403 });
    expect(await bad({ app: "fixed", room: "other" })).toMatchObject({ ok: false, status: 403 });
    expect(await bad({ room: null })).toMatchObject({ ok: false, status: 400 });

    await t.bans.add({ kind: "ip", value: await hashIp(t.hmac, "6.6.6.6"), reason: null, createdAt: 0, expiresAt: null });
    expect(await bad({ ip: "6.6.6.6" })).toMatchObject({ ok: false, reason: "Banned" });
  });
});

describe("authorizeConnect with only listed apps", () => {
  it("rejects app IDs that aren't in the config", async () => {
    const t = setup({ allowUnlistedApps: false, defaults: { origins: ["https://mysite.dev"] }, apps: { mine: {} } });
    const req = { room: "lobby", origin: "https://mysite.dev", ip: null };
    expect(await authorizeConnect(t, { ...req, app: "mine" })).toMatchObject({ ok: true });
    expect(await authorizeConnect(t, { ...req, app: "made-up" })).toEqual({ ok: false, status: 403, reason: "Unknown app" });
  });
});

describe("maintenance", () => {
  it("applies per-app retention and room caps, and expires bans", async () => {
    const day = 86_400_000;
    const t = setup({
      defaults: { retention: "7d", rateLimit: "100/min" },
      apps: { short: { retention: "1d" }, keep: { retention: "forever", maxMessagesPerRoom: 2 } },
    });
    for (const app of ["default-app", "short", "keep"]) {
      const p = await t.join({ app });
      await p.post("old");
      t.clock.advance(1);
      await p.post("old2");
    }
    t.clock.advance(3 * day);
    const fresh = await t.join({ app: "default-app" });
    await fresh.post("new");
    await t.bans.add({ kind: "ip", value: "x", reason: null, createdAt: 0, expiresAt: t.clock.now() - 1 });

    const report = await runMaintenance({ ...t, now: t.clock.now });
    expect(report).toEqual({ expired: 2, trimmed: 0, bansExpired: 1 });
    const left = (app: string) => t.messages.rows.filter((m) => m.app === app).map((m) => m.body);
    expect(left("short")).toEqual([]);
    expect(left("default-app")).toEqual(["old", "old2", "new"]);
    expect(left("keep")).toEqual(["old", "old2"]);

    const k = await t.join({ app: "keep" });
    await k.post("third");
    expect((await runMaintenance({ ...t, now: t.clock.now })).trimmed).toBe(1);
    expect(left("keep")).toEqual(["old2", "third"]);
  });
});
