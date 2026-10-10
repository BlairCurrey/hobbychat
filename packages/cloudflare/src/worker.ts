import { authorizeConnect, createAdminApi, runMaintenance, type RoomNotifier } from "@hobbychat/core";
import { cloudflareAccess, localDevAuth, notConfiguredAuth, type AdminAuth } from "./access.ts";
import { deps, HEADER, isDev, roomName, type Env } from "./env.ts";

export { ChatRoom } from "./room.ts";

const ADMIN_API = "/admin/api";

/**
 * Stateless router:
 * - `/ws?app=&room=`  authorize, then hand the WebSocket to the room's Durable Object
 * - `/admin/*`        admin UI and JSON API (Cloudflare Access protected)
 * - `/demo/`          test page, dev only
 * - everything else   static assets (e.g. `/client.js`)
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/ws") return await connect(request, env, url);
      if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return await admin(request, env, url);
      if (url.pathname === "/demo" || url.pathname.startsWith("/demo/")) {
        return isDev(env) ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      console.error(err);
      return new Response(err instanceof Error ? err.message : "Internal error", { status: 500 });
    }
  },

  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      runMaintenance(deps(env)).then((report) => console.log("maintenance", JSON.stringify(report))),
    );
  },
} satisfies ExportedHandler<Env>;

async function connect(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const result = await authorizeConnect(deps(env), {
    app: url.searchParams.get("app"),
    room: url.searchParams.get("room"),
    origin: request.headers.get("origin"),
    ip: request.headers.get("cf-connecting-ip"),
  });
  if (!result.ok) return new Response(result.reason, { status: result.status });

  // Overwrite (never trust) these headers: only the Worker may set them.
  const headers = new Headers(request.headers);
  headers.set(HEADER.app, result.app);
  headers.set(HEADER.room, result.room);
  if (result.ipHash) headers.set(HEADER.ipHash, result.ipHash);
  else headers.delete(HEADER.ipHash);

  const stub = env.ROOMS.getByName(roomName(result.app, result.room));
  return stub.fetch(new Request(request, { headers }));
}

let accessAuth: { key: string; auth: AdminAuth } | null = null;

function adminAuth(env: Env): AdminAuth {
  if (isDev(env)) return localDevAuth;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return notConfiguredAuth;
  const key = `${env.ACCESS_TEAM_DOMAIN}|${env.ACCESS_AUD}`;
  if (accessAuth?.key !== key) {
    // Kept per isolate so the Access signing keys are cached between requests.
    accessAuth = { key, auth: cloudflareAccess({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD }) };
  }
  return accessAuth.auth;
}

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

function withHeaders(response: Response, extra: Record<string, string>): Response {
  const res = new Response(response.body, response);
  for (const [k, v] of Object.entries(extra)) res.headers.set(k, v);
  return res;
}

async function admin(request: Request, env: Env, url: URL): Promise<Response> {
  const isApi = url.pathname === ADMIN_API || url.pathname.startsWith(`${ADMIN_API}/`);
  const auth = await adminAuth(env).verify(request);
  if (!auth.ok) {
    return isApi
      ? Response.json({ error: auth.reason }, { status: auth.status })
      : new Response(auth.reason, { status: auth.status, headers: { "content-type": "text/plain" } });
  }

  if (!isApi) return withHeaders(await env.ASSETS.fetch(request), SECURITY_HEADERS);

  // Browsers always send Origin on cross-site writes; refuse any that aren't us.
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && origin && origin !== url.origin) {
    return Response.json({ error: "Cross-origin request refused" }, { status: 403 });
  }

  const d = deps(env);
  const notifier: RoomNotifier = {
    deleted: (app, room, ids) => env.ROOMS.getByName(roomName(app, room)).deleted(ids),
    kick: async (app, room, target) => {
      await env.ROOMS.getByName(roomName(app, room)).kick(target);
    },
  };
  const api = createAdminApi({ messages: d.messages, bans: d.bans, notifier });
  return api(request, url.pathname.slice(ADMIN_API.length));
}
