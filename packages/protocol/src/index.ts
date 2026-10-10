/**
 * hobbychat wire protocol: JSON messages over a WebSocket.
 *
 * Bodies are plain text. Clients must render them as text, never as HTML.
 */

export interface Message {
  id: string;
  room: string;
  uid: string;
  name: string;
  body: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Echoed back to the sender so optimistic UI can dedupe. */
  clientId?: string;
}

export interface Identity {
  uid: string;
  name: string;
}

// ---- client → server ----

export interface HelloMessage {
  type: "hello";
  token?: string;
}

export interface PostMessage {
  type: "post";
  body: string;
  clientId: string;
}

export type ClientMessage = HelloMessage | PostMessage;

// ---- server → client ----

export interface WelcomeMessage {
  type: "welcome";
  you: Identity;
  token: string;
  history: Message[];
}

export interface NewMessage {
  type: "message";
  message: Message;
}

export interface DeletedMessage {
  type: "deleted";
  id: string;
}

export type ErrorCode = "rate_limited" | "too_long" | "room_limit" | "invalid";

export interface ErrorMessage {
  type: "error";
  code: ErrorCode;
  message?: string;
}

export interface BannedMessage {
  type: "banned";
}

export type ServerMessage =
  | WelcomeMessage
  | NewMessage
  | DeletedMessage
  | ErrorMessage
  | BannedMessage;

/** Plain-text heartbeat. The server auto-responds with {@link PONG} without running app logic. */
export const PING = "ping";
export const PONG = "pong";

/** Frames larger than this are rejected before parsing. */
export const MAX_FRAME_BYTES = 16 * 1024;
export const MAX_CLIENT_ID_LENGTH = 64;
export const MAX_TOKEN_LENGTH = 1024;

/** Close code sent when a banned user's socket is closed. */
export const CLOSE_BANNED = 4003;

// ---- validation ----

type Json = Record<string, unknown>;

function parseObject(raw: string): Json | null {
  if (raw.length > MAX_FRAME_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Json;
}

function isString(v: unknown, max = Infinity): v is string {
  return typeof v === "string" && v.length <= max;
}

/** Parse an untrusted frame from a client. Returns null if it is not a valid {@link ClientMessage}. */
export function parseClientMessage(raw: string): ClientMessage | null {
  const obj = parseObject(raw);
  if (!obj) return null;
  switch (obj.type) {
    case "hello":
      if (obj.token !== undefined && !isString(obj.token, MAX_TOKEN_LENGTH)) return null;
      return obj.token === undefined ? { type: "hello" } : { type: "hello", token: obj.token };
    case "post":
      if (!isString(obj.body)) return null;
      if (!isString(obj.clientId, MAX_CLIENT_ID_LENGTH)) return null;
      return { type: "post", body: obj.body, clientId: obj.clientId };
    default:
      return null;
  }
}

function isMessage(v: unknown): v is Message {
  if (typeof v !== "object" || v === null) return false;
  const m = v as Json;
  return (
    isString(m.id) &&
    isString(m.room) &&
    isString(m.uid) &&
    isString(m.name) &&
    isString(m.body) &&
    typeof m.createdAt === "number" &&
    (m.clientId === undefined || isString(m.clientId))
  );
}

const ERROR_CODES: readonly string[] = ["rate_limited", "too_long", "room_limit", "invalid"];

/** Parse a frame from the server. Returns null for anything unexpected (e.g. "pong"). */
export function parseServerMessage(raw: string): ServerMessage | null {
  const obj = parseObject(raw);
  if (!obj) return null;
  switch (obj.type) {
    case "welcome": {
      const you = obj.you as Json | undefined;
      if (!you || !isString(you.uid) || !isString(you.name)) return null;
      if (!isString(obj.token) || !Array.isArray(obj.history)) return null;
      if (!obj.history.every(isMessage)) return null;
      return obj as unknown as WelcomeMessage;
    }
    case "message":
      return isMessage(obj.message) ? (obj as unknown as NewMessage) : null;
    case "deleted":
      return isString(obj.id) ? { type: "deleted", id: obj.id } : null;
    case "error":
      if (!isString(obj.code) || !ERROR_CODES.includes(obj.code)) return null;
      return obj as unknown as ErrorMessage;
    case "banned":
      return { type: "banned" };
    default:
      return null;
  }
}
