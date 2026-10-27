// Dev helper: streams a long reply into Ink on a fake 120x40 terminal, the way the TUI's live
// region does, and reports CPU time and bytes written. Run: npx tsx scripts/bench-tui.tsx
import React, { useEffect, useState } from "react";
import { render, Box, Text } from "ink";
import { EventEmitter } from "node:events";
import { tailLines } from "../src/ui/App.js";

const cols = 120;
const rows = 40;
const reply = Array.from({ length: 160 }, (_, i) => `Line ${i}: the parrot checks **every** claim against \`real metal\` before it signs off on it.`).join("\n");
const chunk = 15;

class FakeOut extends EventEmitter {
  columns = cols;
  rows = rows;
  isTTY = true;
  bytes = 0;
  writes = 0;
  write(s: string) {
    this.bytes += Buffer.byteLength(s);
    this.writes++;
    return true;
  }
}

function Live({ feed, capped, batched }: { feed: EventEmitter; capped: boolean; batched: boolean }) {
  const [text, setText] = useState("");
  useEffect(() => {
    let buf = "";
    let timer: NodeJS.Timeout | undefined;
    const flush = () => ((timer = undefined), setText((t) => t + buf), (buf = ""));
    const on = batched ? (d: string) => ((buf += d), (timer ??= setTimeout(flush, 33))) : (d: string) => setText((t) => t + d);
    feed.on("delta", on);
    return () => void feed.off("delta", on);
  }, []);
  const shown = capped ? tailLines(text, cols - 4, rows - 12) : text;
  return (
    <Box flexDirection="column">
      <Box marginLeft={2}>
        <Text>{shown}</Text>
      </Box>
      <Box borderStyle="round" paddingX={1} width={cols - 2} marginTop={1}>
        <Text>{"> typing here"}</Text>
      </Box>
    </Box>
  );
}

async function run(name: string, capped: boolean, incremental: boolean, batched = false) {
  const out = new FakeOut();
  const feed = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), { isTTY: false, setRawMode() {}, setEncoding() {}, ref() {}, unref() {}, read() { return null; } });
  const app = render(<Live feed={feed} capped={capped} batched={batched} />, { stdout: out as any, stdin: stdin as any, patchConsole: false, incrementalRendering: incremental });
  const cpu = process.cpuUsage();
  const t0 = performance.now();
  for (let i = 0; i < reply.length; i += chunk) {
    feed.emit("delta", reply.slice(i, i + chunk));
    await new Promise((r) => setTimeout(r, 4)); // a fast provider: one chunk every few ms
  }
  await new Promise((r) => setTimeout(r, 100));
  const used = process.cpuUsage(cpu);
  const wall = performance.now() - t0;
  app.unmount();
  console.log(`${name.padEnd(28)} cpu ${((used.user + used.system) / 1000).toFixed(0).padStart(5)} ms  wall ${wall.toFixed(0)} ms  written ${(out.bytes / 1024).toFixed(0).padStart(5)} KB in ${out.writes} writes`);
}

console.log(`reply ${reply.length} chars, ${Math.ceil(reply.length / chunk)} chunks`);
await run("full text (current)", false, false);
await run("last screenful only", true, false);
await run("last screenful + incremental", true, true);
await run("last screenful + batched", true, false, true);
await run("full text + batched", false, false, true);
