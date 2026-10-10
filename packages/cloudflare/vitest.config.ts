import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Static assets must exist before the Worker starts.
      await import("./scripts/build-assets.mjs");
      return {
        wrangler: { configPath: "../../wrangler.jsonc" },
        miniflare: {
          bindings: {
            HMAC_SECRET: "test-secret-at-least-16-chars",
            DEV_MODE: "true",
            TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
          },
        },
      };
    }),
  ],
  test: { setupFiles: ["./test/setup.ts"] },
});
