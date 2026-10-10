import type { Identity } from "@hobbychat/protocol";

const ADJECTIVES = [
  "quiet", "brave", "sunny", "lucky", "witty", "gentle", "swift", "clever", "fuzzy", "jolly",
  "mellow", "nimble", "plucky", "rusty", "silly", "sleepy", "snappy", "spicy", "tidy", "zesty",
  "bouncy", "cosmic", "dapper", "eager", "fancy", "giddy", "humble", "icy", "jazzy", "keen",
  "lively", "mighty", "noble", "odd", "peppy", "quirky", "rowdy", "shiny", "tiny", "upbeat",
  "vivid", "wild", "young", "zany", "amber", "bold", "calm", "dusty", "early", "fair",
];

const ANIMALS = [
  "otter", "badger", "falcon", "panda", "lynx", "heron", "koala", "moose", "newt", "owl",
  "puffin", "quokka", "raven", "seal", "tapir", "urchin", "vole", "walrus", "yak", "zebra",
  "alpaca", "beaver", "camel", "dingo", "egret", "ferret", "gecko", "hippo", "ibis", "jackal",
  "kiwi", "lemur", "marmot", "narwhal", "ocelot", "pelican", "quail", "rabbit", "sloth", "toucan",
  "wombat", "axolotl", "bison", "crane", "dolphin", "finch", "gopher", "hedgehog", "iguana", "jaguar",
];

function pick<T>(list: readonly T[], random: () => number): T {
  return list[Math.floor(random() * list.length)]!;
}

/** A random display name like `quiet-otter`. */
export function randomName(random: () => number = Math.random): string {
  return `${pick(ADJECTIVES, random)}-${pick(ANIMALS, random)}`;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID-style ID: 10 chars of time + 16 random chars, so IDs sort by creation time. */
export function newId(now: number = Date.now()): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (const b of bytes) rand += CROCKFORD[b % 32];
  return time + rand;
}

// ---- HMAC ----

/** Keyed hashing, injected so platforms can supply their own secret handling. */
export interface Hmac {
  /** Returns base64url(HMAC-SHA256(secret, data)). */
  sign(data: string): Promise<string>;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(value: string): string {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

/** {@link Hmac} backed by WebCrypto (available in Workers, Node 20+, Deno, Bun). */
export function webCryptoHmac(secret: string): Hmac {
  if (!secret || secret.length < 16) {
    throw new Error("HMAC secret must be at least 16 characters");
  }
  const enc = new TextEncoder();
  const key = crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return {
    async sign(data) {
      const sig = await crypto.subtle.sign("HMAC", await key, enc.encode(data));
      return base64url(new Uint8Array(sig));
    },
  };
}

/** IPs are only ever stored as a keyed hash (a plain hash of IPv4 is brute-forceable). */
export function hashIp(hmac: Hmac, ip: string): Promise<string> {
  return hmac.sign(`ip:${ip}`);
}

// ---- identity tokens ----

interface TokenPayload extends Identity {
  iat: number;
}

/** Sign an identity token: `<base64url(json)>.<signature>`. */
export async function signToken(hmac: Hmac, identity: Identity, now: number): Promise<string> {
  const payload: TokenPayload = { uid: identity.uid, name: identity.name, iat: now };
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${body}.${await hmac.sign(`token:${body}`)}`;
}

/** Verify a token and return its identity, or null if it is malformed or forged. */
export async function verifyToken(hmac: Hmac, token: string): Promise<Identity | null> {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const expected = await hmac.sign(`token:${body}`);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(
      Uint8Array.from(fromBase64url(body), (c) => c.charCodeAt(0)),
    )) as Partial<TokenPayload>;
    if (typeof payload.uid !== "string" || typeof payload.name !== "string") return null;
    return { uid: payload.uid, name: payload.name };
  } catch {
    return null;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
