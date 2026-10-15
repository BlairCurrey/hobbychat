import { evictDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const worker = (exports as unknown as { default: { fetch: (req: Request) => Promise<Response> } }).default;

interface Conn {
  ws: WebSocket;
  next: (type: string) => Promise<any>;
  send: (data: unknown) => void;
}

async function open(room: string, opts: { origin?: string; app?: string } = {}): Promise<Response> {
  return worker.fetch(
    new Request(`http://localhost/ws?app=${opts.app ?? "demo"}&room=${room}`, {
      headers: { upgrade: "websocket", origin: opts.origin ?? "http://localhost:5173", "cf-connecting-ip": "1.2.3.4" },
    }),
  );
}

async function join(room: string, token?: string): Promise<Conn & { welcome: any }> {
  const res = await open(room);
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const inbox: any[] = [];
  ws.addEventListener("message", (e) => {
    inbox.push(e.data === "pong" ? { type: "pong" } : JSON.parse(e.data as string));
  });
  const next = async (type: string) => {
    for (let i = 0; i < 200; i++) {
      const idx = inbox.findIndex((m) => m.type === type);
      if (idx >= 0) return inbox.splice(idx, 1)[0];
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`no ${type} in ${JSON.stringify(inbox)}`);
  };
  const send = (data: unknown) => ws.send(typeof data === "string" ? data : JSON.stringify(data));
  send({ type: "hello", token });
  return { ws, next, send, welcome: await next("welcome") };
}

describe("worker", () => {
  it("rejects bad origins, rooms and plain requests before reaching a room", async () => {
    expect((await open("lobby", { origin: "https://evil.example" })).status).toBe(403);
    expect((await open("Not A Room")).status).toBe(403);
    expect((await open("lobby", { app: "Bad App" })).status).toBe(400);
    expect((await worker.fetch(new Request("http://localhost/ws?app=demo&room=x"))).status).toBe(426);
  });

  it("chats, survives hibernation, and serves the admin API", async () => {
    const room = "hibernate-test";
    const a = await join(room);
    const b = await join(room);

    a.send({ type: "post", body: "before eviction", clientId: "c1" });
    expect((await b.next("message")).message.body).toBe("before eviction");
    await a.next("message");

    // Evict the room: in-memory state is gone, sockets hibernate and resume.
    await evictDurableObject(env.ROOMS.getByName(`demo:${room}`));

    a.send({ type: "post", body: "after eviction", clientId: "c2" });
    const echoed = (await a.next("message")).message;
    expect(echoed).toMatchObject({ body: "after eviction", uid: a.welcome.you.uid, name: a.welcome.you.name });
    expect((await b.next("message")).message.id).toBe(echoed.id);

    a.send("ping");
    expect(await a.next("pong")).toEqual({ type: "pong" });

    // Admin delete reaches the live room over RPC.
    const res = await worker.fetch(new Request(`http://localhost/admin/api/messages/${echoed.id}`, { method: "DELETE" }));
    expect(res.status).toBe(200);
    expect(await b.next("deleted")).toEqual({ type: "deleted", id: echoed.id });

    const list = (await (await worker.fetch(new Request(`http://localhost/admin/api/messages?room=${room}`))).json()) as any;
    expect(list.messages.map((m: any) => m.body)).toEqual(["before eviction"]);

    a.ws.close();
    b.ws.close();
  });

  it("completes the closing handshake promptly and cleanly", async () => {
    const conn = await join("closing");
    const closed = new Promise<CloseEvent>((r) => conn.ws.addEventListener("close", r));
    const start = Date.now();
    conn.ws.close(1000, "bye");
    const event = await closed;
    expect(event.code).toBe(1000);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("keeps a user's identity across reconnects", async () => {
    const first = await join("identity");
    first.ws.close();
    const again = await join("identity", first.welcome.token);
    expect(again.welcome.you).toEqual(first.welcome.you);
    again.ws.close();
  });

  it("refuses the admin API from other hosts even in dev mode", async () => {
    const res = await worker.fetch(new Request("https://chat.example.com/admin/api/bans"));
    expect(res.status).toBe(403);
  });
});
