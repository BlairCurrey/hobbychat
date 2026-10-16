# Using the client

There are two ways to use hobbychat in a page:

- **The `<hobby-chat>` widget**: a ready-made chat box.
- **The headless client, `connect()`**: the connection, reconnecting and events with no UI, for building your own. The widget is built on it.

Get them either from your server's `/client.js` script, or from npm as `hobbychat` (with TypeScript types):

```ts
import { connect } from "hobbychat"; // headless client
import "hobbychat/widget";           // registers <hobby-chat>; set its `server` attribute
```

## The `<hobby-chat>` widget

```html
<script src="https://YOUR-SERVER/client.js"></script>
<hobby-chat app="my-game" room="lobby"></hobby-chat>
```

| Attribute     | Default                           | |
| ------------- | --------------------------------- | - |
| `app`         | (required)                        | Your app's name, as listed in `chat.config.ts`; see [configuration](configuration.md). |
| `room`        | `lobby`                           | Changing it switches rooms live. |
| `server`      | where `client.js` was loaded from | Set it if you bundle the client yourself. |
| `placeholder` | `Say something…`                  | Input placeholder. |

The widget is 400px tall by default. Size it like any block element (`hobby-chat { height: 100%; }`). It follows the user's light or dark mode.

**Styling.** Set CSS variables on the element:

```css
hobby-chat {
  --hobbychat-accent: #e11d48;
  --hobbychat-bg: #fffaf0;
  --hobbychat-fg: #222;
  --hobbychat-muted: #888;
  --hobbychat-border: #eee;
  --hobbychat-mine: #fde68a;  /* your own messages */
  --hobbychat-radius: 0;
  --hobbychat-font: "Comic Sans MS", cursive;
}
```

For deeper changes, target the `::part()`s: `container`, `header`, `messages` and `form`.

## Custom UI: the headless client

```js
const chat = HobbyChat.connect({ // or `connect` imported from "hobbychat"
  url: "https://YOUR-SERVER",
  app: "my-game",
  room: "lobby",
});

chat.on("welcome", ({ you, history, limits }) => {
  // Fires on every (re)connect. Replace whatever you show with `history`.
  // limits: { maxMessageLength, rateLimit: { count, windowMs } } for this room
});
chat.on("message", (m) => {
  // { id, room, uid, name, body, createdAt, clientId? }
});
chat.on("deleted", (id) => { /* remove message `id` */ });
chat.on("error", (e) => {
  // e.code: rate_limited | too_long | room_limit | invalid
  //         queue_full: sent while disconnected and the offline queue is full
  // e.clientId: set when a post was rejected; matches the value send() returned
});
chat.on("status", (s) => { /* connecting | open | closed | banned */ });

const clientId = chat.send("hello!"); // the echoed message carries the same clientId
chat.me;      // { uid, name } once joined
chat.limits;  // the room's limits once joined
chat.close();
```

Message bodies are plain text from strangers. **Always render them as text** (`textContent`), never as HTML.

The client reconnects with backoff and sends a heartbeat every 30 seconds. It also stores a signed token in `localStorage`, so people keep their name across visits. Messages sent while reconnecting are queued, up to as many as the room's rate limit allows at once (so they all go through on reconnect); beyond that, `send()` fails with `queue_full`.

Use the npm package from the same release as your server. Until 1.0, a minor version bump may need a server update too.

## Wire protocol

If you want to talk to the server from something other than JavaScript: open a WebSocket to `wss://YOUR-SERVER/ws?app=APP&room=ROOM` (it must send an allowed `Origin` header) and exchange JSON:

- Client to server: `{"type":"hello","token":"…optional"}` first, then `{"type":"post","body":"…","clientId":"…"}`. Send the plain text `ping` for a `pong`.
- Server to client: `welcome` (`you`, `token`, `history`), `message`, `deleted`, `error`, `banned`.

The full types live in [`packages/protocol`](../packages/protocol/src/index.ts).
