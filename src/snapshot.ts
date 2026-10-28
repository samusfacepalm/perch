// Undo, after OpenCode's snapshots: before each message Perch records the project folder as a
// git tree in a store of its own (~/.perch/snapshots/<folder hash>), never in the project's own
// .git, so it works in folders that aren't repositories and leaves the user's history alone.
// Undoing puts the files back as they were in that tree: changed and deleted files are
// restored, and files created since are removed. The project's .gitignore applies, and the
// usual build and cache folders are skipped.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOME } from "./config.js";

const EXCLUDE = ["node_modules/", ".godot/", "Library/", "Temp/", "Logs/", "obj/", "__pycache__/", ".venv/", "venv/", ".perch/golden/", "*.tmp"];

function gitDir(cwd: string): string {
  const id = crypto.createHash("sha1").update(path.resolve(cwd).toLowerCase()).digest("hex").slice(0, 16);
  return path.join(HOME, "snapshots", id);
}

function git(cwd: string, args: string[], input?: string, timeout = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["--git-dir", gitDir(cwd), "--work-tree", cwd, "-c", "core.autocrlf=false", "-c", "core.longpaths=true", "-c", "core.quotepath=false", ...args],
      { cwd, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => (err ? reject(new Error(`git ${args[0]}: ${stderr || err.message}`.trim())) : resolve(stdout)),
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

// Folders too broad to snapshot: the home folder and drive roots.
function tooBroad(cwd: string): boolean {
  const p = path.resolve(cwd);
  return p.toLowerCase() === os.homedir().toLowerCase() || path.parse(p).root === p;
}

// Limits on what a store may hold. Files over BIG_FILE (videos, baked textures, builds) are left
// out, since Perch doesn't edit them and they would double the disk use; undo leaves them as
// they are. A folder still over the other limits gets no snapshots at all.
const BIG_FILE = 10_000_000;
const MAX_FILES = 30_000;
const MAX_BYTES = 1_500_000_000;

// Returns false when the folder is too big to snapshot. Checked once, when the store is made.
async function ensureStore(cwd: string): Promise<boolean> {
  const dir = gitDir(cwd);
  if (fs.existsSync(path.join(dir, "too-big.txt"))) return false;
  if (fs.existsSync(path.join(dir, "HEAD"))) return true;
  fs.mkdirSync(dir, { recursive: true });
  await git(cwd, ["init", "--quiet"]);
  fs.mkdirSync(path.join(dir, "info"), { recursive: true });
  fs.writeFileSync(path.join(dir, "info", "exclude"), EXCLUDE.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "folder.txt"), path.resolve(cwd));
  const files = (await git(cwd, ["ls-files", "-z", "--others", "--exclude-standard"])).split("\0").filter(Boolean);
  let bytes = 0;
  const big: string[] = [];
  for (const f of files) {
    let size = 0;
    try {
      size = fs.statSync(path.join(cwd, f)).size;
    } catch {}
    if (size > BIG_FILE) big.push("/" + f.replace(/[\\*?[\]!#]/g, "\\$&").replace(/^ | $/g, "\\ "));
    else bytes += size;
  }
  if (big.length) fs.appendFileSync(path.join(dir, "info", "exclude"), "# over 10 MB\n" + big.join("\n") + "\n");
  if (files.length - big.length > MAX_FILES || bytes > MAX_BYTES) {
    fs.writeFileSync(path.join(dir, "too-big.txt"), `${files.length} files, ${Math.round(bytes / 1e6)} MB or more: no snapshots. Delete this folder to check again.\n`);
    return false;
  }
  return true;
}

// Folders whose first snapshot is being made in the background.
const warming = new Map<string, Promise<unknown>>();

// Record the folder as it is now. Returns the tree id, or undefined when the folder can't be
// recorded (too broad, too big, git missing, or still making its first snapshot); undo is then
// unavailable for that message.
// The first snapshot of a big project copies everything and can take a minute, so after three
// seconds it carries on in the background (opts.wait waits it out, for tests and benchmarks)
// and undo starts from the next message.
export async function snapshot(cwd: string, opts: { wait?: boolean } = {}): Promise<string | undefined> {
  if (tooBroad(cwd) || !fs.existsSync(cwd)) return undefined;
  const key = path.resolve(cwd).toLowerCase();
  if (warming.has(key)) return undefined;
  if (!opts.wait && !fs.existsSync(path.join(gitDir(cwd), "HEAD"))) {
    // A small folder's first snapshot takes well under a second, so it still counts.
    const p = record(cwd).finally(() => warming.delete(key));
    warming.set(key, p);
    return Promise.race([p, new Promise<undefined>((r) => setTimeout(r, 3000))]);
  }
  return record(cwd);
}

async function record(cwd: string): Promise<string | undefined> {
  try {
    if (!(await ensureStore(cwd))) return undefined;
    await git(cwd, ["add", "--all", "."]);
    return (await git(cwd, ["write-tree"])).trim();
  } catch {
    return undefined;
  }
}

// Put the folder back as it was in `tree`. Returns the files changed, relative to the folder.
export async function restore(cwd: string, tree: string): Promise<string[]> {
  const now = await snapshot(cwd, { wait: true });
  if (!now) throw new Error("Couldn't record the folder's current state, so nothing was undone.");
  if (now === tree) return [];
  const changes = (await git(cwd, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", tree, now]))
    .split("\0")
    .filter(Boolean);
  const added: string[] = [];
  const back: string[] = [];
  for (let i = 0; i + 1 < changes.length; i += 2) (changes[i] === "A" ? added : back).push(changes[i + 1]);
  if (back.length) await git(cwd, ["checkout", tree, "--pathspec-from-file=-", "--pathspec-file-nul"], back.join("\0"));
  for (const f of added) {
    fs.rmSync(path.join(cwd, f), { force: true });
    // Remove folders the undone work created and left empty.
    let dir = path.dirname(path.join(cwd, f));
    while (dir.length > path.resolve(cwd).length && fs.existsSync(dir) && !fs.readdirSync(dir).length) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  }
  await git(cwd, ["read-tree", tree]); // the store's index matches the folder again
  return [...back, ...added].sort();
}
