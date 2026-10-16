import { defineConfig } from "@hobbychat/core";

// Which sites may use this chat server, and how each app behaves.
// Any app ID works from an allowed origin with these defaults; add an entry
// under `apps` only to override something. See docs/configuration.md.
export default defineConfig({
  // Set to false to accept only the apps listed under `apps`.
  allowUnlistedApps: true,
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
    // "my-game": { rooms: /^match-\d+$/, retention: "3d" },
    // "guestbook": { rooms: ["lobby"], retention: "forever", maxMessagesPerRoom: 1000 },
  },
});
