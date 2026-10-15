import type { Message } from "@hobbychat/protocol";
import { connect, type ChatClient, type ChatStatus } from "./client.ts";

const STYLE = `
:host {
  --hc-bg: #ffffff;
  --hc-fg: #1f2328;
  --hc-muted: #6e7781;
  --hc-border: #d0d7de;
  --hc-accent: #0969da;
  --hc-mine: #ddf4ff;
  --hc-radius: 10px;
  display: block;
  height: 400px;
  font: 14px/1.4 var(--hobbychat-font, system-ui, -apple-system, "Segoe UI", sans-serif);
  color: var(--hobbychat-fg, var(--hc-fg));
}
@media (prefers-color-scheme: dark) {
  :host {
    --hc-bg: #0d1117;
    --hc-fg: #e6edf3;
    --hc-muted: #8d96a0;
    --hc-border: #30363d;
    --hc-accent: #4493f8;
    --hc-mine: #0c2d6b;
  }
}
* { box-sizing: border-box; }
.chat {
  display: flex; flex-direction: column; height: 100%;
  background: var(--hobbychat-bg, var(--hc-bg));
  border: 1px solid var(--hobbychat-border, var(--hc-border));
  border-radius: var(--hobbychat-radius, var(--hc-radius));
  overflow: hidden;
}
header {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; border-bottom: 1px solid var(--hobbychat-border, var(--hc-border));
  font-weight: 600;
}
header .me { margin-left: auto; font-weight: 400; color: var(--hobbychat-muted, var(--hc-muted)); font-size: 12px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--hc-muted); flex: none; }
.dot[data-status="open"] { background: #1a7f37; }
.dot[data-status="banned"] { background: #cf222e; }
ol { list-style: none; margin: 0; padding: 8px 12px; flex: 1; overflow-y: auto; }
li { padding: 4px 8px; margin: 2px 0; border-radius: 6px; overflow-wrap: anywhere; white-space: pre-wrap; }
li.mine { background: var(--hobbychat-mine, var(--hc-mine)); }
li.pending { opacity: 0.55; }
.name { font-weight: 600; margin-right: 6px; }
.time { color: var(--hobbychat-muted, var(--hc-muted)); font-size: 11px; margin-left: 6px; }
.empty { color: var(--hobbychat-muted, var(--hc-muted)); text-align: center; padding: 24px 0; }
.notice { padding: 4px 12px; font-size: 12px; color: #cf222e; min-height: 0; }
.notice:empty { display: none; }
form { display: flex; gap: 8px; padding: 8px; border-top: 1px solid var(--hobbychat-border, var(--hc-border)); }
input {
  flex: 1; min-width: 0; padding: 8px 10px; font: inherit; color: inherit;
  background: transparent; border: 1px solid var(--hobbychat-border, var(--hc-border)); border-radius: 6px;
}
input:focus { outline: 2px solid var(--hobbychat-accent, var(--hc-accent)); outline-offset: -1px; }
button {
  padding: 8px 14px; font: inherit; font-weight: 600; color: #fff; cursor: pointer;
  background: var(--hobbychat-accent, var(--hc-accent)); border: 0; border-radius: 6px;
}
button:disabled, input:disabled { opacity: 0.5; cursor: not-allowed; }
`;

const TEMPLATE = `
<div class="chat" part="container">
  <header part="header"><span class="dot"></span><span class="room"></span><span class="me"></span></header>
  <ol part="messages" aria-live="polite"></ol>
  <div class="notice" role="status"></div>
  <form part="form">
    <input type="text" autocomplete="off" aria-label="Message" />
    <button type="submit">Send</button>
  </form>
</div>`;

const STATUS_TEXT: Record<ChatStatus, string> = {
  connecting: "Connecting…",
  open: "Connected",
  closed: "Reconnecting…",
  banned: "You've been banned from this chat",
};

/** Origin of the script tag that loaded this file, used as the default server. */
const scriptOrigin = (() => {
  try {
    const src = (document.currentScript as HTMLScriptElement | null)?.src;
    return src ? new URL(src).origin : null;
  } catch {
    return null;
  }
})();

