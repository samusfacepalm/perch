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

// Where old_string occurs in the file: the spans to replace, and the matcher that found them.
function locate(content: string, oldString: string, replaceAll: boolean): { spans: [number, number][]; matcher: string } {
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
      if (count > 1 && !replaceAll) {
        sawAmbiguous = true;
        continue;
      }
      const spans: [number, number][] = [];
      for (let i = content.indexOf(candidate); i >= 0; i = content.indexOf(candidate, i + candidate.length)) {
        spans.push([i, i + candidate.length]);
      }
      return { spans, matcher: name };
    }
  }
  if (sawAmbiguous) {
    throw new ToolError("old_string matches more than one place. Include more surrounding lines to make it unique, or set replace_all.");
  }
  throw new ToolError("old_string was not found in the file. Read the file again and copy the exact text, without the line-number prefix.");
}

export type EditSpec = { old_string: string; new_string: string; replace_all?: boolean };

// Several edits to one file, after pi's edit tool: each is matched against the file as it was
// before the call, so one call makes all the changes or, if any fails, none of them.
export function applyEdits(content: string, edits: EditSpec[]): { result: string; matchers: string[] } {
  const label = (n: number) => (edits.length > 1 ? `edits[${n}]: ` : "");
  const spans: { start: number; end: number; text: string; n: number }[] = [];
  const matchers: string[] = [];
  edits.forEach((e, n) => {
    if (e.old_string === e.new_string) throw new ToolError(`${label(n)}old_string and new_string are identical; nothing to change.`);
    try {
      const found = locate(content, e.old_string, !!e.replace_all);
      matchers.push(found.matcher);
      for (const [start, end] of found.spans) spans.push({ start, end, text: e.new_string, n });
    } catch (err: any) {
      throw new ToolError(`${label(n)}${err.message}${edits.length > 1 ? " No edits were made." : ""}`);
    }
  });
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) {
    if (spans[i].start < spans[i - 1].end) {
      throw new ToolError(`edits[${spans[i - 1].n}] and edits[${spans[i].n}] overlap. Merge them into one edit. No edits were made.`);
    }
  }
  let result = content;
  for (const s of spans.reverse()) result = result.slice(0, s.start) + s.text + result.slice(s.end);
  return { result, matchers };
}

export function applyEdit(content: string, oldString: string, newString: string, replaceAll = false): { result: string; matcher: string } {
  const { result, matchers } = applyEdits(content, [{ old_string: oldString, new_string: newString, replace_all: replaceAll }]);
  return { result, matcher: matchers[0] };
}

export const edit: Tool = {
  name: "edit",
  description: `Replace text in a file. old_string must identify one place in the file; new_string replaces it.
- Read the file first. Copy old_string exactly from what read showed, without the line-number prefix and tab.
- Include two or three lines of unchanged context so the match is unique. Keep it small otherwise.
- Preserve the file's indentation (tabs or spaces) in new_string.
- Set replace_all to change every occurrence, e.g. renaming a variable.
- For several separate changes to one file, make them in one call: pass edits, a list of {old_string, new_string, replace_all}, instead of old_string and new_string. Each is matched against the file as it was before the call, so they must not overlap; merge changes to nearby lines into one edit. If any edit fails, none is made.
- To create a file, use write.
- Provide "path" before the other arguments.`,
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the working directory" },
      old_string: { type: "string", description: "The exact text to replace" },
      new_string: { type: "string", description: "The replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
      edits: {
        type: "array",
        description: "Several changes to the file in one call, instead of old_string and new_string",
        items: {
          type: "object",
          properties: { old_string: { type: "string" }, new_string: { type: "string" }, replace_all: { type: "boolean" } },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["path"],
  },
  summarize: (a) => (Array.isArray(a.edits) && a.edits.length > 1 ? `${a.path} (${a.edits.length} edits)` : a.path),
  async run(a, ctx) {
    const file = resolvePath(ctx.cwd, a.path);
    const list: EditSpec[] = Array.isArray(a.edits) && a.edits.length ? a.edits : [{ old_string: a.old_string, new_string: a.new_string, replace_all: a.replace_all }];
    if (list.some((e) => typeof e?.old_string !== "string" || typeof e?.new_string !== "string")) {
      throw new ToolError("Each edit needs old_string and new_string, both strings.");
    }
    if (!fs.existsSync(file)) {
      if (list.length === 1 && list[0].old_string === "") {
        fs.writeFileSync(file, list[0].new_string);
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
    const lf = (s: string) => s.replace(/\r\n/g, "\n");
    const { result, matchers } = applyEdits(content, list.map((e) => ({ old_string: lf(e.old_string), new_string: lf(e.new_string), replace_all: !!e.replace_all })));
    fs.writeFileSync(file, crlf ? result.replace(/\n/g, "\r\n") : result);
    ctx.readFiles.set(file, fs.statSync(file).mtimeMs);
    const rel = relative(ctx.cwd, file);
    const loose = matchers.map((m, n) => (m === "exact" ? "" : list.length > 1 ? `edits[${n}] by ${m}` : m)).filter(Boolean);
    const note = !loose.length ? "" : list.length > 1 ? ` (loose matches: ${loose.join(", ")}; check the result)` : ` (matched by ${loose[0]} comparison; check the result)`;
    return {
      output: `Edited ${rel}${list.length > 1 ? ` in ${list.length} places` : ""}${note}.`,
      title: rel,
      diff: createTwoFilesPatch(rel, rel, content, result, "", "", { context: 2 }),
    };
  },
};
