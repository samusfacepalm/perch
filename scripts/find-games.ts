// Dev helper: find RPG Maker games and Unity builds on the local drives.
import fs from "node:fs";
import path from "node:path";
const SKIP = new Set(["windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information", "node_modules", ".git", "appdata", "library", "temp", ".venv", "site-packages", "__pycache__"]);
const want = /^(rmmz_core\.js|rpg_core\.js|unityplayer\.dll)$/i;
const hits: string[] = [];
const started = Date.now();
async function walk(dir: string, depth: number): Promise<void> {
  if (depth < 0 || Date.now() - started > 90_000) return;
  let entries: fs.Dirent[];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isFile() && want.test(e.name)) hits.push(path.join(dir, e.name));
  await Promise.all(entries.filter((e) => e.isDirectory() && !SKIP.has(e.name.toLowerCase())).map((e) => walk(path.join(dir, e.name), depth - 1)));
}
const roots = ["C:\\", "D:\\", "E:\\", "C:\Program Files (x86)\Steam\steamapps\common"];
await Promise.all(roots.map((r) => walk(r, r.includes("steamapps") ? 4 : 6)));
console.log(`${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const h of hits.sort()) console.log(h);
