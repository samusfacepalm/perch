// The mascot: a small parrot drawn in block characters, facing right.

import React from "react";
import { Box, Text } from "ink";

const G = "green";
const Y = "yellow";
const R = "red";

// Each row is a list of [text, colour] pieces.
const ROWS: [string, string?][][] = [
  [["  ", undefined], ["▄███▄", G]],
  [[" ▐█", G], ["◕", "whiteBright"], ["█", G], ["▶", Y]],
  [["  ▐", G], ["███", G], ["▌", "greenBright"]],
  [["   ", undefined], ["▀", G], ["█", R], ["▀", G]],
  [["   ", undefined], ["▐", R], ["▌", R]],
];

export function Parrot() {
  return (
    <Box flexDirection="column" marginRight={2}>
      {ROWS.map((row, i) => (
        <Text key={i}>
          {row.map(([t, c], j) => (
            <Text key={j} color={c}>
              {t}
            </Text>
          ))}
        </Text>
      ))}
    </Box>
  );
}

// One-line parrot for the working indicator. It blinks now and then and bobs its beak.
export function MiniParrot({ tick }: { tick: number }) {
  const blink = tick % 7 === 6;
  const beak = tick % 2 === 0 ? "▶" : "▷";
  return (
    <Text>
      <Text color={G}>▐</Text>
      <Text color="whiteBright">{blink ? "─" : "◕"}</Text>
      <Text color={Y}>{beak}</Text>
    </Text>
  );
}
