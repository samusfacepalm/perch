// The play tool: run the game, look at it, read its log. This is how the agent checks that a
// change to a game actually works, instead of assuming it does.

import { compareGolden, detectPlay, formatResult, runNative, type PlayOptions, type PlayPlan, type PlayResult } from "../play.js";
import { ToolError, type Tool } from "./types.js";

export type PlayRunner = (plan: PlayPlan, cwd: string, opts: PlayOptions, signal?: AbortSignal) => Promise<PlayResult>;

// Outside the desktop app only native games can run; web games need its play window.
export const nativeRunner: PlayRunner = async (plan, cwd, opts, signal) => {
  if (plan.kind === "web" || plan.kind === "devserver") throw new ToolError("Web games run in the Perch desktop app's play window. Open this project in the app to play it.");
  return runNative(plan, cwd, opts, signal);
};

export function makePlayTool(cwd: string, runner: PlayRunner = nativeRunner): Tool | undefined {
  const plan = detectPlay(cwd);
  if (plan.kind === "none" && !plan.engine) return undefined;
  return {
    name: "play",
    description: `Run this project's game (${plan.label}), take screenshots while it runs, and return its log and any error lines. If you can see images, the screenshots are shown to you.
Use it after changing the game, to check the change works and nothing broke: look at the screenshots and read the errors, then fix what's wrong and play again.
- seconds: how long to run, default 8, max 120.
- shots: seconds at which to take screenshots, e.g. [1, 4, 8]. Default: three spread over the run.
- keys: key presses, e.g. [{"at": 2, "key": "Space"}, {"at": 3, "key": "ArrowRight"}, {"at": 4, "key": "Enter"}]. Names: letters, digits, Space, Enter, Escape, Tab, arrows, Shift, F1-F12.${plan.note ? `\nNote: ${plan.note}` : ""}`,
    parameters: {
      type: "object",
      properties: {
        seconds: { type: "number" },
        shots: { type: "array", items: { type: "number" } },
        keys: { type: "array", items: { type: "object", properties: { at: { type: "number" }, key: { type: "string" } }, required: ["at", "key"] } },
      },
    },
    summarize: (a) => `${plan.label}${a.seconds ? `, ${a.seconds}s` : ""}`,
    async run(a, ctx) {
      const current = detectPlay(ctx.cwd); // the project may have changed since the session started
      if (current.kind === "none" || current.kind === "unity") throw new ToolError(current.note ?? "Nothing to run.");
      const r = await runner(current, ctx.cwd, { seconds: a.seconds, shots: a.shots, keys: a.keys }, ctx.signal);
      r.golden = await compareGolden(ctx.cwd, r.screenshots);
      return { output: formatResult(r), title: `${r.screenshots.length} shots, ${r.errors.length} errors`, images: r.screenshots, play: r };
    },
  };
}
