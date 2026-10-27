// Facts about images that matter for game art: size, palette, transparency, sprite-sheet grid,
// and how much two screenshots differ. Pure JavaScript (pngjs), so it works in the CLI and the app.

import fs from "node:fs";
import { PNG } from "pngjs";

export interface Img {
  width: number;
  height: number;
  data: Buffer; // RGBA
}

export function loadPng(file: string): Img {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

const hex = (r: number, g: number, b: number) => "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");

export interface PaletteInfo {
  colours: number; // distinct opaque colours
  top: { hex: string; share: number }[]; // most used, share of opaque pixels
  transparentPixels: number;
  partialAlphaPixels: number; // semi-transparent: often a sign of anti-aliasing in pixel art
}

export function palette(img: Img, limit = 32): PaletteInfo {
  const counts = new Map<number, number>();
  let transparent = 0;
  let partial = 0;
  let opaque = 0;
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) {
      transparent++;
      continue;
    }
    if (a < 255) partial++;
    opaque++;
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, n]) => ({ hex: hex(k >> 16, (k >> 8) & 255, k & 255), share: Math.round((n / Math.max(1, opaque)) * 1000) / 10 }));
  return { colours: counts.size, top, transparentPixels: transparent, partialAlphaPixels: partial };
}

export interface GridInfo {
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  fits: boolean; // image is a whole number of frames
  emptyFrames: number[]; // fully transparent frames, row-major index
  baselines: number[]; // bottom-most opaque row in each frame (-1 if empty), for checking animation alignment
}

export function grid(img: Img, frameWidth: number, frameHeight: number): GridInfo {
  const columns = Math.floor(img.width / frameWidth);
  const rows = Math.floor(img.height / frameHeight);
  const emptyFrames: number[] = [];
  const baselines: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      let lowest = -1;
      for (let y = 0; y < frameHeight; y++) {
        const row = (r * frameHeight + y) * img.width;
        for (let x = 0; x < frameWidth; x++) {
          if (img.data[(row + c * frameWidth + x) * 4 + 3] > 0) {
            lowest = y;
            break;
          }
        }
      }
      if (lowest < 0) emptyFrames.push(r * columns + c);
      baselines.push(lowest);
    }
  }
  return { frameWidth, frameHeight, columns, rows, fits: img.width % frameWidth === 0 && img.height % frameHeight === 0, emptyFrames, baselines };
}

// Guesses the frame size of a sprite sheet laid out as a strip of square frames. Anything else
// is treated as a single image unless the caller gives a frame size.
export function guessFrame(img: Img): { w: number; h: number } {
  if (img.width > img.height && img.width % img.height === 0) return { w: img.height, h: img.height };
  if (img.height > img.width && img.height % img.width === 0) return { w: img.width, h: img.width };
  return { w: img.width, h: img.height };
}

export interface Diff {
  changedPercent: number;
  sameSize: boolean;
  box?: { x: number; y: number; w: number; h: number }; // bounding box of the changes
}

// Share of pixels that differ noticeably between two images of the same size.
export function diff(a: Img, b: Img, threshold = 24): Diff {
  if (a.width !== b.width || a.height !== b.height) return { changedPercent: 100, sameSize: false };
  let changed = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0, p = 0; i < a.data.length; i += 4, p++) {
    const d = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) + Math.abs(a.data[i + 3] - b.data[i + 3]);
    if (d > threshold) {
      changed++;
      const x = p % a.width, y = Math.floor(p / a.width);
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  const pct = Math.round((changed / (a.width * a.height)) * 10000) / 100;
  return { changedPercent: pct, sameSize: true, box: changed ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : undefined };
}

export function describe(file: string, frame?: { w: number; h: number }): string {
  const img = loadPng(file);
  const pal = palette(img, 24);
  const lines = [
    `${file}`,
    `Size: ${img.width}×${img.height}`,
    `Colours: ${pal.colours} distinct opaque colours${pal.colours > 64 ? " (a lot for pixel art; may be anti-aliased, scaled or a photo/render)" : ""}`,
    `Transparency: ${pal.transparentPixels} fully transparent pixels, ${pal.partialAlphaPixels} semi-transparent${pal.partialAlphaPixels ? " (pixel art usually has none; these are often soft edges)" : ""}`,
    `Most used: ${pal.top.map((t) => `${t.hex} ${t.share}%`).join(", ")}`,
  ];
  const f = frame ?? guessFrame(img);
  if (f.w !== img.width || f.h !== img.height) {
    const g = grid(img, f.w, f.h);
    const bases = new Set(g.baselines.filter((b) => b >= 0));
    lines.push(
      `Grid at ${f.w}×${f.h}: ${g.columns} columns × ${g.rows} rows${g.fits ? "" : " (image is NOT a whole number of frames)"}`,
      g.emptyFrames.length ? `Empty frames: ${g.emptyFrames.join(", ")}` : "No empty frames.",
      bases.size > 1 ? `The art's bottom edge (where feet usually are) sits on different rows across frames (${[...bases].sort((a, b) => a - b).join(", ")}); check the animation doesn't jump unintentionally.` : "The art's bottom edge sits on the same row in every frame.",
    );
  }
  return lines.join("\n");
}

// Cheap warnings about a screenshot that a model without vision can read too: a frame that is
// almost one colour (nothing drew), almost black, or largely blown out to white.
export function frameWarnings(file: string): string[] {
  const img = loadPng(file);
  const buckets = new Map<number, number>();
  let n = 0;
  let lum = 0;
  let white = 0;
  for (let i = 0; i < img.data.length; i += 4 * 7) {
    const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    lum += l;
    if (l > 245) white++;
    n++;
  }
  if (!n) return [];
  const out: string[] = [];
  const top = Math.max(...buckets.values()) / n;
  if (top > 0.97) out.push("almost all one colour: the page or game may have drawn nothing");
  else if (lum / n < 10) out.push("almost black: the scene may be unlit or the camera may face nothing");
  if (top <= 0.97 && white / n > 0.3) out.push(`${Math.round((100 * white) / n)}% pure white: likely overexposed or blown-out glow`);
  return out;
}
