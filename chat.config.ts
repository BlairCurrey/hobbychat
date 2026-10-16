import { defineConfig } from "@hobbychat/core";

// Which sites may use this chat server, and which apps it serves.
// Only apps listed under `apps` work; each uses `defaults` unless it overrides
// something. See docs/configuration.md.
export default defineConfig({
  defaults: {
    // Sites allowed to connect, e.g. "https://mygame.com". Usually easier to set via the
    // ALLOWED_ORIGINS variable instead. `pnpm dev` always allows localhost.
    origins: [],
    rooms: "open",
    maxActiveRooms: 50,
    retention: "30d",
    maxMessagesPerRoom: null,
    maxMessageLength: 500,
    rateLimit: "10/min",
    historyOnJoin: 50,
  },
  apps: {
    // "my-game": {},
    // "scores": { rooms: /^match-\d+$/, retention: "3d" },
    // "guestbook": { rooms: ["lobby"], retention: "forever", maxMessagesPerRoom: 1000 },
  },
});
