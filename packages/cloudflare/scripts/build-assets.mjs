// Builds everything the Worker serves as static assets into dist/assets:
//   /client.js        <hobby-chat> web component + headless client
//   /admin/           admin dashboard
//   /, /demo/         landing and dev demo pages
// Run automatically by wrangler (see "build" in wrangler.jsonc).
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packages = resolve(here, "../..");
const out = resolve(here, "../dist/assets");

await rm(out, { recursive: true, force: true });
await mkdir(resolve(out, "admin"), { recursive: true });

const common = { bundle: true, minify: true, target: "es2022", legalComments: "none", logLevel: "warning" };

await Promise.all([
  build({
    ...common,
    entryPoints: [resolve(packages, "client/src/script.ts")],
    outfile: resolve(out, "client.js"),
    format: "iife",
  }),
  build({
    ...common,
    entryPoints: [resolve(packages, "admin/src/admin.ts")],
    outfile: resolve(out, "admin/admin.js"),
    format: "esm",
  }),
  cp(resolve(packages, "admin/src/index.html"), resolve(out, "admin/index.html")),
  cp(resolve(packages, "admin/src/admin.css"), resolve(out, "admin/admin.css")),
  cp(resolve(here, "../static"), out, { recursive: true }),
]);
