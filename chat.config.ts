import { defineConfig } from "@hobbychat/core";

// Which sites may use this chat server, and which apps it serves.
// Only apps listed under `apps` work; each uses the built-in defaults unless it
// overrides something. All settings and their defaults: docs/configuration.md.
export default defineConfig({
  defaults: {
    // Sites allowed to connect, e.g. "https://mygame.com" or "https://*.mysite.dev".
    // You can also set them in the ALLOWED_ORIGINS variable. `pnpm dev` always allows localhost.
    origins: [],
    // Uncomment to change a setting for every app, for example:
    // retention: "7d",
    // rateLimit: "20/min",
  },
  apps: {
    // "my-game": {},
    // "scores": { rooms: /^match-\d+$/, retention: "3d" },
  },
});
