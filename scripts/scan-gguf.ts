import { scanGguf } from "../src/local.js";
const t = Date.now();
let dirs = 0;
const models = await scanGguf(() => dirs++);
console.log(`${models.length} models, ${dirs} folders scanned in ${((Date.now() - t) / 1000).toFixed(1)}s`);
for (const m of models) console.log(`${String(m.sizeGB).padStart(6)} GB  ${m.name}${m.mmproj ? "  [vision]" : ""}\n          ${m.path}`);
