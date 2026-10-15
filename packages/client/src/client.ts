import {
  parseServerMessage,
  PING,
  type ErrorMessage,
  type Identity,
  type Message,
  type ServerMessage,
} from "@hobbychat/protocol";

export type ChatStatus = "connecting" | "open" | "closed" | "banned";

export interface ChatEvents {
  /** Joined (or rejoined after a reconnect). `history` replaces anything shown before. */
  welcome: { you: Identity; history: Message[] };
  message: Message;
  deleted: string;
  error: ErrorMessage;
  status: ChatStatus;
}

export interface ConnectOptions {
  /** Base URL of your hobbychat server, e.g. `https://chat.example.workers.dev`. */
  url: string;
  app: string;
  room: string;
  /** Where the identity token is kept so the user keeps their name. Defaults to `localStorage`; `null` disables. */
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  /** Custom WebSocket implementation (for tests or non-browser runtimes). */
  WebSocket?: typeof WebSocket;
}

export interface ChatClient {
  readonly status: ChatStatus;
  /** Your identity once joined. */
  readonly me: Identity | null;
  on<K extends keyof ChatEvents>(event: K, listener: (data: ChatEvents[K]) => void): () => void;
  /**
   * Send a message. Returns its clientId, which comes back on the echoed message, or on an
   * `error` if it's rejected. Queued while reconnecting (up to 20; beyond that it errors).
   */
  send(body: string): string;
  /** Disconnect for good. */
  close(): void;
}

const HEARTBEAT_MS = 30_000;
const MAX_BACKOFF_MS = 30_000;
const MAX_QUEUE = 20;

function defaultStorage(): ConnectOptions["storage"] {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // e.g. blocked third-party storage
  }
}

function socketUrl(base: string, app: string, room: string): string {
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("app", app);
  url.searchParams.set("room", room);
  return url.toString();
}

let clientIdCounter = 0;
function newClientId(): string {
  return `${Date.now().toString(36)}-${(clientIdCounter++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Connect to a room. Reconnects automatically with backoff and keeps the
 * user's name across visits via a signed token in storage.
 */
export function connect(options: ConnectOptions): ChatClient {
  const WS = options.WebSocket ?? globalThis.WebSocket;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const tokenKey = `hobbychat:token:${new URL(options.url).host}`;
  const listeners = new Map<keyof ChatEvents, Set<(data: never) => void>>();

  let ws: WebSocket | null = null;
  let status: ChatStatus = "connecting";
  let me: Identity | null = null;
  let stopped = false;
  let attempt = 0;
  let joined = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let awaitingPong = false;
  const queue: string[] = [];

  function emit<K extends keyof ChatEvents>(event: K, data: ChatEvents[K]): void {
    for (const fn of listeners.get(event) ?? []) (fn as (d: ChatEvents[K]) => void)(data);
  }

  function setStatus(next: ChatStatus): void {
    if (status === next) return;
    status = next;
    emit("status", next);
  }

  function readToken(): string | undefined {
    try {
      return storage?.getItem(tokenKey) ?? undefined;
    } catch {
      return undefined;
    }
  }

  function writeToken(token: string): void {
    try {
      storage?.setItem(tokenKey, token);
    } catch {
      // Storage full or blocked; the user just gets a new name next time.
    }
  }

  function stopHeartbeat(): void {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }

  function open(): void {
    joined = false;
    setStatus("connecting");
    const socket = new WS(socketUrl(options.url, options.app, options.room));
    ws = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", token: readToken() }));
      awaitingPong = false;
      heartbeatTimer = setInterval(() => {
        // No pong since the last ping: the connection is dead even if the browser hasn't
        // noticed. Reconnect now; a dead socket's close event can take a long time to fire.
        if (awaitingPong) {
          closed(socket);
          return socket.close();
        }
        awaitingPong = true;
        socket.send(PING);
      }, HEARTBEAT_MS);
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      if (event.data === "pong") {
        awaitingPong = false;
        return;
      }
      const msg = parseServerMessage(event.data);
      if (msg) handle(socket, msg);
    });

    socket.addEventListener("close", () => closed(socket));
  }

  /** Forget a socket and schedule a reconnect. Safe to call more than once. */
  function closed(socket: WebSocket): void {
    if (ws !== socket) return;
    ws = null;
    stopHeartbeat();
    if (stopped || status === "banned") return;
    setStatus("closed");
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt) * (0.5 + Math.random() / 2);
    attempt++;
    reconnectTimer = setTimeout(open, delay);
  }

  function handle(socket: WebSocket, msg: ServerMessage): void {
    switch (msg.type) {
      case "welcome":
        attempt = 0;
        joined = true;
        me = msg.you;
        writeToken(msg.token);
        setStatus("open");
        emit("welcome", { you: msg.you, history: msg.history });
        while (queue.length) socket.send(queue.shift()!);
        break;
      case "message":
        emit("message", msg.message);
        break;
      case "deleted":
        emit("deleted", msg.id);
        break;
      case "error":
        emit("error", msg);
        break;
      case "banned":
        setStatus("banned");
        break;
    }
  }

  open();

  return {
    get status() {
      return status;
    },
    get me() {
      return me;
    },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener as (data: never) => void);
      return () => listeners.get(event)!.delete(listener as (data: never) => void);
    },
    send(body) {
      const clientId = newClientId();
      const frame = JSON.stringify({ type: "post", body, clientId });
      if (ws && joined && ws.readyState === WS.OPEN) ws.send(frame);
      else if (queue.length < MAX_QUEUE) queue.push(frame);
      else {
        // Report it like any rejected post, after send() has returned the clientId.
        queueMicrotask(() =>
          emit("error", { type: "error", code: "rate_limited", message: "Too many messages waiting to send", clientId }),
        );
      }
      return clientId;
    },
    close() {
      stopped = true;
      clearTimeout(reconnectTimer);
      stopHeartbeat();
      ws?.close();
      ws = null;
      setStatus("closed");
    },
  };
}
