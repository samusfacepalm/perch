// Perch's mascots: one bird drawing, coloured per species, with a parrot or cockatoo crest and
// beak. Built as SVG strings at start-up and used as data URLs, so switching costs nothing.

type Pair = [string, string];
type Trio = [string, string, string];

interface Bird {
  id: string;
  name: string;
  kind: "parrot" | "cockatoo";
  body: Trio; // light, mid, dark
  head?: Trio; // defaults to body
  belly: Pair;
  wing: Pair;
  tip: Pair; // wing tips and tail stripe
  tail: Pair;
  beak: Trio;
  lowerBeak: string;
  crest: Trio | null; // null: no crest
  cheek?: string; // cheek or face patch
  eyeRing: string;
  highlight: string; // head shine
  wingLines: string;
}

export const BIRDS: Bird[] = [
  {
    id: "green", name: "Green parrot", kind: "parrot",
    body: ["#6fdc7c", "#34b24a", "#1f7f35"], belly: ["#9be89a", "#4cc25a"], wing: ["#2a9a40", "#176b2b"], tip: ["#5aa2ff", "#2459d6"],
    tail: ["#f0645a", "#b8322b"], beak: ["#ffe17a", "#f5b335", "#d98a1a"], lowerBeak: "#5a5c66", crest: ["#e5534b", "#f5c542", "#e5534b"],
    cheek: "#ff6b5e", eyeRing: "#fff6d8", highlight: "#b6f0b8", wingLines: "#13602a",
  },
  {
    id: "scarlet", name: "Scarlet macaw", kind: "parrot",
    body: ["#ff8a73", "#e0322b", "#9e1f1a"], belly: ["#ff9a85", "#e8473b"], wing: ["#f5c542", "#3a9c4a"], tip: ["#4f8dff", "#1f4fc4"],
    tail: ["#ef4a3c", "#a11d16"], beak: ["#f6efe3", "#ddd1bc", "#a39784"], lowerBeak: "#2b2b30", crest: ["#ff7a4f", "#e0322b", "#ff9a3c"],
    cheek: "#fff1ea", eyeRing: "#fffaf0", highlight: "#ffc2b5", wingLines: "#2e7a3a",
  },
  {
    id: "bluegold", name: "Blue-and-gold macaw", kind: "parrot",
    body: ["#6bb0ff", "#2a73d9", "#1b4f9e"], belly: ["#ffe27a", "#f2a81d"], wing: ["#2f7fe6", "#1a4fa6"], tip: ["#2fbf8f", "#14806a"],
    tail: ["#3b84e8", "#1a4b9a"], beak: ["#4a4c55", "#2c2d33", "#141518"], lowerBeak: "#141518", crest: ["#3fb950", "#2a9a40", "#3fb950"],
    cheek: "#f7f7f7", eyeRing: "#ffffff", highlight: "#b8d8ff", wingLines: "#123c7a",
  },
  {
    id: "lorikeet", name: "Rainbow lorikeet", kind: "parrot",
    head: ["#6d7bff", "#3346d1", "#1f2b8f"], body: ["#7fe07a", "#39b54a", "#1f7f35"], belly: ["#ffb23c", "#e5432b"], wing: ["#3aae4a", "#1f7a2f"],
    tip: ["#d9ef4a", "#8fbf1f"], tail: ["#4cc25a", "#2a8a3a"], beak: ["#ff8a6a", "#e5432b", "#a8281a"], lowerBeak: "#a8281a", crest: null,
    eyeRing: "#ffe7d6", highlight: "#b9c2ff", wingLines: "#14602a",
  },
  {
    id: "budgie", name: "Budgie", kind: "parrot",
    head: ["#fff59a", "#f5d742", "#c9a817"], body: ["#9ae0ff", "#3fa9f5", "#1f6fb8"], belly: ["#b6ecff", "#58bdf5"], wing: ["#2f8fd9", "#16508f"],
    tip: ["#2a2f3a", "#151820"], tail: ["#2b5fbf", "#173a80"], beak: ["#f2c88c", "#d9a35a", "#9a6a2a"], lowerBeak: "#6a5a4a", crest: null,
    cheek: "#5b5bd6", eyeRing: "#fffbe0", highlight: "#fffbd0", wingLines: "#0f3a6a",
  },
  {
    id: "sulphur", name: "Sulphur-crested cockatoo", kind: "cockatoo",
    body: ["#ffffff", "#eef1f5", "#c3c9d2"], belly: ["#ffffff", "#e9edf2"], wing: ["#f4f6f9", "#cdd3db"], tip: ["#fff3b0", "#f0d35e"],
    tail: ["#f6f8fb", "#cfd5de"], beak: ["#55575f", "#33353b", "#18191c"], lowerBeak: "#18191c", crest: ["#ffe45c", "#f5c542", "#e0a920"],
    cheek: "#fff4c2", eyeRing: "#dcecff", highlight: "#ffffff", wingLines: "#a9b1bc",
  },
  {
    id: "galah", name: "Galah", kind: "cockatoo",
    head: ["#ffc2d4", "#f2709a", "#c94a73"], body: ["#dfe4ea", "#a9b2bc", "#7d8792"], belly: ["#ff9fbb", "#e0567f"], wing: ["#b8c0c9", "#7f8995"],
    tip: ["#8f99a5", "#5f6873"], tail: ["#9aa3ae", "#66707b"], beak: ["#f3ede3", "#d8cfc0", "#a99f8f"], lowerBeak: "#a99f8f", crest: ["#fff0f5", "#ffd0de", "#ffb6cb"],
    eyeRing: "#ff8a8a", highlight: "#ffe0ea", wingLines: "#6e7884",
  },
  {
    id: "ganggang", name: "Gang-gang cockatoo", kind: "cockatoo",
    head: ["#ff7a6b", "#d93a2e", "#9e2219"], body: ["#a7b0ba", "#6b7480", "#454c55"], belly: ["#b4bcc6", "#7a838e"], wing: ["#7a838f", "#4a525c"],
    tip: ["#5a626c", "#353b43"], tail: ["#68717c", "#3f464f"], beak: ["#efe7da", "#d2c6b2", "#9c907c"], lowerBeak: "#9c907c", crest: ["#ff5a4a", "#d93a2e", "#ff7a6b"],
    eyeRing: "#c9cfd6", highlight: "#ffb3a8", wingLines: "#3a4048",
  },
  {
    id: "mitchell", name: "Major Mitchell's cockatoo", kind: "cockatoo",
    body: ["#fff0f3", "#f7c2cf", "#d98ea3"], belly: ["#ffd9e2", "#f2a3b6"], wing: ["#ffffff", "#e6dfe2"], tip: ["#ffd6df", "#f0a0b4"],
    tail: ["#ffffff", "#e8e0e3"], beak: ["#f3ede3", "#d8cfc0", "#a99f8f"], lowerBeak: "#a99f8f", crest: ["#e5534b", "#f5c542", "#e5534b"],
    eyeRing: "#ffffff", highlight: "#ffffff", wingLines: "#cbbfc4",
  },
];

