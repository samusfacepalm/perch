// Renders electron/parrot.svg to the app icon: a 256px PNG, and an .ico for Windows shortcuts
// built from several sizes rendered straight from the vector (sharper than scaling one image).
// The icon puts the parrot on a rounded dark-green badge so it reads on any taskbar.

import { Resvg } from "@resvg/resvg-js";
import fs from "node:fs";

const parrot = fs.readFileSync("electron/parrot.svg", "utf8");
const inner = parrot.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");

const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
  <defs>
    <radialGradient id="bg" cx="0.35" cy="0.25" r="0.9">
      <stop offset="0" stop-color="#2b5a3c"/>
      <stop offset="1" stop-color="#10231a"/>
    </radialGradient>
  </defs>
  <clipPath id="badge"><rect x="4" y="4" width="248" height="248" rx="56"/></clipPath>
  <rect x="4" y="4" width="248" height="248" rx="56" fill="url(#bg)"/>
  <!-- The parrot fills the badge, so it still reads at taskbar size; the branch runs off the edges. -->
  <g clip-path="url(#badge)"><g transform="translate(-44 -2) scale(1.2)">${inner}</g></g>
</svg>`;

const render = (svg, size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

fs.writeFileSync("electron/icon.png", render(badge, 256));
fs.writeFileSync("electron/icon-badge.svg", badge);

// ICO: a header, one directory entry per size, then the PNG data for each.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pngs = sizes.map((s) => render(badge, s));
const header = Buffer.alloc(6 + 16 * sizes.length);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
sizes.forEach((s, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(s === 256 ? 0 : s, e);
  header.writeUInt8(s === 256 ? 0 : s, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(pngs[i].length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += pngs[i].length;
});
fs.writeFileSync("electron/icon.ico", Buffer.concat([header, ...pngs]));
console.log("icon.png, icon.ico, icon-badge.svg written");
