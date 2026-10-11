# Using the client

Your server serves the client at `/client.js`. Load it with a script tag. It registers the `<hobby-chat>` element and exposes `window.HobbyChat` for custom UIs.

## The `<hobby-chat>` widget

```html
<script src="https://YOUR-SERVER/client.js"></script>
<hobby-chat app="my-game" room="lobby"></hobby-chat>
```

| Attribute     | Default                           | |
| ------------- | --------------------------------- | - |
| `app`         | (required)                        | Your app's name. Any name works; see [configuration](configuration.md). |
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
const chat = HobbyChat.connect({
  url: "https://YOUR-SERVER",
  app: "my-game",
  room: "lobby",
});

chat.on("welcome", ({ you, history }) => {
  // Fires on every (re)connect. Replace whatever you show with `history`.
});
chat.on("message", (m) => {
  // { id, room, uid, name, body, createdAt, clientId? }
});
chat.on("deleted", (id) => { /* remove message `id` */ });
chat.on("error", (e) => { /* e.code: rate_limited | too_long | room_limit | invalid */ });
chat.on("status", (s) => { /* connecting | open | closed | banned */ });

const clientId = chat.send("hello!"); // the echoed message carries the same clientId
chat.me;      // { uid, name } once joined
chat.close();
```

Message bodies are plain text from strangers. **Always render them as text** (`textContent`), never as HTML.

The client reconnects with backoff and sends a heartbeat every 30 seconds. It also stores a signed token in `localStorage`, so people keep their name across visits. Messages sent while reconnecting are queued.

The same API is available as an ES module from `packages/client` if you bundle your own code. It isn't published to npm yet.

## Wire protocol

If you want to talk to the server from something other than JavaScript: open a WebSocket to `wss://YOUR-SERVER/ws?app=APP&room=ROOM` (it must send an allowed `Origin` header) and exchange JSON:

- Client to server: `{"type":"hello","token":"…optional"}` first, then `{"type":"post","body":"…","clientId":"…"}`. Send the plain text `ping` for a `pong`.
- Server to client: `welcome` (`you`, `token`, `history`), `message`, `deleted`, `error`, `banned`.

The full types live in [`packages/protocol`](../packages/protocol/src/index.ts).
