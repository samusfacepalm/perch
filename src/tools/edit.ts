// String-replacement edits, with a chain of increasingly forgiving matchers.
//
// Models often get whitespace, indentation or escaping slightly wrong in old_string.
// Failing outright wastes a turn and invites the model to rewrite the whole file, so we try
// stricter matchers first and looser ones after, in the spirit of OpenCode's edit tool.
// Every matcher returns text that really occurs in the file; a looser matcher is only used
// when it identifies exactly one place.

import fs from "node:fs";
import { createTwoFilesPatch } from "diff";
import { assertFresh } from "./files.js";
import { relative, resolvePath, ToolError, type Tool } from "./types.js";

type Matcher = (content: string, find: string) => Generator<string>;

const exact: Matcher = function* (_content, find) {
  yield find;
};

// Same lines, ignoring leading and trailing whitespace on each line.
const lineTrimmed: Matcher = function* (content, find) {
  const lines = content.split("\n");
  const want = trimTrailingEmpty(find.split("\n"));
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (lines[i + j].trim() !== want[j].trim()) {
        ok = false;
        break;
      }
    }
    if (ok) yield lines.slice(i, i + want.length).join("\n");
  }
};

// First and last lines match (trimmed) and the lines between are mostly similar.
// Catches blocks where the model misremembered a line or two in the middle.
const blockAnchor: Matcher = function* (content, find) {
  const want = trimTrailingEmpty(find.split("\n"));
  if (want.length < 3) return;
  const lines = content.split("\n");
  const first = want[0].trim();
  const last = want[want.length - 1].trim();
  const candidates: { start: number; end: number; score: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== first) continue;
    for (let k = i + 2; k < lines.length && k <= i + want.length * 2; k++) {
      if (lines[k].trim() !== last) continue;
      const middle = lines.slice(i + 1, k);
      const wantMiddle = want.slice(1, -1);
      const n = Math.max(middle.length, wantMiddle.length);
      let score = 0;
      for (let m = 0; m < Math.min(middle.length, wantMiddle.length); m++) {
        score += similarity(middle[m].trim(), wantMiddle[m].trim());
      }
      candidates.push({ start: i, end: k, score: n ? score / n : 1 });
      break;
    }
  }
  // One candidate needs modest similarity; several need a clear winner.
  const threshold = candidates.length === 1 ? 0.5 : 0.8;
  const best = candidates.sort((x, y) => y.score - x.score)[0];
  if (best && best.score >= threshold && (candidates.length === 1 || best.score > candidates[1].score)) {
    yield lines.slice(best.start, best.end + 1).join("\n");
  }
};

// Runs of whitespace treated as one space.
const whitespaceNormalized: Matcher = function* (content, find) {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = norm(find);
  if (!target) return;
  const lines = content.split("\n");
  const n = find.split("\n").length;
  for (let i = 0; i + n <= lines.length; i++) {
    const block = lines.slice(i, i + n).join("\n");
    if (norm(block) === target) yield block;
  }
};

// The block matches once the common indentation is removed from both sides.
const indentationFlexible: Matcher = function* (content, find) {
  const dedent = (s: string) => {
    const ls = s.split("\n");
    const ind = Math.min(...ls.filter((l) => l.trim()).map((l) => l.match(/^\s*/)![0].length));
    return ls.map((l) => (l.trim() ? l.slice(ind) : l)).join("\n");
  };
  const target = dedent(find);
  const lines = content.split("\n");
  const n = find.split("\n").length;
  for (let i = 0; i + n <= lines.length; i++) {
    const block = lines.slice(i, i + n).join("\n");
    if (dedent(block) === target) yield block;
  }
};

