// Runs shell commands. On Windows it uses Git Bash when installed, because models write
// POSIX shell far more reliably than PowerShell; otherwise PowerShell.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { ToolError, truncateMiddle, type Tool } from "./types.js";

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;
const MAX_OUTPUT = 2_000_000; // beyond this the middle is dropped; the agent spills long output to a file

function findShell(): { cmd: string; args: (c: string) => string[]; name: string } {
  if (process.platform !== "win32") return { cmd: "/bin/bash", args: (c) => ["-lc", c], name: "bash" };
  for (const p of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]) {
    if (fs.existsSync(p)) return { cmd: p, args: (c) => ["-c", c], name: "Git Bash" };
  }
  return { cmd: "powershell.exe", args: (c) => ["-NoProfile", "-NonInteractive", "-Command", c], name: "PowerShell" };
}

export const SHELL = findShell();

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
}

export const bash: Tool = {
  name: "bash",
  description: `Run a shell command (${SHELL.name}) in the working directory and return its output.
- Each call starts a fresh shell in the working directory; cd does not carry over between calls. Chain with && when needed.
- Default timeout 2 minutes, maximum 10 minutes (timeout is in milliseconds).
- Very long output is saved to a file; you get its start, its end and the file path.
- Use the read, glob, grep, write and edit tools instead of cat, find, grep, sed or echo redirection.
- Never run interactive commands (editors, prompts, git rebase -i); they hang until the timeout.
- Quote paths that contain spaces.
- For a server or watcher that never exits, set background: true; it keeps running and you get its first output.
- Check the exit code on every result and investigate failures before moving on.
- Provide "description" before "command" in the arguments.`,
  parameters: {
    type: "object",
    // description comes first in both lists: DeepSeek Harness measured that V4 models fill
    // arguments in `required` order, and writing the description first improves the command.
    properties: {
      description: { type: "string", description: "Five to ten words on what this command does" },
      command: { type: "string" },
      timeout: { type: "number", description: "Milliseconds, up to 600000" },
      background: { type: "boolean", description: "Start a long-running process and return after its first few seconds of output" },
    },
    required: ["description", "command"],
  },
  summarize: (a) => a.command,
  run(a, ctx) {
    if (typeof a.command !== "string" || !a.command.trim()) throw new ToolError("command is required.");
    const timeout = Math.min(MAX_TIMEOUT, Math.max(1000, a.timeout ?? DEFAULT_TIMEOUT));
    return new Promise((resolve) => {
      const child = spawn(SHELL.cmd, SHELL.args(a.command), {
        cwd: ctx.cwd,
        env: { ...process.env, PAGER: "cat", GIT_PAGER: "cat", TERM: "dumb", CI: "1" },
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      let out = "";
      const add = (d: Buffer) => {
        out += d.toString("utf8");
        if (out.length > MAX_OUTPUT * 4) out = out.slice(0, MAX_OUTPUT * 2) + out.slice(-MAX_OUTPUT * 2);
      };
      child.stdout.on("data", add);
      child.stderr.on("data", add);
      let settled = false;
      const finish = (note: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        const body = truncateMiddle(out.trimEnd(), MAX_OUTPUT);
        resolve({ output: (body || "(no output)") + note, title: a.description ?? a.command });
      };
      const onAbort = () => {
        killTree(child.pid);
        finish("\n[interrupted by user]");
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        if (a.background) {
          child.unref();
          finish(`\n[still running in the background, pid ${child.pid}]`);
        } else {
          killTree(child.pid);
          finish(`\n[killed after ${timeout / 1000}s timeout]`);
        }
      }, a.background ? 5000 : timeout);
      child.on("error", (e) => finish(`\n[failed to start: ${e.message}]`));
      child.on("close", (code) => finish(code ? `\n[exit code ${code}]` : ""));
    });
  },
};
