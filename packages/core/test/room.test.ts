import { CLOSE_BANNED } from "@hobbychat/protocol";
import { describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

describe("hello", () => {
  it("assigns a random name and a token, and sends history", async () => {
    const t = setup();
    const a = await t.join();
    expect(a.welcome.you.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(a.welcome.token).toContain(".");
    expect(a.welcome.history).toEqual([]);

    await a.post("hi");
    const b = await t.join();
    expect(b.welcome.history.map((m) => m.body)).toEqual(["hi"]);
  });

  it("keeps the same identity when reconnecting with a token", async () => {
    const t = setup();
    const first = await t.join();
    const again = await t.join({ token: first.welcome.token });
    expect(again.welcome.you).toEqual(first.welcome.you);
    expect(again.welcome.token).toBe(first.welcome.token);
  });

  it("ignores a forged token and assigns a new identity", async () => {
    const t = setup();
    const first = await t.join();
    const [body] = first.welcome.token.split(".");
    const forged = await t.join({ token: `${body}.not-the-signature` });
    expect(forged.welcome.you.uid).not.toBe(first.welcome.you.uid);
  });

  it("rejects a second hello", async () => {
    const t = setup();
    const a = await t.join();
    await a.frame({ type: "hello" });
    expect(a.peer.last("error")?.code).toBe("invalid");
  });

  it("limits history to historyOnJoin, oldest first", async () => {
    const t = setup({ defaults: { historyOnJoin: 2, rateLimit: "100/min" } });
    const a = await t.join();
    for (const body of ["1", "2", "3"]) {
      await a.post(body);
      t.clock.advance(1);
    }
    const b = await t.join();
    expect(b.welcome.history.map((m) => m.body)).toEqual(["2", "3"]);
  });
});

describe("post", () => {
  it("broadcasts to everyone who joined, including the sender with clientId", async () => {
    const t = setup();
    const a = await t.join();
    const b = await t.join();
    const lurker = t.connect(); // never said hello
    await a.post("  hello there  ");

    const mine = a.peer.last("message")!.message;
    expect(mine).toMatchObject({ body: "hello there", room: "lobby", clientId: "c0" });
    expect(mine.name).toBe(a.welcome.you.name);
    expect(b.peer.last("message")!.message.id).toBe(mine.id);
    expect(lurker.peer.sent).toEqual([]);
    expect(t.messages.rows).toHaveLength(1);
    expect(t.messages.rows[0]).toMatchObject({ app: "app", ipHash: "iphash-1" });
  });

  it("does not leak messages across rooms or apps", async () => {
    const t = setup();
    const a = await t.join({ room: "one" });
    const b = await t.join({ room: "two" });
    const c = await t.join({ app: "other", room: "one" });
    await a.post("hi");
    expect(b.peer.last("message")).toBeUndefined();
    expect(c.peer.last("message")).toBeUndefined();
  });

  it("requires hello first", async () => {
    const t = setup();
    const a = t.connect();
    await a.frame({ type: "post", body: "hi", clientId: "x" });
    expect(a.peer.last("error")).toMatchObject({ code: "invalid", clientId: "x" });
  });

  it("rejects malformed frames and empty bodies", async () => {
    const t = setup();
    const a = await t.join();
    await a.frame("not json");
    expect(a.peer.last("error")?.code).toBe("invalid");
    expect(a.peer.last("error")).not.toHaveProperty("clientId"); // unparseable, so no clientId
    await a.post("   ");
    expect(a.peer.last("error")).toMatchObject({ code: "invalid", clientId: "c0" });
    expect(a.peer.sent.filter((m) => m.type === "error")).toHaveLength(2);
    expect(t.messages.rows).toHaveLength(0);
  });

  it("enforces maxMessageLength in characters", async () => {
    const t = setup({ defaults: { maxMessageLength: 5 } });
    const a = await t.join();
    await a.post("🦦🦦🦦🦦🦦"); // 5 characters, 10 UTF-16 units
    expect(a.peer.last("message")).toBeDefined();
    await a.post("123456");
    expect(a.peer.last("error")).toMatchObject({ code: "too_long", clientId: "c1" });
  });

  it("rate limits per connection and refills over time", async () => {
    const t = setup({ defaults: { rateLimit: "3/min" } });
    const a = await t.join();
    for (let i = 0; i < 3; i++) await a.post(`m${i}`);
    await a.post("too many");
    expect(a.peer.last("error")).toMatchObject({ code: "rate_limited", clientId: "c3" });
    expect(t.messages.rows).toHaveLength(3);

    t.clock.advance(20_000); // one token back
    await a.post("ok again");
    expect(t.messages.rows).toHaveLength(4);
  });
});

describe("room policy and limits", () => {
  it("caps active rooms, checked on a room's first message", async () => {
    const t = setup({ defaults: { maxActiveRooms: 2 } });
    await (await t.join({ room: "r1" })).post("a");
    await (await t.join({ room: "r2" })).post("b");
    const third = await t.join({ room: "r3" });
    await third.post("c");
    expect(third.peer.last("error")).toMatchObject({ code: "room_limit", clientId: "c0" });

    // Existing rooms keep working.
    const again = await t.join({ room: "r1" });
    await again.post("still fine");
    expect(again.peer.last("message")).toBeDefined();

    // Other apps have their own cap.
    const other = await t.join({ app: "other", room: "r3" });
    await other.post("ok");
    expect(other.peer.last("message")).toBeDefined();
  });
});

describe("bans", () => {
  it("bans by uid on hello", async () => {
    const t = setup();
    const a = await t.join();
    await t.bans.add({ kind: "uid", value: a.welcome.you.uid, reason: null, createdAt: 0, expiresAt: null });
    const again = await t.join({ token: a.welcome.token, ipHash: "other-ip" });
    expect(again.peer.last("banned")).toBeDefined();
    expect(again.peer.closed?.code).toBe(CLOSE_BANNED);
  });

  it("bans by ip hash on post, and expiry lifts it", async () => {
    const t = setup();
    const a = await t.join({ ipHash: "bad-ip" });
    await t.bans.add({
      kind: "ip",
      value: "bad-ip",
      reason: "spam",
      createdAt: t.clock.now(),
      expiresAt: t.clock.now() + 1000,
    });
    await a.post("hi");
    expect(a.peer.last("banned")).toBeDefined();
    expect(t.messages.rows).toHaveLength(0);

    t.clock.advance(1001);
    const b = await t.join({ ipHash: "bad-ip" });
    await b.post("hi");
    expect(b.peer.last("message")).toBeDefined();
  });

  it("kick closes matching sockets only", async () => {
    const t = setup();
    const a = await t.join();
    const b = await t.join({ ipHash: "other" });
    const closed = t.service.kick(a.hub, { uid: a.welcome.you.uid });
    expect(closed).toBe(1);
    expect(a.peer.closed).not.toBeNull();
    expect(b.peer.closed).toBeNull();
    expect(a.hub.peers()).toEqual([b.peer]);
  });
});

describe("deletes", () => {
  it("broadcasts deleted ids to joined peers", async () => {
    const t = setup();
    const a = await t.join();
    await a.post("oops");
    const id = a.peer.last("message")!.message.id;
    t.service.broadcastDeleted(a.hub, [id]);
    expect(a.peer.last("deleted")).toEqual({ type: "deleted", id });
  });
});