function hue(uid: string): number {
  let h = 0;
  for (const c of uid) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

/**
 * `<hobby-chat app="my-app" room="lobby"></hobby-chat>`
 *
 * Attributes: `app`, `room` (default "lobby"), `server` (defaults to wherever
 * this script was loaded from), `placeholder`.
 * Style it with CSS variables like `--hobbychat-accent`, or `::part(...)`.
 */
export class HobbyChatElement extends HTMLElement {
  static observedAttributes = ["app", "room", "server"];

  private client: ChatClient | null = null;
  private readonly root: ShadowRoot;
  private readonly list: HTMLOListElement;
  private readonly input: HTMLInputElement;
  private readonly button: HTMLButtonElement;
  private readonly notice: HTMLElement;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = STYLE;
    this.root.append(style);
    this.root.append(document.createRange().createContextualFragment(TEMPLATE));
    this.list = this.root.querySelector("ol")!;
    this.input = this.root.querySelector("input")!;
    this.button = this.root.querySelector("button")!;
    this.notice = this.root.querySelector(".notice")!;
    this.root.querySelector("form")!.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit();
    });
  }

  connectedCallback(): void {
    this.start();
  }

  disconnectedCallback(): void {
    this.client?.close();
    this.client = null;
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null): void {
    if (oldValue !== newValue && this.isConnected) this.start();
  }

  /** The underlying headless client, for listening to events from outside. */
  get chat(): ChatClient | null {
    return this.client;
  }

  private start(): void {
    this.client?.close();
    const app = this.getAttribute("app");
    const room = this.getAttribute("room") || "lobby";
    const server = this.getAttribute("server") || scriptOrigin;
    this.root.querySelector(".room")!.textContent = `#${room}`;
    this.input.placeholder = this.getAttribute("placeholder") || "Say something…";
    this.list.replaceChildren();
    if (!app || !server) {
      this.showNotice(!app ? 'Missing the "app" attribute' : 'Missing the "server" attribute', true);
      return;
    }

    const client = connect({ url: server, app, room });
    this.client = client;
    this.renderStatus(client.status);
    client.on("status", (s) => this.renderStatus(s));
    client.on("welcome", ({ you, history }) => {
      this.root.querySelector(".me")!.textContent = `you are ${you.name}`;
      const pending = [...this.list.querySelectorAll("li.pending")];
      this.list.replaceChildren(...history.map((m) => this.renderMessage(m)), ...pending);
      this.renderEmpty();
      this.scrollToEnd(true);
    });
    client.on("message", (m) => {
      const stick = this.nearBottom();
      const pending = m.clientId && m.uid === client.me?.uid
        ? this.list.querySelector(`li[data-client-id="${CSS.escape(m.clientId)}"]`)
        : null;
      const li = this.renderMessage(m);
      if (pending) pending.replaceWith(li);
      else this.list.append(li);
      this.renderEmpty();
      this.scrollToEnd(stick);
    });
    client.on("deleted", (id) => {
      this.list.querySelector(`li[data-id="${CSS.escape(id)}"]`)?.remove();
      this.renderEmpty();
    });
    client.on("error", (e) => {
      // A rejected post never echoes back, so drop its optimistic copy.
      if (e.clientId) this.list.querySelector(`li.pending[data-client-id="${CSS.escape(e.clientId)}"]`)?.remove();
      this.showNotice(e.message ?? e.code);
    });
  }

  private submit(): void {
    const body = this.input.value.trim();
    if (!body || !this.client || this.client.status === "banned") return;
    const clientId = this.client.send(body);
    const me = this.client.me;
    const li = this.renderMessage({ id: "", room: "", uid: me?.uid ?? "", name: me?.name ?? "you", body, createdAt: Date.now() });
    li.classList.add("pending");
    li.dataset.clientId = clientId;
    this.list.append(li);
    this.renderEmpty();
    this.scrollToEnd(true);
    this.input.value = "";
  }

  private renderMessage(m: Message): HTMLLIElement {
    const li = document.createElement("li");
    if (m.id) li.dataset.id = m.id;
    if (m.uid && m.uid === this.client?.me?.uid) li.classList.add("mine");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = m.name;
    name.style.color = `hsl(${hue(m.uid)} 60% 45%)`;
    const body = document.createElement("span");
    body.textContent = m.body; // plain text only, never HTML
    const time = document.createElement("time");
    time.className = "time";
    time.dateTime = new Date(m.createdAt).toISOString();
    time.textContent = new Date(m.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    li.append(name, body, time);
    return li;
  }

  private renderEmpty(): void {
    const empty = this.list.querySelector(".empty");
    const hasMessages = this.list.querySelector("li:not(.empty)");
    if (hasMessages) empty?.remove();
    else if (!empty) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No messages yet. Say hi!";
      this.list.append(li);
    }
  }

  private renderStatus(status: ChatStatus): void {
    this.root.querySelector<HTMLElement>(".dot")!.dataset.status = status;
    this.root.querySelector<HTMLElement>(".dot")!.title = STATUS_TEXT[status];
    const disabled = status === "banned";
    this.input.disabled = disabled;
    this.button.disabled = disabled;
    if (status === "banned") this.showNotice(STATUS_TEXT.banned, true);
  }

  private showNotice(text: string, sticky = false): void {
    clearTimeout(this.noticeTimer);
    this.notice.textContent = text;
    if (!sticky) this.noticeTimer = setTimeout(() => (this.notice.textContent = ""), 4000);
  }

  private nearBottom(): boolean {
    return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 60;
  }

  private scrollToEnd(force: boolean): void {
    if (force) this.list.scrollTop = this.list.scrollHeight;
  }
}

export function defineHobbyChat(tag = "hobby-chat"): void {
  if (!customElements.get(tag)) customElements.define(tag, HobbyChatElement);
}
