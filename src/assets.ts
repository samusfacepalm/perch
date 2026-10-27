// The project's art and sound files, for the asset browser.

import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { diff, grid, guessFrame, loadPng, palette } from "./imageinfo.js";

export interface Asset {
  path: string;
  rel: string;
  kind: "image" | "audio";
  bytes: number;
}

const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;
const AUDIO = /\.(ogg|wav|mp3|m4a|flac)$/i;
const SKIP = new Set(["node_modules", ".git", "library", "temp", "obj", ".godot", ".import", "logs", "build", "builds", "dist", ".venv", "__pycache__", ".perch"]);

export async function listAssets(cwd: string, limit = 4000): Promise<{ assets: Asset[]; truncated: boolean }> {
  const assets: Asset[] = [];
  const started = Date.now();
  let truncated = false;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth < 0 || truncated) return;
    if (assets.length >= limit || Date.now() - started > 5000) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const kind = IMAGE.test(e.name) ? "image" : AUDIO.test(e.name) ? "audio" : null;
      if (!kind) continue;
      const full = path.join(dir, e.name);
      let bytes = 0;
      try {
        bytes = fs.statSync(full).size;
      } catch {}
      assets.push({ path: full, rel: path.relative(cwd, full).split(path.sep).join("/"), kind, bytes });
    }
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name.toLowerCase())) await walk(path.join(dir, e.name), depth - 1);
  };
  await walk(cwd, 8);
  assets.sort((a, b) => a.rel.localeCompare(b.rel));
  return { assets, truncated };
}

export function imageInfo(file: string, frame?: { w: number; h: number }) {
  const img = loadPng(file);
  const f = frame ?? guessFrame(img);
  return {
    width: img.width,
    height: img.height,
    palette: palette(img, 32),
    frame: f,
    grid: f.w !== img.width || f.h !== img.height ? grid(img, f.w, f.h) : null,
  };
}

// A picture of where two screenshots differ: the second image dimmed, changed pixels in magenta.
export function diffMask(a: string, b: string): { dataUrl: string; changedPercent: number } | { error: string } {
  const A = loadPng(a);
  const B = loadPng(b);
  if (A.width !== B.width || A.height !== B.height) return { error: `Different sizes: ${A.width}×${A.height} and ${B.width}×${B.height}.` };
  const out = new PNG({ width: A.width, height: A.height });
  for (let i = 0; i < A.data.length; i += 4) {
    const d = Math.abs(A.data[i] - B.data[i]) + Math.abs(A.data[i + 1] - B.data[i + 1]) + Math.abs(A.data[i + 2] - B.data[i + 2]);
    if (d > 24) {
      out.data[i] = 255;
      out.data[i + 1] = 0;
      out.data[i + 2] = 200;
    } else {
      const g = Math.round((B.data[i] * 0.3 + B.data[i + 1] * 0.59 + B.data[i + 2] * 0.11) * 0.35);
      out.data[i] = out.data[i + 1] = out.data[i + 2] = g;
    }
    out.data[i + 3] = 255;
  }
  return { dataUrl: "data:image/png;base64," + PNG.sync.write(out).toString("base64"), changedPercent: diff(A, B).changedPercent };
}
