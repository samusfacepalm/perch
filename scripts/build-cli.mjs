// Bundles the terminal app into one file, dist/perch.mjs. Loading Ink and its dependencies
// file by file means reading hundreds of small modules at every start (es-toolkit's barrel
// alone is most of a quarter second); one bundled file starts several times faster.

import { build } from "esbuild";

await build({
  entryPoints: ["src/cli.tsx"],
  outfile: "dist/perch.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  jsx: "automatic",
  logLevel: "warning",
  external: ["electron"],
  // Ink's devtools mode needs react-devtools-core, which Perch doesn't install; stub it out.
  plugins: [
    {
      name: "no-devtools",
      setup(b) {
        b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: "devtools", namespace: "stub" }));
        b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default {};" }));
      },
    },
  ],
  define: { "process.env.NODE_ENV": '"production"' },
  // Bundled CommonJS packages still call require() for Node built-ins.
  banner: { js: 'import { createRequire as __perchRequire } from "node:module"; const require = __perchRequire(import.meta.url);' },
});
console.log("Built dist/perch.mjs");
