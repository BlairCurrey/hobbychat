# Admin and moderation

The admin page lives at `/admin` on your server. From it you can:

- browse recent messages across all apps, filtered by app, room or user
- delete a message (it disappears live for everyone in the room)
- clear a whole room
- ban a user (permanent until lifted) or their IP (24 hours), straight from one of their messages
- see and lift bans

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
- **IP bans** use a keyed hash of the IP. The raw IP is never stored. Shared IPs (schools, offices, mobile carriers) mean an IP ban can hit innocent people, which is why it expires after 24 hours.
- **User bans** follow the browser's stored token. Someone can dodge one by clearing storage; combine it with an IP ban for persistent trolls.
- **Deletes are permanent.** There's no undo or trash.
