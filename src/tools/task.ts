// Hands a self-contained piece of work to a subagent with a fresh context.
// The subagent's tool output never enters the main conversation; only its report does,
// which keeps the main context small during long tasks.

import { ToolError, type Tool } from "./types.js";
import type { AgentDef } from "../instructions.js";

export function makeTaskTool(agents: AgentDef[] = []): Tool {
  const named = agents.length
    ? `\n\nSpecialist agents (pass the name as "agent"; leave it out for a general agent):\n${agents.map((a) => `- ${a.name}: ${a.description.replace(/\s+/g, " ").slice(0, 200)}`).join("\n")}`
    : "";
  return {
    name: "task",
    description: `Start a subagent with a fresh context to do a self-contained piece of work, and get back its final report.
Good uses:
- Searching a large codebase to answer a question ("where is X handled, and how?") when it would take many reads.
- A well-specified change to a separate part of the code.
- Reviewing work you just did with fresh eyes.
The subagent sees none of this conversation. Write the prompt as a full brief: the goal, the files or area, what you already know, and exactly what its report should contain.
It has the same tools as you except task. Run independent subagents in the same turn to work in parallel. Once you have delegated something, don't do the same work yourself.${named}`,
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Three to five words naming the task" },
        prompt: { type: "string", description: "The full brief for the subagent" },
        ...(agents.length ? { agent: { type: "string", enum: agents.map((a) => a.name), description: "Optional specialist agent" } } : {}),
      },
      required: ["description", "prompt"],
    },
    summarize: (a) => (a.agent ? `${a.agent}: ` : "") + (a.description ?? ""),
    async run(a, ctx) {
      if (!ctx.runSubagent) throw new ToolError("Subagents cannot start further subagents.");
      if (typeof a.prompt !== "string" || !a.prompt.trim()) throw new ToolError("prompt is required.");
      const def = a.agent ? agents.find((x) => x.name === a.agent) : undefined;
      if (a.agent && !def) throw new ToolError(`No agent named "${a.agent}".`);
      const report = await ctx.runSubagent(a.description ?? "subagent", a.prompt, def);
      return { output: report, title: a.description };
    },
  };
}
