import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/client.ts";

class FakeSocket extends EventTarget {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  constructor(public url: string) {
    super();
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  receive(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: typeof data === "string" ? data : JSON.stringify(data) }));
  }
}

function memoryStorage() {
  const map = new Map<string, string>();
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), map };
}

const welcome = { type: "welcome", you: { uid: "u1", name: "quiet-otter" }, token: "tok", history: [] };

describe("connect", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const start = (storage = memoryStorage()) => {
    const client = connect({
      url: "https://chat.example.com",
      app: "my-app",
      room: "lobby",
      storage,
      WebSocket: FakeSocket as unknown as typeof WebSocket,
    });
    return { client, storage, socket: () => FakeSocket.instances.at(-1)! };
  };

  it("builds the socket URL and says hello with the stored token", () => {
    const storage = memoryStorage();
    storage.setItem("hobbychat:token:chat.example.com", "saved");
    const { socket } = start(storage);
    expect(socket().url).toBe("wss://chat.example.com/ws?app=my-app&room=lobby");
    socket().open();
    expect(JSON.parse(socket().sent[0]!)).toEqual({ type: "hello", token: "saved" });
  });

  it("stores the token on welcome, emits events, and queues sends until joined", () => {
    const { client, storage, socket } = start();
    const statuses: string[] = [];
    const messages: unknown[] = [];
    client.on("status", (s) => statuses.push(s));
    client.on("message", (m) => messages.push(m));

    const clientId = client.send("early");
    socket().open();
    expect(socket().sent).toHaveLength(1); // just hello
    socket().receive(welcome);
    expect(storage.map.get("hobbychat:token:chat.example.com")).toBe("tok");
    expect(client.me?.name).toBe("quiet-otter");
    expect(JSON.parse(socket().sent[1]!)).toMatchObject({ type: "post", body: "early", clientId });
    expect(statuses).toEqual(["open"]);

    socket().receive({ type: "message", message: { id: "1", room: "lobby", uid: "u1", name: "n", body: "hi", createdAt: 1 } });
    socket().receive("pong");
    expect(messages).toHaveLength(1);
  });

  it("reconnects with backoff, but not after being banned or closed", () => {
    const { client, socket } = start();
    socket().open();
    socket().receive(welcome);
    socket().close();
    expect(client.status).toBe("closed");
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);

    socket().open();
    socket().receive({ type: "banned" });
    socket().close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(client.status).toBe("banned");
  });

  it("sends heartbeats and drops a connection that stops answering", () => {
    const { socket } = start();
    socket().open();
    vi.advanceTimersByTime(30_000);
    expect(socket().sent.at(-1)).toBe("ping");
    vi.advanceTimersByTime(30_000); // no pong arrived
    expect(socket().readyState).toBe(3);
  });

  it("close() stops for good", () => {
    const { client, socket } = start();
    socket().open();
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
