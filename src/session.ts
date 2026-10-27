// Sessions are plain JSON files in ~/.perch/sessions, one per conversation.
// Small, readable and easy to delete: no database that grows without limit.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { HOME } from "./config.js";
import type { Message, Usage } from "./provider.js";

export interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}

export interface Session {
  id: string;
  title: string;
  cwd: string;
  scratch: boolean; // true when started with --no-folder
  model: string;
  created: string;
  updated: string;
  messages: Message[]; // what the model sees next turn (after any compaction)
  history: Message[]; // everything that was ever said, for display and for the record
  todos: Todo[];
  compactions: number;
  summary?: string; // latest compaction summary, folded into the next one
  permissionMode?: "ask" | "edits" | "all"; // what runs without asking (see Agent.permit)
  thinking?: "off" | "low" | "high" | "max"; // reasoning effort; unset means the provider default
  usage: SessionUsage;
}

export interface ModelUsage extends Usage {
  cost: number;
  priced: boolean; // false when the model has no known price
  requests: number;
}

export interface SessionUsage extends Usage {
  cost?: number; // dollars, for models with a known price
  byModel?: Record<string, ModelUsage>;
}

const DIR = path.join(HOME, "sessions");
export const sessionsDir = DIR;

export function newSession(cwd: string, model: string, scratch = false): Session {
  const now = new Date().toISOString();
  return {
    id: now.slice(0, 10) + "-" + crypto.randomBytes(3).toString("hex"),
    title: "New session",
    cwd,
    scratch,
    model,
    created: now,
    updated: now,
    messages: [],
    history: [],
    todos: [],
    compactions: 0,
    usage: { input: 0, output: 0, cacheHit: 0, reasoning: 0 },
  };
}

// Write to a temp file then rename, so a crash mid-write never corrupts a long session.
export function saveSession(s: Session) {
  fs.mkdirSync(DIR, { recursive: true });
  s.updated = new Date().toISOString();
  const file = path.join(DIR, s.id + ".json");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, file);
}

// The desktop app saves this way: off the main thread's critical path, at most one write in
// flight per session, and bursts of saves collapse into one. flushSaves() writes synchronously
// on quit.
const pendingSaves = new Map<string, Session>();
const writing = new Set<string>();
export function saveSessionSoon(s: Session) {
  pendingSaves.set(s.id, s);
  if (writing.has(s.id)) return;
  writing.add(s.id);
  setTimeout(async function write() {
    const latest = pendingSaves.get(s.id);
    pendingSaves.delete(s.id);
    if (latest) {
      latest.updated = new Date().toISOString();
      const file = path.join(DIR, latest.id + ".json");
      try {
        await fs.promises.mkdir(DIR, { recursive: true });
        await fs.promises.writeFile(file + ".tmp", JSON.stringify(latest));
        await fs.promises.rename(file + ".tmp", file);
      } catch {
        // the next save retries
      }
    }
    if (pendingSaves.has(s.id)) setTimeout(write, 250);
    else writing.delete(s.id);
  }, 250);
}
export function flushSaves() {
  for (const s of pendingSaves.values()) saveSession(s);
  pendingSaves.clear();
}

export function loadSession(id: string): Session {
  return JSON.parse(fs.readFileSync(path.join(DIR, id + ".json"), "utf8"));
}

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  updated: string;
  messages: number;
  usage: SessionUsage;
}

// Summaries are cached by file size and modification time, so listing a hundred long
// sessions re-reads only the ones that changed.
const summaryCache = new Map<string, { key: string; summary: SessionSummary }>();

export function listSessions(cwd?: string): SessionSummary[] {
  if (!fs.existsSync(DIR)) return [];
  const out: SessionSummary[] = [];
  const present = new Set<string>();
  for (const f of fs.readdirSync(DIR)) {
    if (!f.endsWith(".json")) continue;
    present.add(f);
    try {
      const file = path.join(DIR, f);
      const st = fs.statSync(file);
      const key = `${st.size}:${st.mtimeMs}`;
      let hit = summaryCache.get(f);
      if (!hit || hit.key !== key) {
        const s: Session = JSON.parse(fs.readFileSync(file, "utf8"));
        hit = { key, summary: { id: s.id, title: s.title, cwd: s.cwd, updated: s.updated, messages: s.history.length, usage: s.usage } };
        summaryCache.set(f, hit);
      }
      if (cwd && path.resolve(hit.summary.cwd) !== path.resolve(cwd)) continue;
      out.push(hit.summary);
    } catch {
      // skip unreadable files
    }
  }
  for (const f of summaryCache.keys()) if (!present.has(f)) summaryCache.delete(f);
  return out.sort((a, b) => b.updated.localeCompare(a.updated));
}

export function deleteSession(id: string) {
  fs.rmSync(path.join(DIR, id + ".json"), { force: true });
}

// --no-folder: a fresh dated folder under ~/.perch/scratch, kept until you delete it.
export function makeScratchDir(): string {
  const dir = path.join(HOME, "scratch", new Date().toISOString().slice(0, 10) + "-" + crypto.randomBytes(2).toString("hex"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
