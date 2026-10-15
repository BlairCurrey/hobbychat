import { DurableObject } from "cloudflare:workers";
import { PING, PONG } from "@hobbychat/protocol";
import { RoomService, type KickTarget, type Peer, type PeerState, type RoomHub } from "@hobbychat/core";
import { deps, HEADER, type Env } from "./env.ts";

/**
 * One Durable Object per `app:room`. Holds the room's WebSockets using the
 * Hibernation API, so an idle room is evicted from memory while its sockets
 * stay open. Nothing about the room lives in memory between events: per-socket
 * state is in the socket attachment and messages are in D1.
 */
export class ChatRoom extends DurableObject<Env> {
  private readonly service: RoomService;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats are answered by the runtime without waking the object or billing a message.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    this.service = new RoomService(deps(env));
  }

  /** Accepts a WebSocket the Worker has already authorized. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const app = request.headers.get(HEADER.app);
    const room = request.headers.get(HEADER.room);
    if (!app || !room) return new Response("Missing room", { status: 400 });

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(this.service.initialState(app, room, request.headers.get(HEADER.ipHash)));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const peer = toPeer(ws);
    if (typeof message !== "string") {
      peer.send({ type: "error", code: "invalid", message: "Text frames only" });
      return;
    }
    try {
      await this.service.handleFrame(this.hub(), peer, message);
    } catch (err) {
      console.error("room error", err);
      peer.send({ type: "error", code: "invalid", message: "Server error" });
    }
  }

  /**
   * Complete the closing handshake. Without this reply the browser waits ~10s and
   * then reports an unclean close (1006), even though the runtime is documented to
   * reply automatically; a second close() is harmless when it does.
   */
  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      // 1005/1006 mean "no code given" / "abnormal" and can't be sent back.
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(): Promise<void> {}

  // ---- RPC from the admin API ----

  async deleted(ids: string[]): Promise<void> {
    this.service.broadcastDeleted(this.hub(), ids);
  }

  async kick(target: KickTarget): Promise<number> {
    return this.service.kick(this.hub(), target);
  }

  private hub(): RoomHub {
    return {
      peers: () =>
        this.ctx
          .getWebSockets()
          .filter((ws) => ws.readyState === WebSocket.OPEN)
          .map(toPeer),
    };
  }
}

function toPeer(ws: WebSocket): Peer {
  let state = ws.deserializeAttachment() as PeerState;
  return {
    get state() {
      return state;
    },
    setState(next) {
      state = next;
      ws.serializeAttachment(next);
    },
    send(message) {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // Socket already closing; nothing to deliver to.
      }
    },
    close(code, reason) {
      try {
        ws.close(code, reason);
      } catch {
        // Already closed.
      }
    },
  };
}
