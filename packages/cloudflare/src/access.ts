/**
 * Admin authentication via Cloudflare Access.
 *
 * Access sits in front of /admin and handles login. The Worker still verifies
 * the signed `Cf-Access-Jwt-Assertion` header on every request (defense in
 * depth: e.g. a workers.dev URL that isn't behind Access).
 */

export type AuthResult = { ok: true; email: string | null } | { ok: false; status: 401 | 403 | 503; reason: string };

export interface AdminAuth {
  verify(request: Request): Promise<AuthResult>;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtPayload {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  email?: string;
}

const CERTS_TTL_MS = 10 * 60_000;
const CLOCK_SKEW_S = 60;

function decodeSegment<T>(segment: string): T {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))) as T;
}

function decodeSignature(segment: string): Uint8Array<ArrayBuffer> {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

/** `myteam`, `myteam.cloudflareaccess.com`, or `https://myteam.cloudflareaccess.com` → issuer URL. */
export function normalizeTeamDomain(value: string): string {
  let host = value.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!host.includes(".")) host += ".cloudflareaccess.com";
  return `https://${host}`;
}

export interface AccessOptions {
  teamDomain: string;
  aud: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export function cloudflareAccess(options: AccessOptions): AdminAuth {
  const issuer = normalizeTeamDomain(options.teamDomain);
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let certs: { keys: Map<string, Promise<CryptoKey>>; fetchedAt: number } | null = null;

  async function loadCerts(force: boolean) {
    if (!force && certs && now() - certs.fetchedAt < CERTS_TTL_MS) return certs.keys;
    const res = await doFetch(`${issuer}/cdn-cgi/access/certs`);
    if (!res.ok) throw new Error(`Failed to fetch Access certs: ${res.status}`);
    const { keys } = (await res.json()) as { keys: Jwk[] };
    const map = new Map<string, Promise<CryptoKey>>();
    for (const jwk of keys) {
      map.set(
        jwk.kid,
        crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
      );
    }
    certs = { keys: map, fetchedAt: now() };
    return map;
  }

  async function keyFor(kid: string): Promise<CryptoKey | null> {
    let key = (await loadCerts(false)).get(kid);
    if (!key) key = (await loadCerts(true)).get(kid); // keys rotate
    return key ? await key : null;
  }

  return {
    async verify(request) {
      const token = request.headers.get("cf-access-jwt-assertion");
      if (!token) return { ok: false, status: 401, reason: "Missing Cloudflare Access token" };
      const [h, p, s, extra] = token.split(".");
      if (!h || !p || !s || extra !== undefined) return { ok: false, status: 401, reason: "Malformed token" };

      let header: JwtHeader;
      let payload: JwtPayload;
      try {
        header = decodeSegment<JwtHeader>(h);
        payload = decodeSegment<JwtPayload>(p);
      } catch {
        return { ok: false, status: 401, reason: "Malformed token" };
      }
      if (header.alg !== "RS256" || !header.kid) return { ok: false, status: 401, reason: "Unsupported token" };

      const key = await keyFor(header.kid);
      if (!key) return { ok: false, status: 401, reason: "Unknown signing key" };
      const valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        decodeSignature(s),
        new TextEncoder().encode(`${h}.${p}`),
      );
      if (!valid) return { ok: false, status: 401, reason: "Invalid signature" };

      const seconds = now() / 1000;
      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (payload.iss !== issuer) return { ok: false, status: 403, reason: "Wrong issuer" };
      if (!audiences.includes(options.aud)) return { ok: false, status: 403, reason: "Wrong audience" };
      if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < seconds) {
        return { ok: false, status: 401, reason: "Token expired" };
      }
      if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > seconds) {
        return { ok: false, status: 401, reason: "Token not yet valid" };
      }
      return { ok: true, email: payload.email ?? null };
    },
  };
}

/** Local development only: lets requests to localhost through without Access. */
export const localDevAuth: AdminAuth = {
  async verify(request) {
    const host = new URL(request.url).hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return { ok: true, email: null };
    return { ok: false, status: 403, reason: "DEV_MODE admin bypass only works on localhost" };
  },
};

/** Always refuses: used when Access isn't configured, so the admin API fails closed. */
export const notConfiguredAuth: AdminAuth = {
  async verify() {
    return {
      ok: false,
      status: 503,
      reason: "Admin is disabled until Cloudflare Access is configured (ACCESS_TEAM_DOMAIN, ACCESS_AUD). See docs/admin.md.",
    };
  },
};
