import { describe, expect, it } from "vitest";
import { newId, randomName, signToken, verifyToken, webCryptoHmac } from "../src/index.ts";

describe("newId", () => {
  it("sorts in creation order, even within one millisecond", () => {
    const ids = Array.from({ length: 50 }, () => newId(1_800_000_000_000));
    expect(ids).toHaveLength(new Set(ids).size);
    expect([...ids].sort()).toEqual(ids);
    expect(newId(1_800_000_000_001) > ids.at(-1)!).toBe(true);
  });
});

describe("tokens", () => {
  it("round-trips and rejects tampering or another secret", async () => {
    const hmac = webCryptoHmac("secret-one-at-least-16");
    const token = await signToken(hmac, { uid: "u1", name: "quiet-otter" }, 1);
    expect(await verifyToken(hmac, token)).toEqual({ uid: "u1", name: "quiet-otter" });
    expect(await verifyToken(webCryptoHmac("secret-two-at-least-16"), token)).toBeNull();
    const [body, sig] = token.split(".");
    const forgedBody = btoa(JSON.stringify({ uid: "admin", name: "x", iat: 1 })).replace(/=+$/, "");
    expect(await verifyToken(hmac, `${forgedBody}.${sig}`)).toBeNull();
    expect(await verifyToken(hmac, `${body}`)).toBeNull();
  });

  it("requires a reasonably long secret", () => {
    expect(() => webCryptoHmac("short")).toThrow();
  });
});

describe("randomName", () => {
  it("is adjective-animal", () => {
    expect(randomName(() => 0)).toBe("quiet-otter");
  });
});
