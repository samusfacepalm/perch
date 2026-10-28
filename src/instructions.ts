// Everything the user has already taught other agents, read live from where those agents keep
// it, so Perch never works from a stale copy:
//   - global instructions: ~/.perch/AGENTS.md, ~/.claude/CLAUDE.md, ~/.config/opencode/AGENTS.md
//   - project instructions: AGENTS.md / CLAUDE.md / PERCH.md from the folder up to home
//   - Claude Code's memory index for the project (~/.claude/projects/<folder>/memory/MEMORY.md)
//   - skills (SKILL.md folders) from Claude Code and its plugins, OpenCode and Perch, loaded on demand
//   - custom subagents (markdown with frontmatter) from Claude Code and its plugins, OpenCode and Perch
// Codex's AGENTS.md is deliberately not read: it defines Codex's own persona.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

export interface InstructionFile {
  path: string;
  kind: "global" | "project" | "memory";
  text: string;
}

export interface Skill {
  name: string;
  description: string;
  path: string; // SKILL.md
  source: string;
}

export interface AgentDef {
  name: string;
  description: string;
  prompt: string;
  model?: string;
  tools?: string[]; // limit the subagent to these tools
  path: string;
}

function read(file: string, max = 40_000): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "").slice(0, max);
  } catch {
    return undefined;
  }
}

// Minimal YAML frontmatter: top-level "key: value" lines between --- fences.
export function frontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { data, body: text.slice(m[0].length) };
}

export function globalInstructionPaths(extra: string[] = []): string[] {
  return [
    path.join(HOME, ".perch", "AGENTS.md"),
    path.join(HOME, ".claude", "CLAUDE.md"),
    path.join(HOME, ".config", "opencode", "AGENTS.md"),
    ...extra,
  ];
}

