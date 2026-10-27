// Images for the screenshot gallery: what MCP tools returned, what was attached in the session,
// and screenshots in the project. A game project holds thousands of sprite and texture files,
// so project images count only if they changed during the session or sit in a folder whose
// name says screenshots. The walk is capped in time and count so it never stalls the app.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "./config.js";
import { IMAGE_DIR } from "./mcpClient.js";
import { playShots } from "./play.js";
import type { Message } from "./provider.js";

export interface Shot {
  path: string;
  mtime: number;
  bytes: number;
  source: "play" | "tool" | "attached" | "project";
}

export const ATTACH_DIR = path.join(HOME, "attachments");
const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i;
const SHOT_DIR = /(^|[\\/])(screen[\s_-]?shots?|screencaps?|captures?|shots|snaps?)([\\/]|$)/i;
const SKIP = new Set(["node_modules", ".git", "library", "temp", "obj", ".godot", ".import", "packages", "logs", "build", "dist", ".venv", "__pycache__"]);

export function isImage(p: string) {
  return IMAGE_EXT.test(p);
}

function stat(p: string) {
  try {
    const s = fs.statSync(p);
    return s.isFile() ? s : undefined;
  } catch {
    return undefined;
  }
}

export async function listShots(cwd: string, history: Message[], since: number): Promise<Shot[]> {
  const found = new Map<string, Shot>();
  const add = (p: string, source: Shot["source"]) => {
    const key = path.resolve(p).toLowerCase();
    if (found.has(key) || !isImage(p)) return;
    const s = stat(p);
    if (s) found.set(key, { path: path.resolve(p), mtime: s.mtimeMs, bytes: s.size, source });
  };

  // Images named in the conversation: attachments, and files tools reported saving.
  for (const m of history) {
    if (m.role === "user") for (const img of m.images ?? []) add(img, "attached");
    if (m.role === "tool") {
      for (const match of m.content.matchAll(/[A-Za-z]:\\[^\n"'<>|*?]+?\.(?:png|jpe?g|webp|gif|bmp)/gi)) add(match[0], "tool");
    }
  }

  // This project's play runs, from the Play button or the agent's play tool.
  for (const p of playShots(cwd)) add(p, "play");

  // Everything MCP tools returned recently.
  try {
    const files = fs.readdirSync(IMAGE_DIR).map((f) => path.join(IMAGE_DIR, f));
    for (const f of files) {
      const s = stat(f);
      if (s && s.mtimeMs >= since - 24 * 3600_000) add(f, "tool");
    }
  } catch {}

  // The project: new or changed images, and anything in a screenshots folder.
  const started = Date.now();
  let visited = 0;
  const walk = async (dir: string, depth: number) => {
    if (depth < 0 || Date.now() - started > 3000 || visited > 20_000) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    visited += entries.length;
    const inShotDir = SHOT_DIR.test(dir);
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && isImage(e.name)) {
        const s = stat(full);
        if (s && (inShotDir || s.mtimeMs >= since)) found.set(full.toLowerCase(), { path: full, mtime: s.mtimeMs, bytes: s.size, source: "project" });
      }
    }
    await Promise.all(entries.filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name.toLowerCase())).map((e) => walk(path.join(dir, e.name), depth - 1)));
  };
  if (!/[\\/]\.perch[\\/]scratch[\\/]/i.test(cwd) || fs.existsSync(cwd)) await walk(cwd, 6);

  return [...found.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 400);
}

// Saves a pasted or dropped image so it can be attached by path.
export function saveAttachment(bytes: Uint8Array, mime: string): string {
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  const ext = mime.includes("jpeg") ? "jpg" : (mime.split("/")[1] ?? "png").replace(/[^a-z0-9]/gi, "");
  const file = path.join(ATTACH_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`);
  fs.writeFileSync(file, bytes);
  return file;
}
