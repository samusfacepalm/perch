// Bundles the desktop app into app-dist/: the main process (with the agent code), the
// preload bridge and the window's React UI.

import { build } from "esbuild";
import fs from "node:fs";

const out = "app-dist";
fs.mkdirSync(out, { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: "warning", jsx: "automatic" };

await Promise.all([
  build({ ...common, entryPoints: ["electron/main.ts"], outfile: `${out}/main.cjs`, platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["electron/preload.ts"], outfile: `${out}/preload.cjs`, platform: "node", format: "cjs", external: ["electron"] }),
  build({ ...common, entryPoints: ["electron/renderer/main.tsx"], outfile: `${out}/renderer.js`, platform: "browser", format: "iife", loader: { ".svg": "dataurl" }, define: { "process.env.NODE_ENV": '"production"' }, minify: true }),
]);

for (const f of ["index.html", "styles.css"]) fs.copyFileSync(`electron/renderer/${f}`, `${out}/${f}`);
if (fs.existsSync("electron/icon.png")) fs.copyFileSync("electron/icon.png", `${out}/icon.png`);
console.log("Built app-dist/");
