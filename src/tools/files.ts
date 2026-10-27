// read, write, list, glob and grep.

import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import { createTwoFilesPatch } from "diff";
import { relative, resolvePath, ToolError, type Tool } from "./types.js";

const IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/.next/**", "**/__pycache__/**", "**/.venv/**"];
const MAX_LINE = 2000;
const DEFAULT_LIMIT = 2000;
const MAX_READ_BYTES = 256 * 1024;

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const read: Tool = {
  name: "read",
  description: `Read a file from disk. Returns lines numbered like \`cat -n\` (line number, tab, text).
- Reads up to ${DEFAULT_LIMIT} lines from the start by default. For large files pass offset (1-based line) and limit.
- Lines longer than ${MAX_LINE} characters are cut.
- Read a file before you edit or overwrite it; edits to files you have not read are refused.
- The line-number prefix is not part of the file. Never include it in edit strings.
- Reading several files you will need is cheap: call read on each of them in the same turn.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      offset: { type: "number", description: "1-based line number to start from" },
      limit: { type: "number", description: "Number of lines to read" },
    },
    required: ["path"],
  },
  summarize: (a) => `${a.path}${a.offset ? `:${a.offset}` : ""}`,
  async run(a, ctx) {
    const file = resolvePath(ctx.cwd, a.path);
    if (!fs.existsSync(file)) {
      const dir = path.dirname(file);
      const base = path.basename(file).toLowerCase();
      const near = fs.existsSync(dir)
        ? fs.readdirSync(dir).filter((f) => f.toLowerCase().includes(base.slice(0, 4))).slice(0, 5)
        : [];
      throw new ToolError(`File not found: ${file}${near.length ? `\nDid you mean: ${near.join(", ")}` : ""}`);
    }
    const stat = fs.statSync(file);
    if (stat.isDirectory()) return list.run({ path: a.path }, ctx);
    const buf = fs.readFileSync(file);
    if (isBinary(buf)) throw new ToolError(`${file} is a binary file (${stat.size} bytes).`);
    const lines = buf.toString("utf8").split(/\r?\n/);
    const start = Math.max(1, Math.floor(a.offset ?? 1));
    const limit = Math.max(1, Math.floor(a.limit ?? DEFAULT_LIMIT));
    let bytes = 0;
    const out: string[] = [];
    let end = start - 1;
    for (let i = start - 1; i < Math.min(lines.length, start - 1 + limit); i++) {
      let line = lines[i];
      if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE) + "... [line cut]";
      bytes += line.length + 8;
      if (bytes > MAX_READ_BYTES) break;
      out.push(`${String(i + 1).padStart(6)}\t${line}`);
      end = i + 1;
    }
    ctx.readFiles.set(file, stat.mtimeMs);
    let footer = "";
    if (end < lines.length) footer = `\n\n(Showing lines ${start}-${end} of ${lines.length}. Use offset=${end + 1} to read more.)`;
    if (lines.length === 1 && lines[0] === "") return { output: "(empty file)", title: relative(ctx.cwd, file) };
    return { output: out.join("\n") + footer, title: `${relative(ctx.cwd, file)} (${end - start + 1} lines)` };
  },
};

export const write: Tool = {
  name: "write",
  description: `Create a new file, or replace an existing file completely.
- Prefer the edit tool for changes to existing files; it sends only the change.
- To overwrite an existing file you must have read it first in this session.
- Parent folders are created as needed.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      content: { type: "string", description: "The full file content" },
    },
    required: ["path", "content"],
  },
  summarize: (a) => `${a.path} (${String(a.content ?? "").split("\n").length} lines)`,
  async run(a, ctx) {
    const file = resolvePath(ctx.cwd, a.path);
    if (typeof a.content !== "string") throw new ToolError("content must be a string.");
    let before = "";
    if (fs.existsSync(file)) {
      assertFresh(file, ctx.readFiles);
      before = fs.readFileSync(file, "utf8");
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, a.content);
    ctx.readFiles.set(file, fs.statSync(file).mtimeMs);
    const rel = relative(ctx.cwd, file);
    return {
      output: before ? `Overwrote ${rel}.` : `Created ${rel}.`,
      title: rel,
      diff: createTwoFilesPatch(rel, rel, before, a.content, "", "", { context: 2 }),
    };
  },
};

// Refuse writes to files the model hasn't read, or that changed on disk since it read them.
export function assertFresh(file: string, readFiles: Map<string, number>) {
  const seen = readFiles.get(file);
  if (seen === undefined) throw new ToolError(`You must read ${file} before changing it.`);
  const now = fs.statSync(file).mtimeMs;
  if (now > seen + 1) throw new ToolError(`${file} changed on disk since you read it. Read it again before editing.`);
}

export const list: Tool = {
  name: "list",
  description: "List a directory as a tree, two levels deep, skipping node_modules, .git and build output. Use glob to find files by pattern.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory; defaults to the working directory" } },
  },
  summarize: (a) => a.path ?? ".",
  async run(a, ctx) {
    const root = resolvePath(ctx.cwd, a.path ?? ".");
    if (!fs.existsSync(root)) throw new ToolError(`Not found: ${root}`);
    const skip = new Set(["node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv"]);
    const lines: string[] = [root + "/"];
    let count = 0;
    const walk = (dir: string, depth: number, indent: string) => {
      let entries = fs.readdirSync(dir, { withFileTypes: true });
      entries = entries.sort((x, y) => Number(y.isDirectory()) - Number(x.isDirectory()) || x.name.localeCompare(y.name));
      for (const e of entries) {
        if (count++ > 400) return;
        if (e.isDirectory()) {
          lines.push(`${indent}${e.name}/${skip.has(e.name) ? " (skipped)" : ""}`);
          if (depth < 2 && !skip.has(e.name)) walk(path.join(dir, e.name), depth + 1, indent + "  ");
        } else lines.push(indent + e.name);
      }
    };
    walk(root, 1, "  ");
    if (count > 400) lines.push("  ... (listing cut at 400 entries; use glob to narrow)");
    return { output: lines.join("\n"), title: relative(ctx.cwd, root) || "." };
  },
};

export const glob: Tool = {
  name: "glob",
  description: `Find files by glob pattern, e.g. "src/**/*.ts" or "**/*.{json,md}". Returns paths sorted by most recently modified, up to 200. Skips node_modules and .git.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string", description: "Directory to search in; defaults to the working directory" },
    },
    required: ["pattern"],
  },
  summarize: (a) => a.pattern + (a.path ? ` in ${a.path}` : ""),
  async run(a, ctx) {
    const root = resolvePath(ctx.cwd, a.path ?? ".");
    const { files, note } = await findFiles(a.pattern, root, ctx.signal, 5000);
    const withTimes = files.map((f) => {
      try {
        return { f, t: fs.statSync(f).mtimeMs };
      } catch {
        return { f, t: 0 };
      }
    });
    withTimes.sort((x, y) => y.t - x.t);
    const shown = withTimes.slice(0, 200).map((x) => relative(ctx.cwd, x.f));
    const more = files.length > 200 ? `\n(${files.length - 200} more; narrow the pattern)` : "";
    return { output: (shown.length ? shown.join("\n") + more : "No files matched.") + note, title: `${files.length} files` };
  },
};

// Walks the tree as a stream, so a pattern run over a huge folder (a whole drive, a package
// cache) stops after a time or count limit instead of hanging the agent for minutes.
async function findFiles(pattern: string, root: string, signal: AbortSignal, limit: number, timeMs = 15_000): Promise<{ files: string[]; note: string }> {
  const files: string[] = [];
  const started = Date.now();
  let note = "";
  const stream = fg.stream(pattern, { cwd: root, ignore: IGNORE, dot: true, absolute: true, suppressErrors: true });
  for await (const entry of stream) {
    files.push(path.normalize(String(entry)));
    if (files.length >= limit) {
      note = `\n(stopped after ${limit} files; narrow the pattern or the folder)`;
      break;
    }
    if (Date.now() - started > timeMs) {
      note = `\n(stopped after ${timeMs / 1000}s; this folder is very large. Narrow the pattern or search a smaller folder.)`;
      break;
    }
    if (signal.aborted) break;
  }
  (stream as any).destroy?.();
  return { files, note };
}

export const grep: Tool = {
  name: "grep",
  description: `Search file contents with a JavaScript regular expression.
- output_mode "files" (default) lists matching files; "content" shows matching lines with line numbers.
- Narrow with include, a glob such as "**/*.ts".
- Use this rather than running grep or findstr through bash.`,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "Directory or file; defaults to the working directory" },
      include: { type: "string", description: 'Glob filter, e.g. "**/*.{ts,tsx}"' },
      output_mode: { type: "string", enum: ["files", "content"] },
      ignore_case: { type: "boolean" },
      context: { type: "number", description: "Lines of context around each match (content mode)" },
    },
    required: ["pattern"],
  },
  summarize: (a) => `/${a.pattern}/${a.include ? ` ${a.include}` : ""}`,
  async run(a, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(a.pattern, a.ignore_case ? "i" : "");
    } catch (e: any) {
      throw new ToolError(`Bad regular expression: ${e.message}`);
    }
    const root = resolvePath(ctx.cwd, a.path ?? ".");
    const isFile = fs.existsSync(root) && fs.statSync(root).isFile();
    const { files, note: walkNote } = isFile ? { files: [root], note: "" } : await findFiles(a.include ?? "**/*", root, ctx.signal, 50_000);
    const deadline = Date.now() + 30_000;
    let timeNote = "";
    const mode = a.output_mode ?? "files";
    const ctxLines = Math.min(10, Math.max(0, a.context ?? 0));
    const hits: string[] = [];
    let matched = 0;
    for (const file of files) {
      if (ctx.signal.aborted) break;
      if (Date.now() > deadline) {
        timeNote = "\n(stopped reading after 30s; search a smaller folder or narrow include)";
        break;
      }
      let buf: Buffer;
      try {
        if (fs.statSync(file).size > 2_000_000) continue;
        buf = fs.readFileSync(file);
      } catch {
        continue;
      }
      if (isBinary(buf)) continue;
      const lines = buf.toString("utf8").split(/\r?\n/);
      const found: number[] = [];
      for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) found.push(i);
      if (!found.length) continue;
      matched++;
      const rel = relative(ctx.cwd, file);
      if (mode === "files") hits.push(rel);
      else {
        const show = new Set<number>();
        for (const i of found) for (let j = i - ctxLines; j <= i + ctxLines; j++) if (j >= 0 && j < lines.length) show.add(j);
        for (const j of [...show].sort((x, y) => x - y)) {
          hits.push(`${rel}:${j + 1}${found.includes(j) ? ":" : "-"}${lines[j].slice(0, 400)}`);
        }
      }
      if (hits.length >= 300) break;
    }
    if (!hits.length) return { output: "No matches." + walkNote + timeNote, title: "0 matches" };
    const more = hits.length >= 300 ? "\n(results cut at 300 lines; narrow the search)" : "";
    return { output: hits.slice(0, 300).join("\n") + more + walkNote + timeNote, title: `${matched} files` };
  },
};
