# Draws Perch's parrot. Edit the grid, run `python scripts/parrot.py`, and it writes the app
# icons plus electron/renderer/parrot.json, which the window uses for its in-app parrot.

import json
from PIL import Image

GRID = [
    "..........KK............",
    ".........KRYK...........",
    "........KRYYK...........",
    ".........KKKKKK.........",
    ".......KKHHHGGGKK.......",
    "......KHHGGGGGGGGK......",
    ".....KHGGGWWWGGGGKKK....",
    ".....KGGGWEEWGGGKYYYK...",
    ".....KGGGWEsWGGKYYYYYK..",
    ".....KGGGGWWGGGKYYYYyyK.",
    "....KGGRRRGGGGGGKyyyyyK.",
    "....KGRRRRGGGGGGGKKyyK..",
    "....KGGRRGGGGGGGGGKyK...",
    "....KGGGGDDDDDGGGGKK....",
    "...KGGGGDDBBBDDGGGK.....",
    "...KGGGDDBBCBBDDGGK.....",
    "...KHGGDDBBCCBBDDGK.....",
    "...KHGGGDDBBCBBDDGK.....",
    "....KHGGGDDBBBBDGK......",
    "....KHGGGGDDDBBDK.......",
    ".....KGGGGGGDDDK........",
    "..NNNNNNOONNOONNNNNNNNN.",
    "..nnnnnnnnTTTnnnnnnnnnn.",
    ".........TRRTK..........",
    "........KTRBRTK.........",
    ".........KRBRK..........",
    "..........KRK...........",
]

COLOURS = {
    "K": "#163a22",  # outline
    "H": "#8fe39c",  # highlight
    "G": "#3fb950",  # body green
    "D": "#24813a",  # dark green
    "W": "#ffffff",  # eye ring
    "E": "#101010",  # pupil
    "s": "#ffffff",  # eye sparkle
    "Y": "#f5c542",  # beak
    "y": "#c48a1c",  # beak shade
    "R": "#e5534b",  # red
    "T": "#b8322b",  # tail shade
    "B": "#3b82f6",  # blue wing feathers
    "C": "#93c5fd",  # pale blue
    "O": "#f08a3c",  # feet
    "N": "#8a5a36",  # branch
    "n": "#5e3c22",  # branch shade
}


def hex2rgb(h):
    return tuple(int(h[i : i + 2], 16) for i in (1, 3, 5))


if __name__ == "__main__":
    w = max(len(r) for r in GRID)
    h = len(GRID)
    size = max(w, h)
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ox, oy = (size - w) // 2, (size - h) // 2
    for y, row in enumerate(GRID):
        for x, c in enumerate(row):
            if c != ".":
                img.putpixel((x + ox, y + oy), hex2rgb(COLOURS[c]) + (255,))
    big = img.resize((256, 256), Image.NEAREST)
    big.save("electron/icon.png")
    big.save("electron/icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    json.dump({"grid": GRID, "colours": COLOURS}, open("electron/renderer/parrot.json", "w"), indent=1)
    print(f"{w}x{h} parrot written")
