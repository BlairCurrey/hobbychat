import { describe, expect, it } from "vitest";
import { cloudflareAccess, normalizeTeamDomain } from "../src/access.ts";

const TEAM = "https://myteam.cloudflareaccess.com";
const AUD = "aud-tag-123";

function b64url(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function keypair(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid };
  const sign = async (payload: object, header: object = { alg: "RS256", kid }) => {
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${b64url(sig)}`;
  };
  return { jwk, sign };
}

function setup(keys: { jwk: JsonWebKey }[]) {
  let fetches = 0;
  const current = { keys };
  const auth = cloudflareAccess({
    teamDomain: "myteam",
    aud: AUD,
    now: () => 1_700_000_000_000,
    fetch: (async (url: string) => {
      fetches++;
      expect(url).toBe(`${TEAM}/cdn-cgi/access/certs`);
      return Response.json({ keys: current.keys.map((k) => k.jwk) });
    }) as typeof fetch,
  });
  const verify = (token?: string) =>
    auth.verify(new Request("https://chat.test/admin/", { headers: token ? { "cf-access-jwt-assertion": token } : {} }));
  return { verify, current, fetches: () => fetches };
}

const valid = { iss: TEAM, aud: [AUD], exp: 1_700_000_600, iat: 1_700_000_000, email: "me@example.com" };

describe("cloudflareAccess", () => {
  it("accepts a valid token and caches the certs", async () => {
    const k = await keypair("k1");
    const t = setup([k]);
    expect(await t.verify(await k.sign(valid))).toEqual({ ok: true, email: "me@example.com" });
    await t.verify(await k.sign(valid));
    expect(t.fetches()).toBe(1);
  });

  it("rejects missing, forged, expired, and mis-addressed tokens", async () => {
    const k = await keypair("k1");
    const other = await keypair("k1"); // same kid, different key
    const t = setup([k]);
    expect((await t.verify()).ok).toBe(false);
    expect(await t.verify("garbage")).toMatchObject({ ok: false, reason: "Malformed token" });
    expect(await t.verify(await other.sign(valid))).toMatchObject({ ok: false, reason: "Invalid signature" });
    expect(await t.verify(await k.sign({ ...valid, aud: ["someone-else"] }))).toMatchObject({ reason: "Wrong audience" });
    expect(await t.verify(await k.sign({ ...valid, iss: "https://evil.cloudflareaccess.com" }))).toMatchObject({
      reason: "Wrong issuer",
    });
    expect(await t.verify(await k.sign({ ...valid, exp: 1_699_999_000 }))).toMatchObject({ reason: "Token expired" });
    expect(await t.verify(await k.sign(valid, { alg: "none", kid: "k1" }))).toMatchObject({ reason: "Unsupported token" });
  });

  it("refetches certs when it sees a new key id (rotation)", async () => {
    const k1 = await keypair("k1");
    const k2 = await keypair("k2");
    const t = setup([k1]);
    await t.verify(await k1.sign(valid));
    t.current.keys = [k1, k2];
    expect((await t.verify(await k2.sign(valid))).ok).toBe(true);
    expect(t.fetches()).toBe(2);
  });

  it("normalizes team domain forms", () => {
    expect(normalizeTeamDomain("myteam")).toBe(TEAM);
    expect(normalizeTeamDomain("myteam.cloudflareaccess.com")).toBe(TEAM);
    expect(normalizeTeamDomain("https://myteam.cloudflareaccess.com/")).toBe(TEAM);
  });
});
