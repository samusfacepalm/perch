// inspect_image: exact facts about a PNG that eyes (and vision models) miss.

import { describe, diff, loadPng } from "../imageinfo.js";
import { relative, resolvePath, ToolError, type Tool } from "./types.js";

export const inspectImage: Tool = {
  name: "inspect_image",
  description: `Measure a PNG: size, number of colours and the main palette, semi-transparent pixels, and for sprite sheets the frame grid (empty frames, frames whose art doesn't line up). With compare_to, also how much it differs from another PNG of the same size and where.
Use it to check pixel art against the project's conventions and to compare a screenshot with an earlier one. To see what an image shows, look at it instead.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      frame_width: { type: "number", description: "Sprite sheet frame width; guessed if omitted" },
      frame_height: { type: "number" },
      compare_to: { type: "string", description: "Another PNG to compare with" },
    },
    required: ["path"],
  },
  summarize: (a) => a.path + (a.compare_to ? ` vs ${a.compare_to}` : ""),
  async run(a, ctx) {
    const file = resolvePath(ctx.cwd, a.path);
    if (!/\.png$/i.test(file)) throw new ToolError("inspect_image reads PNG files only.");
    let out: string;
    try {
      out = describe(file, a.frame_width ? { w: a.frame_width, h: a.frame_height ?? a.frame_width } : undefined);
      if (a.compare_to) {
        const other = resolvePath(ctx.cwd, a.compare_to);
        const d = diff(loadPng(file), loadPng(other));
        out += d.sameSize
          ? `\nCompared with ${relative(ctx.cwd, other)}: ${d.changedPercent}% of pixels differ${d.box ? `, within x ${d.box.x}–${d.box.x + d.box.w - 1}, y ${d.box.y}–${d.box.y + d.box.h - 1}` : ""}.`
          : `\nCompared with ${relative(ctx.cwd, other)}: different sizes, so no pixel comparison.`;
      }
    } catch (e: any) {
      throw new ToolError(`Couldn't read the image: ${e.message}`);
    }
    return { output: out, title: relative(ctx.cwd, file) };
  },
};
