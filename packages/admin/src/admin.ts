import type { AdminMessage, Ban, BanRequest, RoomSummary } from "@hobbychat/core";

const API = "/admin/api";

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;

// ---- helpers ----

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: init.body ? { "content-type": "application/json" } : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function setStatus(text: string, isError = false): void {
  const el = $<HTMLElement>("#status");
  el.textContent = text;
  el.classList.toggle("error", isError);
}

async function run(action: () => Promise<void>): Promise<void> {
  try {
    setStatus("");
    await action();
  } catch (err) {
    setStatus((err as Error).message, true);
  }
}

/** Build an element. Text is always set via textContent, never parsed as HTML. */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<{ text: string; className: string; title: string; onClick: () => void }> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.text !== undefined) node.textContent = props.text;
  if (props.className) node.className = props.className;
  if (props.title) node.title = props.title;
  if (props.onClick) node.addEventListener("click", props.onClick);
  node.append(...children);
  return node;
}

function button(text: string, onClick: () => void, className = ""): HTMLButtonElement {
  const b = el("button", { text, className, onClick });
  b.type = "button";
  return b;
}

function time(ms: number | null): string {
  return ms === null ? "never" : new Date(ms).toLocaleString();
}

function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 10)}…` : value;
}

// ---- messages ----

let filters: Record<string, string> = {};
let nextCursor: string | null = null;

async function loadMessages(append = false): Promise<void> {
  const params = new URLSearchParams({ ...filters, limit: "50" });
  if (append && nextCursor) params.set("before", nextCursor);
  const { messages, next } = await api<{ messages: AdminMessage[]; next: string | null }>(`/messages?${params}`);
  nextCursor = next;
  const tbody = $<HTMLTableSectionElement>("#messages tbody");
  const rows = messages.map(messageRow);
  if (append) tbody.append(...rows);
  else tbody.replaceChildren(...rows);
  if (!append && !messages.length) {
    tbody.append(el("tr", {}, el("td", { text: "No messages.", className: "muted" })));
  }
  $<HTMLButtonElement>("#more").hidden = !next;
}

function filterBy(values: Record<string, string>): void {
  filters = values;
  const form = $<HTMLFormElement>("#filters");
  for (const name of ["app", "room", "uid"]) {
    (form.elements.namedItem(name) as HTMLInputElement).value = values[name] ?? "";
  }
  showTab("messages");
  void run(() => loadMessages());
}

function messageRow(m: AdminMessage): HTMLTableRowElement {
  const row = el(
    "tr",
    {},
    el("td", { className: "muted", text: time(m.createdAt) }),
    el(
      "td",
      {},
      button(m.app, () => filterBy({ app: m.app }), "link"),
      " / ",
      button(m.room, () => filterBy({ app: m.app, room: m.room }), "link"),
    ),
    el("td", {}, button(m.name, () => filterBy({ uid: m.uid }), "link"), el("div", { className: "muted", text: short(m.uid), title: m.uid })),
    el("td", { className: "body", text: m.body }),
    el(
      "td",
      { className: "actions" },
      button("Delete", async () => {
        const preview = m.body.length > 80 ? `${m.body.slice(0, 80)}…` : m.body;
        const sure = await confirmAction(
          `Delete ${m.name}'s message?`,
          `"${preview}" will be permanently deleted and disappear for everyone right away.`,
          "Delete",
        );
        if (!sure) return;
        void run(async () => {
          await api(`/messages/${encodeURIComponent(m.id)}`, { method: "DELETE" });
          row.remove();
          setStatus("Message deleted.");
        });
      }, "danger"),
      button("Ban", () => openBanDialog(m)),
    ),
  );
  return row;
}

// ---- dialogs ----

const banDialog = $<HTMLDialogElement>("#ban-dialog");
const banForm = banDialog.querySelector("form")!;
const field = <T extends HTMLElement = HTMLElement>(root: Element, name: string) =>
  root.querySelector<T>(`[data-field="${name}"]`)!;
const control = <T extends Element>(name: string) => banForm.elements.namedItem(name) as T;
let banTarget: AdminMessage | null = null;

function openBanDialog(m: AdminMessage): void {
  banTarget = m;
  banForm.reset();
  field(banDialog, "name").textContent = m.name;
  field(banDialog, "body").textContent = m.body;
  field(banDialog, "error").textContent = "";
  field(banDialog, "ip").hidden = !m.ipHash; // messages from clients without an IP can't be IP-banned
  updateBanButton();
  banDialog.showModal();
}

function updateBanButton(): void {
  const any = control<HTMLInputElement>("uid").checked || control<HTMLInputElement>("ip").checked;
  banForm.querySelector<HTMLButtonElement>('button[value="confirm"]')!.disabled = !any;
}

banForm.addEventListener("change", updateBanButton);