// The model wrote \n, \t or \" literally where the file has the real character, or the reverse.
const escapeNormalized: Matcher = function* (content, find) {
  const unescaped = find.replace(/\\(n|t|r|'|"|`|\\|\$)/g, (_, c) =>
    ({ n: "\n", t: "\t", r: "\r", "'": "'", '"': '"', "`": "`", "\\": "\\", $: "$" })[c as "n"],
  );
  if (unescaped !== find) yield unescaped;
};

const trimmedBoundary: Matcher = function* (_content, find) {
  const t = find.trim();
  if (t !== find) yield t;
};

const MATCHERS: [string, Matcher][] = [
  ["exact", exact],
  ["line-trimmed", lineTrimmed],
  ["block-anchor", blockAnchor],
  ["whitespace", whitespaceNormalized],
  ["indentation", indentationFlexible],
  ["escapes", escapeNormalized],
  ["trimmed", trimmedBoundary],
];

function trimTrailingEmpty(lines: string[]) {
  const out = [...lines];
  while (out.length > 1 && out[out.length - 1].trim() === "") out.pop();
  return out;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  return 1 - levenshtein(a, b) / max;
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

export function applyEdit(content: string, oldString: string, newString: string, replaceAll = false): { result: string; matcher: string } {
  if (oldString === newString) throw new ToolError("old_string and new_string are identical; nothing to change.");
  let sawAmbiguous = false;
  for (const [name, matcher] of MATCHERS) {
    for (const candidate of matcher(content, oldString)) {
      if (!candidate) continue;
      const count = countOf(content, candidate);
      if (count === 0) continue;
      // A loose matcher must not swallow far more text than the model wrote.
      const oldLines = oldString.split("\n").length;
      const gotLines = candidate.split("\n").length;
      if (gotLines >= Math.max(oldLines + 3, oldLines * 2)) continue;
      if (replaceAll) return { result: content.split(candidate).join(newString), matcher: name };
      if (count > 1) {
        sawAmbiguous = true;
        continue;
      }
      const i = content.indexOf(candidate);
      return { result: content.slice(0, i) + newString + content.slice(i + candidate.length), matcher: name };
    }
  }
  if (sawAmbiguous) {
    throw new ToolError("old_string matches more than one place. Include more surrounding lines to make it unique, or set replace_all.");
  }
  throw new ToolError("old_string was not found in the file. Read the file again and copy the exact text, without the line-number prefix.");
}

export const edit: Tool = {
  name: "edit",
  description: `Replace text in a file. old_string must identify one place in the file; new_string replaces it.
- Read the file first. Copy old_string exactly from what read showed, without the line-number prefix and tab.
- Include two or three lines of unchanged context so the match is unique. Keep it small otherwise.
- Preserve the file's indentation (tabs or spaces) in new_string.
- Set replace_all to change every occurrence, e.g. renaming a variable.
- To create a file, use write. For several separate changes to one file, call edit several times.
- Provide "path" before "old_string" and "new_string" in the arguments.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      old_string: { type: "string", description: "The exact text to replace" },
      new_string: { type: "string", description: "The replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    required: ["path", "old_string", "new_string"],
  },
  summarize: (a) => a.path,
  async run(a, ctx) {
    const file = resolvePath(ctx.cwd, a.path);
    if (typeof a.old_string !== "string" || typeof a.new_string !== "string") {
      throw new ToolError("old_string and new_string must be strings.");
    }
    if (!fs.existsSync(file)) {
      if (a.old_string === "") {
        fs.writeFileSync(file, a.new_string);
        ctx.readFiles.set(file, fs.statSync(file).mtimeMs);
        return { output: `Created ${relative(ctx.cwd, file)}.`, title: relative(ctx.cwd, file) };
      }
      throw new ToolError(`File not found: ${file}`);
    }
    assertFresh(file, ctx.readFiles);
    const raw = fs.readFileSync(file, "utf8");
    // Match on LF text, then restore the file's own line endings.
    const crlf = raw.includes("\r\n");
    const content = crlf ? raw.replace(/\r\n/g, "\n") : raw;
    const oldS = a.old_string.replace(/\r\n/g, "\n");
    const newS = a.new_string.replace(/\r\n/g, "\n");
    const { result, matcher } = applyEdit(content, oldS, newS, !!a.replace_all);
    fs.writeFileSync(file, crlf ? result.replace(/\n/g, "\r\n") : result);
    ctx.readFiles.set(file, fs.statSync(file).mtimeMs);
    const rel = relative(ctx.cwd, file);
    const note = matcher === "exact" ? "" : ` (matched by ${matcher} comparison; check the result)`;
    return {
      output: `Edited ${rel}${note}.`,
      title: rel,
      diff: createTwoFilesPatch(rel, rel, content, result, "", "", { context: 2 }),
    };
  },
};
