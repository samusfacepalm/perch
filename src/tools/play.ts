// The play tool: run the game, look at it, read its log. This is how the agent checks that a
// change to a game actually works, instead of assuming it does. It also opens any web page the
// agent built, so a three.js scene or a web game gets looked at before it's called done.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareGolden, detectPlay, formatResult, runNative, type PlayOptions, type PlayPlan, type PlayResult } from "../play.js";
import { runWebHeadless } from "../webplay.js";
import { ToolError, type Tool } from "./types.js";

export type PlayRunner = (plan: PlayPlan, cwd: string, opts: PlayOptions, signal?: AbortSignal) => Promise<PlayResult>;

// Outside the desktop app, web games and pages run in a headless browser.
export const nativeRunner: PlayRunner = async (plan, cwd, opts, signal) => {
  if (plan.kind === "web" || plan.kind === "devserver") return runWebHeadless(plan, cwd, opts, signal);
  return runNative(plan, cwd, opts, signal);
};

// A page the agent names: an HTML file (served from the project folder, so its relative links
// work) or a URL.
function pagePlan(page: string, cwd: string): PlayPlan {
  if (/^https?:\/\//i.test(page)) return { kind: "web", label: page, url: page };
  const file = /^file:\/\//i.test(page) ? fileURLToPath(page) : path.resolve(cwd, page);
  if (!fs.existsSync(file)) throw new ToolError(`No such page: ${file}`);
  const inside = !path.relative(cwd, file).startsWith("..");
  const root = inside ? cwd : path.dirname(file);
  return { kind: "web", label: `Page ${path.relative(cwd, file) || path.basename(file)}`, root, url: path.relative(root, file) };
}

export function makePlayTool(cwd: string, runner: PlayRunner = nativeRunner): Tool {
  const plan = detectPlay(cwd);
  const found = plan.kind !== "none" || plan.engine;
  return {
    name: "play",
    description: `Run this project's game${found ? ` (${plan.label})` : ""}, or open a web page you built, take screenshots while it runs, and return its log and any error lines. If you can see images, the screenshots are shown to you.
Use it after changing a game or building anything visual for the web (a page, a canvas or three.js scene, a web game), to see what it actually looks like and catch errors: look at the screenshots, fix what's wrong, and play again.
- page: an HTML file in the project (e.g. "index.html") or a URL to open instead of the detected game. Relative links in the page work.
- seconds: how long to run, default 8, max 120.
- shots: seconds at which to take screenshots, e.g. [1, 4, 8]. Default: three spread over the run.
- keys: key presses, e.g. [{"at": 2, "key": "Space"}, {"at": 3, "key": "ArrowRight"}, {"at": 4, "key": "Enter"}]. Names: letters, digits, Space, Enter, Escape, Tab, arrows, Shift, F1-F12.${found ? "" : "\nNo game was detected in this folder, so pass page."}${plan.note && found ? `\nNote: ${plan.note}` : ""}`,
    parameters: {
      type: "object",
      properties: {
        page: { type: "string" },
        seconds: { type: "number" },
        shots: { type: "array", items: { type: "number" } },
        keys: { type: "array", items: { type: "object", properties: { at: { type: "number" }, key: { type: "string" } }, required: ["at", "key"] } },
      },
    },
    summarize: (a) => `${a.page ?? plan.label}${a.seconds ? `, ${a.seconds}s` : ""}`,
    async run(a, ctx) {
      // The project may have changed since the session started.
      const current = a.page ? pagePlan(a.page, ctx.cwd) : detectPlay(ctx.cwd);
      if (current.kind === "none" || current.kind === "unity") throw new ToolError((current.note ?? "Nothing to run.") + (a.page ? "" : " To open a web page, pass page."));
      const r = await runner(current, ctx.cwd, { seconds: a.seconds, shots: a.shots, keys: a.keys }, ctx.signal);
      r.golden = await compareGolden(ctx.cwd, r.screenshots);
      return { output: formatResult(r), title: `${r.screenshots.length} shots, ${r.errors.length} errors`, images: r.screenshots, play: r };
    },
  };
}
