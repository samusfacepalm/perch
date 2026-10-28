// Permission rules in Claude Code's syntax, so rules written for one agent work in the other:
//   "Bash(npm run test:*)"   a command, or a command prefix when it ends in :* or *
//   "Edit(src/**)"           files, as a glob relative to the project ("//" for an absolute path, "~/" for home)
//   "WebFetch(domain:docs.godotengine.org)"
//   "mcp__blockbench"        every tool of an MCP server; "mcp__blockbench__render" one tool
//   "Read"                   the whole tool
// They come from Claude Code's settings (user, project and project-local) and from "rules" in
// ~/.perch/config.json, each with allow, ask and deny lists. Deny beats ask beats allow.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Action = "allow" | "ask" | "deny";
export interface Rule {
  action: Action;
  tool: string; // Perch's tool name, or "mcp" for MCP rules
  spec?: string;
  source: string; // the rule as written, for messages
}

// Claude Code's tool names, and the Perch tools each covers.
const TOOLS: Record<string, string[]> = {
  Bash: ["bash"],
  Read: ["read", "glob", "grep", "list"],
  Edit: ["edit", "write"],
  MultiEdit: ["edit"],
  Write: ["write"],
  WebFetch: ["web_fetch"],
  WebSearch: ["web_search"],
  Task: ["task"],
};

export function parseRule(text: string, action: Action): Rule[] {
  const m = /^([\w-]+)(?:\((.*)\))?$/s.exec(text.trim());
  if (!m) return [];
  const [, name, spec] = m;
  if (name.startsWith("mcp__")) return [{ action, tool: "mcp", spec: name.slice(5), source: text }];
  const tools = TOOLS[name] ?? [name.toLowerCase()];
  return tools.map((tool) => ({ action, tool, spec: spec?.trim() || undefined, source: text }));
}

function readJSON(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

export function loadRules(cwd: string, own?: { allow?: string[]; ask?: string[]; deny?: string[] }): Rule[] {
  const lists = [
    readJSON(path.join(os.homedir(), ".claude", "settings.json"))?.permissions,
    readJSON(path.join(cwd, ".claude", "settings.json"))?.permissions,
    readJSON(path.join(cwd, ".claude", "settings.local.json"))?.permissions,
    own,
  ];
  const rules: Rule[] = [];
  for (const l of lists) for (const action of ["allow", "ask", "deny"] as Action[]) for (const r of l?.[action] ?? []) if (typeof r === "string") rules.push(...parseRule(r, action));
  return rules;
}

// "**" crosses folders, "*" and "?" stay inside one; matched case-insensitively on Windows.
export function globToRegex(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, process.platform === "win32" ? "i" : "");
}

function matchesPath(spec: string, file: string, cwd: string): boolean {
  const norm = (p: string) => p.split(path.sep).join("/");
  let pattern = spec;
  let target = norm(path.relative(cwd, file));
  if (spec.startsWith("//")) {
    pattern = spec.slice(1);
    target = norm(path.resolve(file));
  } else if (spec.startsWith("~/")) {
    pattern = norm(path.join(os.homedir(), spec.slice(2)));
    target = norm(path.resolve(file));
  } else if (path.isAbsolute(spec)) {
    pattern = norm(spec);
    target = norm(path.resolve(file));
  }
  pattern = pattern.replace(/^\.\//, "");
  return globToRegex(pattern).test(target) || globToRegex(pattern + "/**").test(target);
}

// A shell command split at && || ; and |, so each part is judged on its own.
export function commandParts(cmd: string): string[] {
  return cmd.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
}

function matchesCommand(spec: string, cmd: string): boolean {
  if (spec.endsWith(":*")) {
    const p = spec.slice(0, -2);
    return cmd === p || cmd.startsWith(p + " ");
  }
  if (spec.includes("*")) return globToRegex(spec.replace(/\//g, "\u0001")).test(cmd.replace(/\//g, "\u0001"));
  return cmd === spec;
}

function ruleMatches(r: Rule, tool: string, args: any, cwd: string, cmd?: string): boolean {
  if (r.tool === "mcp") {
    if (tool !== "mcp_call") return false;
    const [server, name] = r.spec!.split("__");
    return server === String(args.server) && (!name || name === "*" || name === String(args.tool));
  }
  if (r.tool !== tool) return false;
  if (!r.spec || r.spec === "*") return true;
  if (tool === "bash") return matchesCommand(r.spec, cmd ?? String(args.command ?? "").trim());
  if (tool === "web_fetch") {
    const domain = /^domain:(.+)$/.exec(r.spec)?.[1];
    if (!domain) return false;
    try {
      const host = new URL(String(args.url)).hostname;
      return host === domain || host.endsWith("." + domain);
    } catch {
      return false;
    }
  }
  const file = args.path ?? args.file_path;
  return typeof file === "string" && matchesPath(r.spec, path.resolve(cwd, file), cwd);
}

// What the rules say about one call: the strictest matching rule, or nothing. A chained shell
// command is denied when any part is denied, and allowed only when every part is allowed.
export function judge(rules: Rule[], tool: string, args: any, cwd: string): { action: Action; rule: string } | undefined {
  const relevant = rules.filter((r) => r.tool === tool || (r.tool === "mcp" && tool === "mcp_call"));
  if (!relevant.length) return undefined;
  const order: Action[] = ["deny", "ask", "allow"];
  if (tool === "bash") {
    const parts = commandParts(String(args.command ?? ""));
    for (const action of ["deny", "ask"] as Action[]) {
      const hit = relevant.find((r) => r.action === action && parts.some((p) => ruleMatches(r, tool, args, cwd, p)));
      if (hit) return { action, rule: hit.source };
    }
    const allows = parts.map((p) => relevant.find((r) => r.action === "allow" && ruleMatches(r, tool, args, cwd, p)));
    return parts.length && allows.every(Boolean) ? { action: "allow", rule: allows[0]!.source } : undefined;
  }
  for (const action of order) {
    const hit = relevant.find((r) => r.action === action && ruleMatches(r, tool, args, cwd));
    if (hit) return { action, rule: hit.source };
  }
  return undefined;
}
