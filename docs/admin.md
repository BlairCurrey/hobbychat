# Admin and moderation

The admin page lives at `/admin` on your server. From it you can:

- browse recent messages across all apps, filtered by app, room or user
- delete a message (it disappears live for everyone in the room)
- clear a whole room
- ban someone straight from one of their messages (see below)
- see and lift bans

## Bans

**Ban…** on a message opens a form with two options. You can pick either or both, each with its own duration (1 hour up to forever):

| | Ban this browser | Ban their IP address |
| - | - | - |
| Blocks | One chat identity: the signed token their client saved (in `localStorage` for the standard client) | Every connection from their network |
| Collateral damage | None | Anyone sharing the IP: schools, offices, mobile carriers |
| Easy to dodge? | Yes: clear site data, use another browser, or a custom client that never sends its token | Harder: needs a different network or a VPN |
| Default duration | Forever | 24 hours |

Use a browser ban for most trolls. Add a short IP ban for persistent ones.

Bans apply to **every app and room on the server**, not one app. The person is disconnected from the room the message came from right away. Everywhere else, they're blocked the next time they post or join.

## Securing it with Cloudflare Access

The admin page stays **disabled** until you put it behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/). Access is free for small teams and handles the login (e.g. a one-time code sent to your email). hobbychat also checks the login token Access attaches to every request, so the admin API can't be reached any other way.

1. In the Cloudflare dashboard, open **Zero Trust**. The first time, it asks you to pick a team name; that's your **team domain**, `<team>.cloudflareaccess.com`.
2. Go to **Access → Applications → Add an application → Self-hosted**.
   - Add your Worker's hostname (e.g. `hobbychat.you.workers.dev`, or your custom domain) with the path `admin`.
   - Add a policy that allows your email address.
3. Open the application's settings and copy its **Application Audience (AUD) tag**.
4. On your Worker → Settings → Variables and Secrets, add two text variables:
   - `ACCESS_TEAM_DOMAIN`: your team domain, e.g. `myteam.cloudflareaccess.com`
   - `ACCESS_AUD`: the AUD tag

Visit `/admin/`. You should be asked to log in, and then see the dashboard.

Cloudflare's dashboard changes over time, so menu names may differ slightly. If something doesn't match, the [Access docs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/) are the source of truth.

## Notes

- **Locally**, `pnpm dev` turns on `DEV_MODE` in `.dev.vars`, which lets `localhost` into the admin page without Access. That only works on localhost, and `.dev.vars` is never deployed.
- **IP addresses are never stored.** Only a keyed hash is kept, which is enough to match a ban.
- **Deletes are permanent.** There's no undo or trash.
