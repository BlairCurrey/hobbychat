# hobbychat

Chat rooms for your hobby apps: self-hosted, free on Cloudflare.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/BlairCurrey/hobbychat)

hobbychat is a small real-time chat server you run on your own Cloudflare account. Add a chat box to any side project with two lines of HTML. One deployment serves all of your apps, each with as many rooms as you like. Nobody signs up: people get a random name like `quiet-otter`. You get an admin page to delete messages and ban trolls.

**Good for:** games, toys, live-score pages, guestbooks, anywhere a bit of chat would be fun and logins would be overkill.
**Not for:** private conversations, user accounts, DMs or file sharing.

At hobby scale it fits in Cloudflare's free plan.

## Get started

1. **Deploy.** Click the button above. It copies this repo to your GitHub and deploys it. When asked for `HMAC_SECRET`, paste the output of `openssl rand -hex 32`.
2. **Allow your site.** In the Cloudflare dashboard, open your `hobbychat` Worker → Settings → Variables and Secrets, and add a text variable `ALLOWED_ORIGINS` set to your site, e.g. `https://mygame.com`.
3. **Add chat to your page.**

   ```html
   <script src="https://hobbychat.YOUR-SUBDOMAIN.workers.dev/client.js"></script>
   <hobby-chat app="my-game" room="lobby"></hobby-chat>
   ```

   Any app name works. There's nothing to register. Use different `room` values for separate conversations.

4. **Turn on moderation.** Put `/admin` behind Cloudflare Access (free) by following [docs/admin.md](docs/admin.md).

Prefer the terminal? See [docs/deploying.md](docs/deploying.md).

## Try it locally

```sh
pnpm install
pnpm dev
```

Then open <http://localhost:8787/demo/> to chat, and <http://localhost:8787/admin/> to moderate (no login needed locally).

## Learn more

- [Configuration](docs/configuration.md): origins, rooms, retention, rate limits
- [Using the client](docs/client.md): widget attributes, styling, and the JavaScript API for custom UIs
- [Admin and moderation](docs/admin.md)
- [Deploying and costs](docs/deploying.md)
- [How it works and contributing](docs/development.md)

## License

[MIT](LICENSE)