function crest(b: Bird): string {
  if (!b.crest) return "";
  const [c1, c2, c3] = b.crest;
  if (b.kind === "parrot") {
    return `<path d="M120 46 C 108 26 116 10 126 14 C 130 24 130 36 128 44 Z" fill="${c1}"/>
<path d="M130 42 C 128 20 140 8 148 14 C 148 26 142 36 136 42 Z" fill="${c2}"/>
<path d="M140 44 C 146 28 160 24 164 32 C 158 38 150 42 144 46 Z" fill="${c3}"/>`;
  }
  // A cockatoo's tall crest, swept back from the forehead.
  return `<path d="M128 48 C 116 32 100 22 80 20 C 94 32 106 42 118 52 Z" fill="${c3}"/>
<path d="M136 44 C 126 26 110 12 92 8 C 104 22 116 34 126 48 Z" fill="${c2}"/>
<path d="M144 42 C 138 22 126 8 110 2 C 120 16 130 30 136 46 Z" fill="${c1}"/>
<path d="M152 42 C 152 26 146 12 136 4 C 140 18 144 30 146 44 Z" fill="${c2}"/>`;
}

function beak(b: Bird): string {
  const shine = b.kind === "cockatoo" ? "#9a9ca6" : "#fff3c0";
  if (b.kind === "cockatoo") {
    // Shorter and more rounded than a macaw's.
    return `<path d="M163 96 C 172 95 179 102 181 111 C 174 111 168 107 162 103 Z" fill="${b.lowerBeak}"/>
<path d="M160 68 C 180 60 198 76 196 98 C 195 109 189 116 181 116 C 183 106 179 98 171 96 C 164 94 160 86 160 68 Z" fill="url(#beak)"/>
<path d="M170 70 C 182 70 190 80 191 92" stroke="${shine}" stroke-width="2.5" stroke-linecap="round" fill="none" opacity="0.55"/>`;
  }
  return `<path d="M163 96 C 175 95 184 104 187 116 C 179 116 170 110 162 103 Z" fill="${b.lowerBeak}"/>
<path d="M160 64 C 186 52 212 72 209 104 C 208 118 200 128 190 128 C 193 116 190 104 180 99 C 168 96 160 86 160 64 Z" fill="url(#beak)"/>
<path d="M172 66 C 188 66 199 78 201 96" stroke="${shine}" stroke-width="3" stroke-linecap="round" fill="none" opacity="0.7"/>`;
}