function projectInstructionPaths(cwd: string): string[] {
  const names = ["AGENTS.md", "CLAUDE.md", "PERCH.md"];
  const chain: string[] = [];
  let dir = path.resolve(cwd);
  while (true) {
    // Home holds the global files, already loaded; stop before it.
    if (dir.toLowerCase() === HOME.toLowerCase()) break;
    for (const n of names) {
      const f = path.join(dir, n);
      if (fs.existsSync(f)) chain.unshift(f);
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return chain;
}

// Claude Code names a project's folder by replacing every non-alphanumeric character with "-".
export function claudeProjectDir(cwd: string): string {
  return path.join(HOME, ".claude", "projects", path.resolve(cwd).replace(/[^A-Za-z0-9]/g, "-"));
}

export function loadInstructions(cwd: string, extra: string[] = []): InstructionFile[] {
  const out: InstructionFile[] = [];
  const seen = new Set<string>(); // paragraphs already included, normalised
  const add = (file: string, kind: InstructionFile["kind"]) => {
    const text = read(file);
    if (!text?.trim()) return;
    // Drop paragraphs that an earlier file already said word for word, so overlapping
    // CLAUDE.md and AGENTS.md files don't repeat themselves.
    const kept = text.split(/\n\s*\n/).filter((para) => {
      const key = para.replace(/\s+/g, " ").trim().toLowerCase();
      if (key.length < 40) return true; // headings and short lines stay for structure
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const body = kept.join("\n\n").trim();
    if (body && out.every((f) => path.resolve(f.path) !== path.resolve(file))) out.push({ path: file, kind, text: body });
  };
  for (const f of globalInstructionPaths(extra)) add(f, "global");
  for (const f of projectInstructionPaths(cwd)) add(f, "project");
  const memory = path.join(claudeProjectDir(cwd), "memory", "MEMORY.md");
  if (fs.existsSync(memory)) add(memory, "memory");
  return out;
}

export interface ClaudePlugin {
  name: string; // "blockbench-mcp"
  root: string; // its install folder, ${CLAUDE_PLUGIN_ROOT}
}

function readJSON(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

// Claude Code plugins that are installed and switched on for this folder. Each can bring
// skills, agents and MCP servers, which Perch uses too. Their hooks are left alone: they are
// written for Claude Code's session and would change how Perch talks.
export function claudePlugins(cwd: string): ClaudePlugin[] {
  const installed = readJSON(path.join(HOME, ".claude", "plugins", "installed_plugins.json"))?.plugins ?? {};
  const enabled: Record<string, boolean> = {
    ...readJSON(path.join(HOME, ".claude", "settings.json"))?.enabledPlugins,
    ...readJSON(path.join(cwd, ".claude", "settings.json"))?.enabledPlugins,
    ...readJSON(path.join(cwd, ".claude", "settings.local.json"))?.enabledPlugins,
  };
  const here = path.resolve(cwd).toLowerCase();
  const out: ClaudePlugin[] = [];
  for (const [key, entries] of Object.entries<any>(installed)) {
    if (!enabled[key]) continue;
    const list = Array.isArray(entries) ? entries : [entries];
    const entry = list.find((e: any) => e?.scope === "user" || !e?.projectPath || path.resolve(e.projectPath).toLowerCase() === here);
    if (entry?.installPath && fs.existsSync(entry.installPath)) out.push({ name: key.split("@")[0], root: entry.installPath });
  }
  return out;
}

function skillDirs(cwd: string): [string, string][] {
  return [
    [path.join(HOME, ".perch", "skills"), "Perch"],
    [path.join(HOME, ".claude", "skills"), "Claude Code"],
    ...claudePlugins(cwd).map((p): [string, string] => [path.join(p.root, "skills"), `Claude Code plugin ${p.name}`]),
    [path.join(HOME, ".config", "opencode", "skills"), "OpenCode"],
    [path.join(cwd, ".claude", "skills"), "project"],
    [path.join(cwd, ".opencode", "skills"), "project"],
  ];
}

// Every new session lists the skills, and there can be a hundred of them; a file is read and
// parsed again only when it changes.
const skillCache = new Map<string, { mtime: number; data: Record<string, string> }>();
function skillMeta(file: string): Record<string, string> | undefined {
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  const hit = skillCache.get(file);
  if (hit?.mtime === mtime) return hit.data;
  const text = read(file, 4000);
  if (!text) return undefined;
  const { data } = frontmatter(text);
  skillCache.set(file, { mtime, data });
  return data;
}

export function loadSkills(cwd: string): Skill[] {
  const found = new Map<string, Skill>();
  for (const [dir, source] of skillDirs(cwd)) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const file = path.join(dir, name, "SKILL.md");
      const data = skillMeta(file);
      if (!data) continue;
      const skillName = data.name || name;
      // Later sources (project) override earlier ones with the same name.
      found.set(skillName, { name: skillName, description: data.description ?? "", path: file, source });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadAgents(cwd: string): AgentDef[] {
  const dirs = [
    path.join(HOME, ".perch", "agents"),
    path.join(HOME, ".claude", "agents"),
    ...claudePlugins(cwd).map((p) => path.join(p.root, "agents")),
    path.join(HOME, ".config", "opencode", "agent"),
    path.join(HOME, ".config", "opencode", "agents"),
    path.join(cwd, ".claude", "agents"),
    path.join(cwd, ".opencode", "agent"),
    path.join(cwd, ".opencode", "agents"),
  ];
  const found = new Map<string, AgentDef>();
  for (const dir of dirs) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of entries) {
      const file = path.join(dir, f);
      const text = read(file);
      if (!text) continue;
      const { data, body } = frontmatter(text);
      if (data.mode === "primary") continue; // OpenCode primary agents are not subagents
      const name = data.name || f.replace(/\.md$/, "");
      const tools = data.tools ? data.tools.split(/[,\s]+/).filter(Boolean) : undefined;
      found.set(name, { name, description: data.description ?? "", prompt: body.trim(), model: data.model, tools, path: file });
    }
  }
  return [...found.values()];
}
