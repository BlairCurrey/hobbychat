# Deploying

## With the Deploy button

The **Deploy to Cloudflare** button in the README copies this repo to your GitHub account, creates the database, and deploys. It also sets up automatic deploys, so pushing to your copy redeploys it. You'll be asked for `HMAC_SECRET`; generate one with `openssl rand -hex 32`.

Afterwards, [allow your site's origin](configuration.md#allowing-your-sites-origins) and [set up the admin page](admin.md).

## From the terminal

You need Node 22+, [pnpm](https://pnpm.io), and a Cloudflare account.

```sh
git clone https://github.com/BlairCurrey/hobbychat && cd hobbychat
pnpm install
pnpm wrangler login
```

First deploy:

```sh
pnpm wrangler d1 create hobbychat     # then paste the printed database_id into wrangler.jsonc
pnpm run deploy                       # applies database migrations, then deploys
pnpm wrangler secret put HMAC_SECRET  # paste the output of: openssl rand -hex 32
```

After that, `pnpm run deploy` is all you need. It always applies any new database migrations first.

Then [allow your site's origin](configuration.md#allowing-your-sites-origins) and [set up the admin page](admin.md).

## Custom domain

Add one under Worker → Settings → Domains & Routes, then use it in your `<script src>`. If the admin page is behind Access, add the new hostname to your Access application too.

## Cost

hobbychat is built to run on Cloudflare's **free plan**:

- **Idle rooms cost nothing.** Rooms sleep between messages and keep their connections open.
- Each person who joins costs about one request. Messages people send are billed at 20 per request. Messages they receive and heartbeats are free.
- Example: 50 visitors a day sending 10 messages each comes to about 75 Durable Object requests a day, against a free allowance of 100,000.
- The first real ceiling is the database's free writes: about 100,000 messages a day.

On the free plan, hitting a limit makes things fail until the daily reset rather than charging you. If you ever outgrow it, Workers Paid is $5/month. Limits change; check [Cloudflare's pricing](https://developers.cloudflare.com/workers/platform/pricing/) for current numbers.
