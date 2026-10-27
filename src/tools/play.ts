// The play tool: run the game, look at it, read its log. This is how the agent checks that a
// change to a game actually works, instead of assuming it does. It also opens any web page the
// agent built, so a three.js scene or a web game gets looked at before it's called done.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareGolden, detectPlay, formatResult, runNative, type PlayOptions, type PlayPlan, type PlayResult } from "../play.js";
import { runWebHeadless } from "../webplay.js";
import { frameWarnings } from "../imageinfo.js";
import { ToolError, type Tool } from "./types.js";

const PAGE_SHOTS_SHOWN = 2;
const PAGE_ROUNDS = 8;
const PAGE_ROUNDS_MAX = 12;

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
- seconds: how long to run, default 8 (6 for a page), max 120.
- shots: seconds at which to take screenshots, e.g. [1, 4, 8]. Default: three spread over the run; for a page, one at the end. You are shown at most two shots of a page, the last ones.
- A page gets about eight looks per request from the user. After that, finish: the tool will stop opening pages after twelve.
- keys: key presses, e.g. [{"at": 2, "key": "Space"}, {"at": 3, "key": "ArrowRight"}, {"at": 4, "key": "Enter"}]. Names: letters, digits, Space, Enter, Escape, Tab, arrows, Shift, F1-F12.
- script (web only): JavaScript run in the page before each screenshot; its value goes in the log. Use it to inspect without editing files: move the camera for a close-up or another angle, pause an animation, or read state (object counts, positions, settings). It can reach only what the page puts on window, so expose handles there in code you write (e.g. window.camera, window.controls, window.scene).
- zoom (web only): {x, y, width, height} in page pixels of a 1280x720 view; the shots show just that region at twice the resolution. For checking detail.${found ? "" : "\nNo game was detected in this folder, so pass page."}${plan.note && found ? `\nNote: ${plan.note}` : ""}`,
    parameters: {
      type: "object",
      properties: {
        page: { type: "string" },
        seconds: { type: "number" },
        shots: { type: "array", items: { type: "number" } },
        keys: { type: "array", items: { type: "object", properties: { at: { type: "number" }, key: { type: "string" } }, required: ["at", "key"] } },
        script: { type: "string" },
        zoom: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } }, required: ["x", "y", "width", "height"] },
      },
    },
    summarize: (a) => `${a.page ?? plan.label}${a.seconds ? `, ${a.seconds}s` : ""}`,
    async run(a, ctx) {
      // The look-judge-fix loop on a page has a budget per request, enforced here because
      // models follow tool results more reliably than prompt instructions.
      const round = ctx.turnCalls?.get("play") ?? 1;
      if (a.page && round > PAGE_ROUNDS_MAX) {
        throw new ToolError(`That would be look number ${round} since the user last wrote; the limit is ${PAGE_ROUNDS_MAX}. Stop polishing: finish the task and tell the user what you would still improve.`);
      }
      // The project may have changed since the session started.
      const current = a.page ? pagePlan(a.page, ctx.cwd) : detectPlay(ctx.cwd);
      if (current.kind === "none" || current.kind === "unity") throw new ToolError((current.note ?? "Nothing to run.") + (a.page ? "" : " To open a web page, pass page."));
      // A page check needs one look at the settled result; more shots mostly cost tokens.
      const seconds = a.seconds ?? (a.page ? 6 : undefined);
      const shots = a.shots ?? (a.page ? [Math.max(0.5, (seconds ?? 6) - 0.5)] : undefined);
      const r = await runner(current, ctx.cwd, { seconds, shots, keys: a.keys, script: a.script, zoom: a.zoom }, ctx.signal);
      r.golden = await compareGolden(ctx.cwd, r.screenshots);
      r.warnings = r.screenshots.flatMap((s) => {
        try {
          return frameWarnings(s).map((w) => `${path.basename(s)}: ${w}`);
        } catch {
          return [];
        }
      });
      const shown = a.page ? r.screenshots.slice(-PAGE_SHOTS_SHOWN) : r.screenshots;
      let output = formatResult(r);
      if (shown.length < r.screenshots.length) output += `

Shown to you: the last ${shown.length} shots. The others are on disk.`;
      if (a.page && round >= PAGE_ROUNDS) output += `

This was look ${round} since the user last wrote (budget ${PAGE_ROUNDS}, hard limit ${PAGE_ROUNDS_MAX}). Finish now unless something is badly wrong, and say what you would still improve.`;
      return { output, title: `${r.screenshots.length} shots, ${r.errors.length} errors`, images: shown, play: r };
    },
  };
}
