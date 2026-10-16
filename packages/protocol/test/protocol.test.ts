import { describe, expect, it } from "vitest";
import { MAX_FRAME_BYTES, parseClientMessage, parseServerMessage } from "../src/index.ts";

describe("parseClientMessage", () => {
  it("accepts valid hello and post", () => {
    expect(parseClientMessage('{"type":"hello"}')).toEqual({ type: "hello" });
    expect(parseClientMessage('{"type":"hello","token":"t"}')).toEqual({ type: "hello", token: "t" });
    expect(parseClientMessage('{"type":"post","body":"hi","clientId":"c1"}')).toEqual({
      type: "post",
      body: "hi",
      clientId: "c1",
    });
  });

  it("strips unknown fields", () => {
    expect(parseClientMessage('{"type":"post","body":"hi","clientId":"c","uid":"spoof"}')).toEqual({
      type: "post",
      body: "hi",
      clientId: "c",
    });
  });

  it.each([
    "ping",
    "null",
    "[]",
    '{"type":"nope"}',
    '{"type":"post","body":1,"clientId":"c"}',
    '{"type":"post","body":"hi"}',
    `{"type":"post","body":"hi","clientId":"${"x".repeat(65)}"}`,
    '{"type":"hello","token":5}',
  ])("rejects %s", (raw) => {
    expect(parseClientMessage(raw)).toBeNull();
  });

  it("rejects oversized frames before parsing", () => {
    const raw = JSON.stringify({ type: "post", body: "x".repeat(MAX_FRAME_BYTES), clientId: "c" });
    expect(parseClientMessage(raw)).toBeNull();
  });
});

describe("parseServerMessage", () => {
  const message = { id: "1", room: "r", uid: "u", name: "n", body: "b", createdAt: 1 };

  it("parses server messages", () => {
    expect(parseServerMessage(JSON.stringify({ type: "message", message }))?.type).toBe("message");
    expect(
      parseServerMessage(JSON.stringify({ type: "welcome", you: { uid: "u", name: "n" }, token: "t", history: [message] })),
    )?.toBeTruthy();
    const limits = { maxMessageLength: 500, rateLimit: { count: 10, windowMs: 60000 } };
    const welcome = { type: "welcome", you: { uid: "u", name: "n" }, token: "t", history: [] };
    expect(parseServerMessage(JSON.stringify({ ...welcome, limits }))).toMatchObject({ limits });
    expect(parseServerMessage(JSON.stringify({ ...welcome, limits: { maxMessageLength: "500" } }))).toBeNull();
    expect(parseServerMessage('{"type":"error","code":"queue_full"}')?.type).toBe("error");
    expect(parseServerMessage('{"type":"deleted","id":"1"}')).toEqual({ type: "deleted", id: "1" });
    expect(parseServerMessage('{"type":"error","code":"rate_limited"}')?.type).toBe("error");
    expect(parseServerMessage('{"type":"error","code":"too_long","clientId":"c1"}')).toEqual({
      type: "error",
      code: "too_long",
      clientId: "c1",
    });
    expect(parseServerMessage('{"type":"error","code":"too_long","clientId":5}')).toBeNull();
  });

  it("ignores pong and junk", () => {
    expect(parseServerMessage("pong")).toBeNull();
    expect(parseServerMessage('{"type":"error","code":"weird"}')).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "message", message: { ...message, createdAt: "1" } }))).toBeNull();
  });
});
