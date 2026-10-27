// Dev helper: renders every mascot onto one contact sheet PNG.
import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";
import { BIRDS, birdSvg } from "../electron/renderer/mascots.js";
const cell = 256, cols = 3, rows = Math.ceil(BIRDS.length / cols);
const parts = BIRDS.map((b, i) => {
  const x = (i % cols) * cell, y = Math.floor(i / cols) * (cell + 28);
  const inner = birdSvg(b).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "").replace(/id="(\w+)"/g, `id="$1${i}"`).replace(/url\(#(\w+)\)/g, `url(#$1${i})`);
  return `<g transform="translate(${x} ${y})"><rect width="${cell}" height="${cell + 28}" fill="#1b1f23"/>${inner}<text x="${cell / 2}" y="${cell + 20}" fill="#e6e6e3" font-size="15" font-family="Segoe UI, sans-serif" text-anchor="middle">${b.name}</text></g>`;
});
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * (cell + 28)}">${parts.join("")}</svg>`;
fs.writeFileSync(process.argv[2], new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng());
console.log("written", process.argv[2]);
