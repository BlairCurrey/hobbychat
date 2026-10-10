// Creates .dev.vars for local development on first run (random secret, dev mode on).
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve(process.cwd(), ".dev.vars");
if (!existsSync(file)) {
  writeFileSync(
    file,
    [
      "# Local development only (never deployed).",
      `HMAC_SECRET=${randomBytes(32).toString("hex")}`,
      "# Serves /demo and lets localhost into /admin without Cloudflare Access.",
      "DEV_MODE=true",
      "",
    ].join("\n"),
  );
  console.log("Created .dev.vars for local development.");
}
