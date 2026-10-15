# hobbychat

Browser client for [hobbychat](https://github.com/BlairCurrey/hobbychat): real-time chat rooms for your hobby apps, self-hosted on Cloudflare. You need a hobbychat server running; the main repo has a one-click deploy.

```sh
npm install hobbychat
```

## Your own UI

```ts
import { connect } from "hobbychat";

const chat = connect({ url: "https://hobbychat.you.workers.dev", app: "my-game", room: "lobby" });

chat.on("welcome", ({ you, history }) => {}); // on every (re)connect; replace what you show with `history`
chat.on("message", (m) => {});                // { id, room, uid, name, body, createdAt, clientId? }
chat.on("deleted", (id) => {});               // a moderator removed a message
chat.on("error", (e) => {});                  // e.code, and e.clientId if a post was rejected
chat.on("status", (s) => {});                 // connecting | open | closed | banned

chat.send("hello!"); // returns a clientId, echoed back on the message (or the error)
```

It reconnects automatically and remembers the user's random name between visits. Render message bodies as text, never as HTML.

## Ready-made widget

```ts
import "hobbychat/widget";
```

```html
<hobby-chat server="https://hobbychat.you.workers.dev" app="my-game" room="lobby"></hobby-chat>
```

Attributes, styling and the wire protocol are covered in the [client docs](https://github.com/BlairCurrey/hobbychat/blob/main/docs/client.md).

## Versions

Use a client version from the same release as your server. Until 1.0, a minor version bump (0.x → 0.y) may need a server update too.
