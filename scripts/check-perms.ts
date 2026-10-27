// Dev helper: show each recent session's permission mode, and which of its bash commands the
// full-auto guard would still stop.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { looksDestructive } from "../src/agent.js";
const dir = path.join(os.homedir(), ".perch", "sessions");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, 6);
for (const f of files) {
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  const cmds: string[] = [];
  for (const m of s.history) for (const c of m.tool_calls ?? []) if (c.function.name === "bash") { try { cmds.push(JSON.parse(c.function.arguments).command); } catch {} }
  const stopped = cmds.filter(looksDestructive);
  console.log(`${s.id} | mode: ${s.permissionMode ?? "(unset)"} | ${s.title.slice(0, 40)} | bash: ${cmds.length}, guard would stop: ${stopped.length}`);
  for (const c of stopped.slice(0, 8)) console.log("    STOP:", c.replace(/\s+/g, " ").slice(0, 150));
}
