# How it works and contributing

## Architecture

```
Browser ── GET /ws?app=foo&room=lobby (WebSocket upgrade)
   │
Worker (stateless router)
   │  checks the app config, Origin allowlist, room policy and IP bans
   │  forwards the upgrade to the Durable Object named "foo:lobby"
   │
Room Durable Object (one per app:room)
   │  accepts the socket with the Hibernation API, broadcasts messages
   │
D1 (one SQLite database): messages and bans
```

- **One Durable Object per room.** Rooms scale independently, one noisy app can't slow down another, and idle rooms hibernate on their own.
- **Hibernation.** Rooms keep nothing in memory between events. Per-connection state (who you are, your rate-limit budget) lives in the socket's attachment, and messages live in D1. That lets Cloudflare evict an idle room while its sockets stay open. Heartbeat pings are answered by the runtime without waking the room.
- **D1, not per-room storage.** The admin page needs queries across all rooms ("latest 100 messages anywhere"), which a single database makes easy.
- **Identity.** On first join the server picks a random name and returns a signed token. The client keeps it in `localStorage` and sends it in its first message (not the URL, so it doesn't end up in logs).
- **Cleanup.** A daily cron deletes messages past each app's retention and trims rooms over `maxMessagesPerRoom`. A room "exists" only while it has messages, so there's nothing else to clean up.
- **Admin.** The admin API runs in the same Worker. Deletes and bans reach live rooms over Durable Object RPC, so a deleted message disappears for everyone right away.

## Repo layout

| Path                   | What                                                                 | Uses Cloudflare APIs? |
| ---------------------- | -------------------------------------------------------------------- | -------------- |
| `packages/protocol`    | Wire message types and validation                                    | no |
| `packages/core`        | All the chat logic, written against store/hub interfaces; plus in-memory adapters (`@hobbychat/core/memory`) | no |
| `packages/client`      | Headless client and `<hobby-chat>`; published to npm as `hobbychat` | no |
| `packages/admin`       | Static admin UI                                                      | no |
| `packages/cloudflare`  | Worker, Room Durable Object, D1 stores, Access auth, migrations      | yes |
| `chat.config.ts`, `wrangler.jsonc` | The deployable app's config. They sit at the repo root because the Deploy button needs a self-contained project. | |

`core` never touches a platform API. It's a set of stateless handlers over the `MessageStore`, `BanStore`, `AppRegistry` and `RoomHub` interfaces, plus injected HMAC, clock and ID functions. Supporting another host (e.g. Node + SQLite) means implementing those interfaces; see the in-memory versions for a template. It assumes **one writer per room**: Durable Objects guarantee that, and so does a single Node process.

## Working on it

```sh
pnpm install
pnpm dev          # local server at http://localhost:8787 (demo at /demo/, admin at /admin/)
pnpm test         # all packages; the Cloudflare tests run in the real Workers runtime
pnpm typecheck
```

`pnpm dev` creates `.dev.vars` with a random secret and `DEV_MODE=true` on first run, and applies database migrations locally. To run the daily cleanup by hand: `curl "http://localhost:8787/cdn-cgi/local/scheduled"`.

Schema changes go in a new file under `packages/cloudflare/migrations/`. `pnpm run deploy` applies them before deploying.

## Publishing the client to npm

```sh
cd packages/client
# bump "version" in package.json
pnpm publish   # builds dist/ first (prepack); needs `npm login`
```

The package bundles the protocol types, so `packages/protocol` stays private. Keep the client and server versions in step: bump the minor version (before 1.0) whenever the wire protocol changes.
