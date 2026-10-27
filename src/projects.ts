// Project folders known to Claude Code (~/.claude.json) and OpenCode (its SQLite database),
// plus folders Perch sessions have used. Worktrees, duplicates and folders that no longer
// exist are dropped.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSessions } from "./session.js";

export interface Project {
  path: string;
  name: string;
  sources: string[]; // "Claude Code", "OpenCode", "Perch"
  lastUsed?: string; // ISO date, when known
}

function claudeCodeProjects(): { path: string; lastUsed?: string }[] {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8"));
    return Object.keys(cfg.projects ?? {}).map((p) => ({ path: p }));
  } catch {
    return [];
  }
}

// OpenCode keeps projects in a table of its database. It is opened read-only; node:sqlite
// only reads the pages it needs, so the size of the database doesn't matter.
async function openCodeProjects(): Promise<{ path: string; lastUsed?: string }[]> {
  const file = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
  if (!fs.existsSync(file)) return [];
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const cols = (db.prepare("pragma table_info(project)").all() as { name: string }[]).map((c) => c.name);
      if (!cols.includes("worktree")) return [];
      const timeCol = cols.find((c) => /updated/i.test(c));
      const rows = db.prepare(`select worktree${timeCol ? `, ${timeCol} as t` : ""} from project`).all() as { worktree: string; t?: number }[];
      return rows.map((r) => ({ path: r.worktree, lastUsed: r.t ? new Date(r.t).toISOString() : undefined }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

const key = (p: string) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();

export async function knownProjects(): Promise<Project[]> {
  const found = new Map<string, Project>();
  const add = (p: string, source: string, lastUsed?: string) => {
    // Skip worktrees and throwaway folders (Perch's and the Claude app's scratch workspaces).
    if (!p || p === "/" || /[\\/](\.claude[\\/]worktrees|\.perch[\\/]scratch|scratch-workspaces)[\\/]/i.test(p)) return;
    const resolved = path.resolve(p);
    if (key(resolved) === key(os.homedir())) return;
    const k = key(resolved);
    const existing = found.get(k);
    if (existing) {
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (lastUsed && (!existing.lastUsed || lastUsed > existing.lastUsed)) existing.lastUsed = lastUsed;
      return;
    }
    found.set(k, { path: resolved, name: path.basename(resolved) || resolved, sources: [source], lastUsed });
  };
  for (const p of claudeCodeProjects()) add(p.path, "Claude Code", p.lastUsed);
  for (const p of await openCodeProjects()) add(p.path, "OpenCode", p.lastUsed);
  for (const s of listSessions()) add(s.cwd, "Perch", s.updated);
  return [...found.values()]
    .filter((p) => {
      try {
        return fs.statSync(p.path).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? "") || a.name.localeCompare(b.name));
}