banForm.addEventListener("submit", (e) => {
  if (e.submitter?.getAttribute("value") !== "confirm" || !banTarget) return;
  e.preventDefault();
  const m = banTarget;
  const reason = control<HTMLInputElement>("reason").value.trim() || null;
  const duration = (name: string) => Number(control<HTMLSelectElement>(name).value) || null;
  const requests: BanRequest[] = [];
  if (control<HTMLInputElement>("uid").checked) {
    requests.push({ kind: "uid", value: m.uid, durationMs: duration("uidDuration") });
  }
  if (control<HTMLInputElement>("ip").checked && m.ipHash) {
    requests.push({ kind: "ip", value: m.ipHash, durationMs: duration("ipDuration") });
  }
  void (async () => {
    try {
      for (const r of requests) {
        await api("/bans", { method: "POST", body: JSON.stringify({ ...r, reason, app: m.app, room: m.room }) });
      }
      banDialog.close();
      const what = requests.map((r) => (r.kind === "uid" ? "browser" : "IP address")).join(" and ");
      setStatus(`Banned ${m.name}'s ${what}.`);
    } catch (err) {
      field(banDialog, "error").textContent = (err as Error).message;
    }
  })();
});

const confirmDialog = $<HTMLDialogElement>("#confirm-dialog");

/** Resolves true if the user clicks the action button. */
function confirmAction(title: string, text: string, action: string): Promise<boolean> {
  field(confirmDialog, "title").textContent = title;
  field(confirmDialog, "text").textContent = text;
  field(confirmDialog, "action").textContent = action;
  confirmDialog.returnValue = "";
  confirmDialog.showModal();
  return new Promise((resolve) =>
    confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true }),
  );
}

// ---- rooms ----

async function loadRooms(): Promise<void> {
  const { rooms } = await api<{ rooms: RoomSummary[] }>("/rooms");
  const tbody = $<HTMLTableSectionElement>("#rooms tbody");
  tbody.replaceChildren(
    ...rooms.map((r) => {
      const row = el(
        "tr",
        {},
        el("td", { text: r.app }),
        el("td", {}, button(r.room, () => filterBy({ app: r.app, room: r.room }), "link")),
        el("td", { text: String(r.count) }),
        el("td", { className: "muted", text: time(r.lastAt) }),
        el(
          "td",
          { className: "actions" },
          button("Delete all messages", async () => {
            const sure = await confirmAction(
              `Clear ${r.app} / ${r.room}?`,
              `This permanently deletes all ${r.count} messages in this room, and they disappear for everyone right away.`,
              "Delete all",
            );
            if (!sure) return;
            void run(async () => {
              await api(`/rooms/${encodeURIComponent(r.app)}/${encodeURIComponent(r.room)}`, { method: "DELETE" });
              row.remove();
              setStatus(`Cleared ${r.app}/${r.room}.`);
            });
          }, "danger"),
        ),
      );
      return row;
    }),
  );
  if (!rooms.length) tbody.append(el("tr", {}, el("td", { text: "No active rooms.", className: "muted" })));
}

// ---- bans ----

async function loadBans(): Promise<void> {
  const { bans } = await api<{ bans: Ban[] }>("/bans");
  const tbody = $<HTMLTableSectionElement>("#bans tbody");
  tbody.replaceChildren(
    ...bans.map((b) => {
      const row = el(
        "tr",
        {},
        el("td", { text: b.kind === "uid" ? "Browser" : "IP address" }),
        el("td", {}, el("code", { text: short(b.value), title: b.value })),
        el("td", { text: b.reason ?? "" }),
        el("td", { className: "muted", text: time(b.createdAt) }),
        el("td", { className: "muted", text: time(b.expiresAt) }),
        el(
          "td",
          { className: "actions" },
          b.kind === "uid" ? button("Messages", () => filterBy({ uid: b.value }), "link") : "",
          button("Lift", () =>
            run(async () => {
              await api(`/bans/${b.kind}/${encodeURIComponent(b.value)}`, { method: "DELETE" });
              row.remove();
              setStatus("Ban lifted.");
            })),
        ),
      );
      return row;
    }),
  );
  if (!bans.length) tbody.append(el("tr", {}, el("td", { text: "No active bans.", className: "muted" })));
}

// ---- tabs ----

const loaders: Record<string, () => Promise<void>> = {
  messages: () => loadMessages(),
  rooms: loadRooms,
  bans: loadBans,
};

function showTab(name: string): void {
  for (const section of document.querySelectorAll<HTMLElement>("main section")) section.hidden = section.id !== name;
  for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
    b.classList.toggle("active", b.dataset.tab === name);
  }
}

for (const b of document.querySelectorAll<HTMLButtonElement>("nav button")) {
  b.addEventListener("click", () => {
    showTab(b.dataset.tab!);
    void run(loaders[b.dataset.tab!]!);
  });
}

$<HTMLFormElement>("#filters").addEventListener("submit", (e) => {
  e.preventDefault();
  const data = new FormData(e.target as HTMLFormElement);
  filterBy(Object.fromEntries([...data].filter(([, v]) => v).map(([k, v]) => [k, String(v).trim()])));
});
$<HTMLFormElement>("#filters").addEventListener("reset", () => filterBy({}));
$<HTMLButtonElement>("#more").addEventListener("click", () => run(() => loadMessages(true)));

void run(() => loadMessages());
