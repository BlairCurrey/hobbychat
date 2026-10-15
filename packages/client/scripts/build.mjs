// Builds the npm package into dist/:
//   index.js   headless client (`import { connect } from "hobbychat"`)
//   widget.js  registers <hobby-chat> (`import "hobbychat/widget"`)
//   *.d.ts     types, with the private protocol package's types inlined
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const protocolSrc = resolve(root, "../protocol/src/index.ts");

await rm(dist, { recursive: true, force: true });

await build({
  entryPoints: [join(root, "src/index.ts"), join(root, "src/widget.ts")],
  outdir: dist,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "warning",
});

const tsc = (args) => execFileSync("tsc", args, { cwd: root, stdio: "inherit" });
tsc(["-p", "tsconfig.build.json"]);

// @hobbychat/protocol isn't published, so ship its declarations as dist/protocol.d.ts.
const tmp = await mkdtemp(join(tmpdir(), "hobbychat-dts-"));
tsc([protocolSrc, "--ignoreConfig", "--declaration", "--emitDeclarationOnly", "--target", "ES2022", "--module", "ESNext",
  "--moduleResolution", "bundler", "--skipLibCheck", "--outDir", tmp]);
await copyFile(join(tmp, "index.d.ts"), join(dist, "protocol.d.ts"));
await rm(tmp, { recursive: true, force: true });

// Point declaration imports at the shipped files.
for (const file of (await readdir(dist)).filter((f) => f.endsWith(".d.ts"))) {
  const path = join(dist, file);
  const text = (await readFile(path, "utf8"))
    .replaceAll('"@hobbychat/protocol"', '"./protocol.js"')
    .replace(/(from\s+"\.\/[^"]+)\.ts"/g, '$1.js"');
  await writeFile(path, text);
}

await copyFile(resolve(root, "../../LICENSE"), join(dist, "LICENSE"));
