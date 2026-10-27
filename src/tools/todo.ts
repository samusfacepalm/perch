// The todo list is the model's plan for a long task. It lives in the session, is shown in the
// UI, and survives compaction, so the plan outlasts any summary of the conversation.

import { ToolError, type Tool } from "./types.js";
import type { Todo } from "../session.js";

const STATUSES = ["pending", "in_progress", "completed", "cancelled"];

export function formatTodos(todos: Todo[]): string {
  if (!todos.length) return "(no todos)";
  const mark = { pending: "[ ]", in_progress: "[>]", completed: "[x]", cancelled: "[-]" } as const;
  return todos.map((t, i) => `${mark[t.status]} ${i + 1}. ${t.content}`).join("\n");
}

export const todowrite: Tool = {
  name: "todowrite",
  description: `Create or replace your task list. Use it for any task with three or more steps, and for every long task.
- Send the whole list each time; it replaces the old one.
- Keep exactly one item in_progress while you work. Mark an item completed as soon as it is done, not in batches at the end.
- Add items when you discover new work. Cancel items that turn out to be unnecessary.
- Mark an item completed only when it is fully done: tests pass, nothing half-finished. If you are blocked, keep it in_progress and add an item describing the blocker.
- The list is kept when the conversation is summarised, so it is how you keep your place in long work.
- Skip it for a single, trivial step.`,
  parameters: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Short imperative description of the step" },
            status: { type: "string", enum: STATUSES },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  summarize: (a) => `${a.todos?.length ?? 0} items`,
  async run(a, ctx) {
    if (!Array.isArray(a.todos)) throw new ToolError("todos must be an array.");
    for (const t of a.todos) {
      if (typeof t?.content !== "string" || !STATUSES.includes(t?.status)) {
        throw new ToolError(`Each todo needs content (string) and status (${STATUSES.join(" | ")}).`);
      }
    }
    ctx.session.todos = a.todos.map((t: Todo) => ({ content: t.content, status: t.status }));
    const open = ctx.session.todos.filter((t) => t.status === "pending" || t.status === "in_progress").length;
    return { output: formatTodos(ctx.session.todos) + `\n\n${open} open.`, title: `${open} open` };
  },
};
