// Hooks: your own commands that run at fixed points, in Claude Code's format, so a hook script
// written for Claude Code works here unchanged. They live under "hooks" in ~/.perch/config.json:
//
//   "hooks": {
//     "PreToolUse":  [{ "matcher": "Bash|Edit", "hooks": [{ "type": "command", "command": "node check.js" }] }],
//     "PostToolUse": [...], "UserPromptSubmit": [...], "Stop": [...]
//   }
//
// Each command gets the event as JSON on stdin (session_id, cwd, hook_event_name, and tool_name,
// tool_input, tool_response or prompt). Exit code 2 blocks: the call is refused, the prompt is
// dropped, or the agent is told to keep working, with stderr as the reason. Exit 0 lets things
// go ahead; for PreToolUse, JSON on stdout may say {"hookSpecificOutput": {"permissionDecision":
// "allow" | "deny" | "ask", "permissionDecisionReason": "..."}}, and for UserPromptSubmit plain
// stdout is added to the conversation as context. Matchers are regular expressions tested
// against Perch's tool name and Claude Code's name for it (bash and Bash, edit and Edit).
//
// Claude Code's own hooks are not run: they are written for its session (the caveman plugin's
// hooks, for one, would change how Perch talks).

import { spawn } from "node:child_process";
import { SHELL } from "./tools/bash.js";

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";
interface HookCommand {
  type: "command";
  command: string;
  timeout?: number; // seconds
}
export type HookConfig = Partial<Record<HookEvent, { matcher?: string; hooks: HookCommand[] }[]>>;

export interface HookOutcome {
  block?: string; // why the action is blocked (exit code 2, or a deny decision)
  decision?: "allow" | "deny" | "ask";
  context: string[]; // stdout to add to the conversation (UserPromptSubmit)
}

const CLAUDE_NAMES: Record<string, string> = {
  bash: "Bash", read: "Read", edit: "Edit", write: "Write", glob: "Glob", grep: "Grep", list: "LS",
  web_fetch: "WebFetch", web_search: "WebSearch", task: "Task", todowrite: "TodoWrite",
};

function matches(matcher: string | undefined, tool?: string, args?: any): boolean {
  if (!matcher || matcher === "*" || tool === undefined) return true;
  const names = [tool, CLAUDE_NAMES[tool] ?? tool];
  if (tool === "mcp_call") names.push(`mcp__${args?.server}__${args?.tool}`);
  try {
    const re = new RegExp(`^(?:${matcher})$`);
    return names.some((n) => re.test(n));
  } catch {
    return names.includes(matcher);
  }
}

function runOne(h: HookCommand, input: object, cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(SHELL.cmd, SHELL.args(h.command), { cwd, windowsHide: true, env: { ...process.env, PERCH_PROJECT_DIR: cwd, CLAUDE_PROJECT_DIR: cwd } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr: stderr + `\n[hook timed out after ${h.timeout ?? 60}s]` });
    }, (h.timeout ?? 60) * 1000);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `[hook failed to start: ${e.message}]` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

export async function runHooks(config: HookConfig | undefined, event: HookEvent, base: { session_id: string; cwd: string }, extra: Record<string, unknown> = {}): Promise<HookOutcome> {
  const outcome: HookOutcome = { context: [] };
  const groups = (config?.[event] ?? []).filter((g) => matches(g.matcher, extra.tool_name as string | undefined, extra.tool_input));
  for (const g of groups) {
    for (const h of g.hooks ?? []) {
      if (h.type !== "command" || !h.command) continue;
      const r = await runOne(h, { ...base, hook_event_name: event, ...extra }, base.cwd);
      if (r.code === 2) {
        outcome.block = r.stderr || `Blocked by the hook: ${h.command}`;
        return outcome;
      }
      if (r.code !== 0) continue; // a failing hook is reported in its own output, not fatal
      let json: any;
      try {
        json = r.stdout.startsWith("{") ? JSON.parse(r.stdout) : undefined;
      } catch {}
      const out = json?.hookSpecificOutput;
      if (out?.permissionDecision) {
        outcome.decision = out.permissionDecision;
        if (out.permissionDecision === "deny") {
          outcome.block = out.permissionDecisionReason || `Denied by the hook: ${h.command}`;
          return outcome;
        }
      }
      if (json?.decision === "block") {
        outcome.block = json.reason || `Blocked by the hook: ${h.command}`;
        return outcome;
      }
      const context = out?.additionalContext ?? (json ? undefined : r.stdout);
      if (context) outcome.context.push(context);
    }
  }
  return outcome;
}
