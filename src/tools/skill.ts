// Skills are instruction packs (SKILL.md plus supporting files) shared with Claude Code and
// OpenCode. Only names and one-line descriptions sit in the tool description; the model loads a
// skill's full text when a task calls for it.

import fs from "node:fs";
import path from "node:path";
import { ToolError, type Tool } from "./types.js";
import type { Skill } from "../instructions.js";

export function makeSkillTool(skills: Skill[]): Tool {
  const list = skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
  return {
    name: "skill",
    description: `Load a skill: a set of instructions the user keeps for a particular kind of task. When a task matches a skill below, load it before starting and follow it.
Skills were written for Claude Code or OpenCode. Where one names a tool you don't have, use your nearest equivalent. Lines beginning with !\`...\` are shell commands whose output the skill expects; run them with bash if the result matters.

Available skills:
${list}`,
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The skill's name, exactly as listed" } },
      required: ["name"],
    },
    summarize: (a) => a.name,
    async run(a) {
      const skill = skills.find((s) => s.name === a.name) ?? skills.find((s) => s.name.toLowerCase() === String(a.name).toLowerCase());
      if (!skill) throw new ToolError(`No skill named "${a.name}". Available: ${skills.map((s) => s.name).join(", ")}`);
      const dir = path.dirname(skill.path);
      const text = fs.readFileSync(skill.path, "utf8").replace(/\$\{CLAUDE_SKILL_DIR\}/g, dir.split(path.sep).join("/"));
      const others = fs.readdirSync(dir).filter((f) => f !== "SKILL.md");
      const files = others.length ? `\n\nOther files in this skill's folder (${dir}): ${others.join(", ")}` : "";
      return { output: `<skill name="${skill.name}" folder="${dir}">\n${text}\n</skill>${files}`, title: skill.name };
    },
  };
}