export function birdSvg(b: Bird): string {
  const head = b.head ?? b.body;
  const grad = (id: string, stops: string[], x2 = "0", y2 = "1") =>
    `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map((c, i) => `<stop offset="${stops.length === 3 ? [0, 0.55, 1][i] : i}" stop-color="${c}"/>`).join("")}</linearGradient>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><defs>
${grad("body", b.body, "0.4")}${grad("head", head, "0.4")}${grad("belly", b.belly)}${grad("wing", b.wing)}${grad("tip", b.tip)}${grad("tail", b.tail)}${grad("beak", b.beak, "1", "1")}
<linearGradient id="branch" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#a87346"/><stop offset="1" stop-color="#6b4426"/></linearGradient></defs>
<path d="M100 196 C 96 220 92 236 86 252 L 104 252 C 110 236 116 220 122 198 Z" fill="url(#tail)"/>
<path d="M104 252 C 110 236 116 220 122 198 L 114 198 C 108 220 102 236 96 252 Z" fill="url(#tip)" opacity="0.9"/>
<path d="M14 204 C 80 198 170 200 242 208 C 246 212 244 220 238 220 C 170 214 80 212 18 218 C 10 218 8 206 14 204 Z" fill="url(#branch)"/>
<path d="M206 206 C 216 190 232 186 244 190 C 236 202 222 208 206 206 Z" fill="#3fa24f"/>
<path d="M208 206 C 220 198 232 194 244 190" stroke="#2a7a37" stroke-width="2" fill="none"/>
<path d="M152 106 C 176 132 172 186 136 206 C 110 218 84 204 84 172 C 84 136 108 104 152 106 Z" fill="url(#body)"/>
<path d="M146 124 C 164 146 160 186 134 200 C 120 206 110 196 114 176 C 118 150 128 128 146 124 Z" fill="url(#belly)" opacity="0.85"/>
<path d="M116 112 C 84 124 74 168 84 212 C 90 222 104 214 112 198 C 126 166 132 132 116 112 Z" fill="url(#wing)"/>
<path d="M84 212 C 80 192 84 174 92 162 C 98 178 104 190 112 198 C 104 214 90 222 84 212 Z" fill="url(#tip)"/>
<path d="M100 138 C 108 146 112 156 112 168 M92 150 C 100 160 104 170 104 182" stroke="${b.wingLines}" stroke-width="2.2" fill="none" stroke-linecap="round" opacity="0.7"/>
<g fill="#9a9ea6" stroke="#5c6068" stroke-width="1.6" stroke-linejoin="round">
<path d="M110 198 C 105 204 104 211 108 214 C 112 215 114 211 116 207 C 118 211 120 215 125 214 C 128 209 125 202 120 197 Z"/>
<path d="M131 196 C 126 202 126 210 129 213 C 133 214 135 210 137 206 C 139 210 142 214 146 212 C 148 207 145 200 140 195 Z"/></g>
${crest(b)}
<circle cx="138" cy="82" r="44" fill="url(#head)"/>
<path d="M104 62 C 112 44 132 36 150 42" stroke="${b.highlight}" stroke-width="5" stroke-linecap="round" fill="none" opacity="0.6"/>
${b.cheek ? `<ellipse cx="147" cy="101" rx="11" ry="7.5" fill="${b.cheek}"/>` : ""}
${beak(b)}
<circle cx="148" cy="74" r="13" fill="${b.eyeRing}"/>
<circle cx="150" cy="74" r="8" fill="#16181c"/>
<circle cx="153" cy="70" r="3" fill="#ffffff"/>
<circle cx="147" cy="78" r="1.4" fill="#ffffff" opacity="0.8"/>
</svg>`;
}

export const birdUrl = (b: Bird) => "data:image/svg+xml;utf8," + encodeURIComponent(birdSvg(b));
export const BIRD_URLS: Record<string, string> = Object.fromEntries(BIRDS.map((b) => [b.id, birdUrl(b)]));

// The chosen mascot, remembered in this window's storage. Components subscribe so a change
// shows everywhere at once (sidebar, home screen, the dancing parrot).
const listeners = new Set<(id: string) => void>();
let current = (() => {
  try {
    const saved = localStorage.getItem("perch.mascot");
    return saved && BIRD_URLS[saved] ? saved : "green";
  } catch {
    return "green";
  }
})();

export const mascot = {
  get: () => current,
  set(id: string) {
    if (!BIRD_URLS[id]) return;
    current = id;
    try {
      localStorage.setItem("perch.mascot", id);
    } catch {}
    for (const fn of listeners) fn(id);
  },
  subscribe(fn: (id: string) => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};
