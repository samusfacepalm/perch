// Dev helper: how long undo's snapshot takes in a folder, first time and after.
// Uses a throwaway store, so the real ~/.perch/snapshots is untouched.
//   node scripts/bench-snapshot.mjs <folder>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tsImport } from "tsx/esm/api";

const dir = path.resolve(process.argv[2] ?? ".");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "perch-snap-"));
process.env.USERPROFILE = home;
process.env.HOME = home;
const { snapshot } = await tsImport("../src/snapshot.ts", import.meta.url);
for (const label of ["first", "second", "third"]) {
  const t0 = performance.now();
  const tree = await snapshot(dir, { wait: true });
  console.log(`${label}: ${Math.round(performance.now() - t0)} ms, tree ${tree ?? "(none: too big or not possible)"}`);
}
const store = fs.readdirSync(path.join(home, ".perch", "snapshots"))[0];
const size = (p) => (fs.statSync(p).isDirectory() ? fs.readdirSync(p).reduce((n, f) => n + size(path.join(p, f)), 0) : fs.statSync(p).size);
if (store) console.log(`store size: ${Math.round(size(path.join(home, ".perch", "snapshots", store)) / 1e6)} MB`);
fs.rmSync(home, { recursive: true, force: true });
