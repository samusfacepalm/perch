import path from "node:path";
import { fromWslPath } from "../wsl.js";
import type { Session } from "../session.js";
import type { AgentDef } from "../instructions.js";

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  session: Session;
  // Files the model has read in this session, with the mtime it saw.
  // Edits to a file it never read, or that changed since, are refused.
  readFiles: Map<string, number>;
  // How many times each tool has been called since the user last wrote, this call included.
  turnCalls?: Map<string, number>;
  // Runs a subagent on a self-contained task and returns its final report.
  runSubagent?: (description: string, prompt: string, agent?: AgentDef) => Promise<string>;
}

export interface ToolResult {
  output: string; // what the model sees
  title?: string; // one-line label for the UI
  diff?: string; // unified diff for the UI, when a file changed
  images?: string[]; // image files the tool produced, for the UI
  play?: unknown; // a play run's full result, for the UI's run card
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  // A short summary of a call, for permission prompts and the transcript.
  summarize(args: any): string;
  run(args: any, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolError extends Error {}

// Accept Windows paths, forward-slash paths and Git Bash paths (/c/Users/...).
export function resolvePath(cwd: string, p: string): string {
  if (typeof p !== "string" || !p) throw new ToolError("A path is required.");
  let q = fromWslPath(p.trim().replace(/^["']|["']$/g, ""));
  const bashDrive = /^\/([a-zA-Z])(\/|$)/.exec(q);
  if (process.platform === "win32" && bashDrive) q = bashDrive[1].toUpperCase() + ":/" + q.slice(3);
  return path.resolve(cwd, q);
}

export function relative(cwd: string, file: string): string {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : file;
}

// Keep the head and tail of long output: errors usually sit at one end or the other.
export function truncateMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const cut = text.length - max;
  return `${text.slice(0, half)}\n\n... [${cut} characters cut from the middle] ...\n\n${text.slice(-half)}`;
}
