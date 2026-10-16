# Configuration

hobbychat is configured in two places:

- **[`chat.config.ts`](../chat.config.ts)** in the repo root: defaults for every app, plus optional per-app overrides. Changes take effect on the next deploy.
- **Variables in the Cloudflare dashboard** (Worker → Settings → Variables and Secrets): settings you can change without touching code.

## Allowing your sites (origins)

Browsers only get to connect from pages whose origin is allowed. Out of the box **nothing** is allowed in production. Add your sites in either place:

- set the `ALLOWED_ORIGINS` variable to a comma-separated list, e.g. `https://mygame.com, https://*.mysite.dev`, or
- add them to `defaults.origins` in `chat.config.ts`.

Origins from both places are combined. Local development (`pnpm dev`) always allows `localhost` too; a deployed server doesn't, so strangers can't use your server from their own machines.

| Pattern                 | Matches                                                 |
| ----------------------- | ------------------------------------------------------- |
| `https://mygame.com`    | exactly that origin                                     |
| `https://*.mysite.dev`  | any subdomain (`a.mysite.dev`, `a.b.mysite.dev`), not `mysite.dev` itself |
| `http://localhost:*`    | any port                                                |
| `*`                     | anything (not recommended)                              |

Origin checks stop other websites from embedding your chat. They don't stop a determined script, since anyone can fake the header outside a browser. That's acceptable because chats here are public anyway. Abuse is handled by rate limits, room caps, retention and bans.

## Apps and settings

An **app** is just a name your page passes (`<hobby-chat app="my-game">`). App and room names use lowercase letters, digits, `-` and `_`, up to 64 characters. Any app name from an allowed origin works with the `defaults`. Add an entry under `apps` only when one app needs something different:

```ts
export default defineConfig({
  defaults: {
    origins: ["https://mygame.com"],
    retention: "30d",
  },
  apps: {
    "mlb-scores": { rooms: /^game-\d+$/, retention: "3d" },
    "guestbook": { rooms: ["lobby"], retention: "forever", maxMessagesPerRoom: 1000 },
  },
});
```

An app's own `origins`, if set, replace the defaults for that app. `ALLOWED_ORIGINS` only adds to the defaults.

### Accepting only your apps

By default any app name works, which keeps setup at zero. The catch: anyone can then invent new app names on your server. Each invented name gets its own allowance of rooms, so a single person could fill your database or use up your free tier, just by making up names.

If the server is only for your own apps, turn that off, and only the apps listed under `apps` work:

```ts
export default defineConfig({
  allowUnlistedApps: false,
  apps: { "my-game": {}, "guestbook": { rooms: ["lobby"] } },
});
```

Local development (`pnpm dev`) still accepts any app name.

| Setting              | Default                   | What it does |
| -------------------- | ------------------------- | ------------ |
| `origins`            | none                      | Pages allowed to connect (see above). |
| `rooms`              | `"open"`                  | Which room names are allowed: `"open"` (any), a list like `["lobby"]`, or a RegExp like `/^game-\d+$/`. |
| `maxActiveRooms`     | `50`                      | Max rooms per app that hold messages. A room only counts once someone posts in it, so lurkers can't create rooms. |
| `retention`          | `"30d"`                   | How long messages are kept: `"12h"`, `"7d"`, `"2w"`, … or `"forever"`. Cleanup runs daily. |
| `maxMessagesPerRoom` | `null`                    | Optional cap per room. The oldest messages are trimmed in the daily cleanup. |
| `maxMessageLength`   | `500`                     | Characters per message. |
| `rateLimit`          | `"10/min"`                | Messages per connection. Units: `sec`, `min`, `hour`, `day`. |
| `historyOnJoin`      | `50`                      | Recent messages sent to someone when they join. |

Bad config fails loudly at startup with a message pointing at the setting.

## Variables and secrets

| Name                 | Kind     | Purpose |
| -------------------- | -------- | ------- |
| `HMAC_SECRET`        | secret   | Required. Signs user tokens (so people keep their name) and hashes IPs. Changing it gives everyone new names. |
| `ALLOWED_ORIGINS`    | variable | Extra allowed origins (see above). |
| `ACCESS_TEAM_DOMAIN` | variable | For the admin page. See [admin.md](admin.md). |
| `ACCESS_AUD`         | variable | For the admin page. See [admin.md](admin.md). |

Set variables as **Text** in the dashboard. `wrangler.jsonc` has `keep_vars: true`, so redeploys don't wipe them. For local development, put them in `.dev.vars`; `pnpm dev` creates that file on first run.
