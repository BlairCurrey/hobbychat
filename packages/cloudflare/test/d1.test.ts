import { env } from "cloudflare:workers";
import type { StoredMessage } from "@hobbychat/core";
import { beforeEach, describe, expect, it } from "vitest";
import { D1BanStore, D1MessageStore } from "../src/d1.ts";

const messages = new D1MessageStore(env.DB);
const bans = new D1BanStore(env.DB);

let seq = 0;
function msg(app: string, room: string, createdAt: number, extra: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: `id-${String(seq++).padStart(4, "0")}`,
    app,
    room,
    uid: "u1",
    name: "quiet-otter",
    body: `body ${seq}`,
    createdAt,
    ipHash: "ip1",
    ...extra,
  };
}

beforeEach(async () => {
  await env.DB.exec("DELETE FROM messages; DELETE FROM bans;");
});

describe("D1MessageStore", () => {
  it("lists recent messages oldest first and checks existence", async () => {
    for (let i = 0; i < 5; i++) await messages.append(msg("a", "lobby", 1000 + i));
    await messages.append(msg("a", "other", 999));
    const recent = await messages.listRecent("a", "lobby", 3);
    expect(recent.map((m) => m.createdAt)).toEqual([1002, 1003, 1004]);
    expect(recent[0]).not.toHaveProperty("ipHash");
    expect(await messages.hasMessages("a", "lobby")).toBe(true);
    expect(await messages.hasMessages("a", "empty")).toBe(false);
    expect(await messages.countActiveRooms("a")).toBe(2);
    expect(await messages.countActiveRooms("b")).toBe(0);
  });

  it("deletes single messages and whole rooms", async () => {
    const m = msg("a", "lobby", 1);
    await messages.append(m);
    await messages.append(msg("a", "lobby", 2));
    expect(await messages.delete(m.id)).toEqual(m);
    expect(await messages.delete(m.id)).toBeNull();
    expect(await messages.deleteRoom("a", "lobby")).toHaveLength(1);
    expect(await messages.hasMessages("a", "lobby")).toBe(false);
  });

  it("filters and pages admin queries newest first", async () => {
    // Same timestamp for all, so paging must tie-break on id.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const m = msg("a", "lobby", 100, { uid: i % 2 ? "odd" : "even" });
      ids.push(m.id);
      await messages.append(m);
    }
    await messages.append(msg("b", "lobby", 200));
    const page1 = await messages.adminQuery({ app: "a", limit: 3 });
    const last = page1.at(-1)!;
    const page2 = await messages.adminQuery({ app: "a", limit: 3, before: { createdAt: last.createdAt, id: last.id } });
    expect([...page1, ...page2].map((m) => m.id)).toEqual(ids.reverse());
    expect(await messages.adminQuery({ uid: "odd", limit: 10 })).toHaveLength(2);
    expect((await messages.adminQuery({ limit: 1 }))[0]!.app).toBe("b");
  });

  it("summarizes rooms", async () => {
    await messages.append(msg("a", "r1", 1));
    await messages.append(msg("a", "r1", 5));
    await messages.append(msg("b", "r2", 3));
    expect(await messages.listRooms()).toEqual([
      { app: "a", room: "r1", count: 2, lastAt: 5 },
      { app: "b", room: "r2", count: 1, lastAt: 3 },
    ]);
    expect(await messages.listRooms("b")).toHaveLength(1);
  });

  it("purges and trims by app scope", async () => {
    for (const app of ["a", "b", "c"]) {
      for (let i = 0; i < 4; i++) await messages.append(msg(app, "lobby", i));
    }
    expect(await messages.purgeOlderThan({ app: "a" }, 2)).toBe(2);
    expect(await messages.purgeOlderThan({ excludeApps: ["a", "b"] }, 1)).toBe(1);
    expect(await messages.trimRooms({ app: "b" }, 1)).toBe(3);
    expect(await messages.trimRooms({ excludeApps: [] }, 2)).toBe(1); // only c still has 3
    const left = await messages.adminQuery({ limit: 100 });
    expect(left.map((m) => `${m.app}${m.createdAt}`).sort()).toEqual(["a2", "a3", "b3", "c2", "c3"]);
  });
});

describe("D1BanStore", () => {
  it("finds active bans by uid or ip and respects expiry", async () => {
    await bans.add({ kind: "uid", value: "u1", reason: "spam", createdAt: 1, expiresAt: null });
    await bans.add({ kind: "ip", value: "ip1", reason: null, createdAt: 2, expiresAt: 100 });
    expect((await bans.find({ uid: "u1" }, 50))?.reason).toBe("spam");
    expect((await bans.find({ uid: "nope", ipHash: "ip1" }, 50))?.kind).toBe("ip");
    expect(await bans.find({ ipHash: "ip1" }, 100)).toBeNull();
    expect(await bans.find({}, 0)).toBeNull();
    expect((await bans.list(50)).map((b) => b.kind)).toEqual(["ip", "uid"]);
    expect(await bans.purgeExpired(100)).toBe(1);
    expect(await bans.remove("uid", "u1")).toBe(true);
    expect(await bans.remove("uid", "u1")).toBe(false);
  });

  it("replaces an existing ban", async () => {
    await bans.add({ kind: "uid", value: "u1", reason: "a", createdAt: 1, expiresAt: 10 });
    await bans.add({ kind: "uid", value: "u1", reason: "b", createdAt: 2, expiresAt: null });
    expect(await bans.list(1000)).toEqual([{ kind: "uid", value: "u1", reason: "b", createdAt: 2, expiresAt: null }]);
  });
});
