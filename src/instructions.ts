// Everything the user has already taught other agents, read live from where those agents keep
// it, so Perch never works from a stale copy:
//   - global instructions: ~/.perch/AGENTS.md, ~/.claude/CLAUDE.md, ~/.config/opencode/AGENTS.md
//   - project instructions: AGENTS.md / CLAUDE.md / PERCH.md from the folder up to home
//   - Claude Code's memory index for the project (~/.claude/projects/<folder>/memory/MEMORY.md)
//   - skills (SKILL.md folders) from Claude Code, OpenCode and Perch, loaded on demand
//   - custom subagents (markdown with frontmatter) from Claude Code, OpenCode and Perch
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

function skillDirs(cwd: string): [string, string][] {
  return [
    [path.join(HOME, ".perch", "skills"), "Perch"],
    [path.join(HOME, ".claude", "skills"), "Claude Code"],
    [path.join(HOME, ".config", "opencode", "skills"), "OpenCode"],
    [path.join(cwd, ".claude", "skills"), "project"],
    [path.join(cwd, ".opencode", "skills"), "project"],
  ];
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
      const text = read(file, 4000);
      if (!text) continue;
      const { data } = frontmatter(text);
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
