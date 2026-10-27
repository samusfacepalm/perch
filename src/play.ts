// Play-and-capture: run the project's game, take screenshots while it runs, collect its log,
// and hand both to the agent so it can see what a change actually did.
//
// How a project runs is detected (Godot, web/RPG Maker builds, dev servers, built .exe files),
// or set by hand in .perch/play.json:
//   { "command": "path/to/game.exe", "args": [], "url": "http://localhost:5173", "wait": 2 }
// Native games are captured from their own window (PrintWindow, so it works even when covered);
// web games run in a window the desktop app owns, captured directly.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { HOME } from "./config.js";
import { CAPTURE_CS } from "./capture-source.js";

export type PlayKind = "godot" | "web" | "devserver" | "exe" | "custom" | "unity" | "none";

export interface PlayPlan {
  kind: PlayKind;
  label: string; // e.g. "Godot 4 project"
  engine?: string; // Godot, Unity, RPG Maker MZ, Phaser, …
  command?: string;
  args?: string[];
  url?: string; // for web games and dev servers
  root?: string; // folder to serve for static web games
  devCommand?: string; // e.g. "npm run dev", started before loading url
  note?: string; // why it can't run, or what to know
}

export interface PlayOptions {
  seconds?: number; // how long to run (default 8)
  shots?: number[]; // seconds at which to capture (default spread over the run)
  keys?: { at: number; key: string }[]; // key presses, by DOM-style key name
  script?: string; // web only: JavaScript run in the page before each screenshot; its value is logged
  zoom?: { x: number; y: number; width: number; height: number }; // web only: capture this region at 2x
}

export interface PlayResult {
  plan: PlayPlan;
  screenshots: string[];
  log: string; // stdout, stderr and console output, last part
  errors: string[]; // lines that look like errors
  exitCode: number | null;
  stopped: boolean;
  golden?: GoldenCheck[]; // filled in when the project has golden screenshots
  warnings?: string[]; // frames that look blank, black or blown out
  seconds: number;
}

export const PLAY_DIR = path.join(HOME, "play");

const exists = (p: string) => fs.existsSync(p);
const readJSON = (p: string) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
};

export function findGodot(): string | undefined {
  if (process.env.GODOT_PATH && exists(process.env.GODOT_PATH)) return consoleVariant(process.env.GODOT_PATH);
  // OpenCode's godot MCP entry records the path.
  const oc = readJSON(path.join(os.homedir(), ".config", "opencode", "opencode.json"));
  const fromMcp = oc?.mcp?.godot?.environment?.GODOT_PATH;
  if (fromMcp && exists(fromMcp)) return consoleVariant(fromMcp);
  for (const name of ["godot", "godot4"]) {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
    const hit = r.stdout?.split(/\r?\n/).find((l) => l.trim());
    if (hit) return consoleVariant(hit.trim());
  }
  return undefined;
}

// The _console build of Godot writes its log to stdout on Windows; the plain one doesn't.
function consoleVariant(exe: string) {
  const c = exe.replace(/\.exe$/i, "_console.exe");
  return exe.endsWith("_console.exe") || !exists(c) ? exe : c;
}

function newestExe(dirs: string[]): string | undefined {
  let best: { p: string; t: number } | undefined;
  const visit = (d: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth > 0 && !/crashhandler|_data$|monobleeding|il2cpp/i.test(e.name)) visit(full, depth - 1);
      else if (e.isFile() && /\.exe$/i.test(e.name) && !/unitycrashhandler|uninstall|setup/i.test(e.name)) {
        const t = fs.statSync(full).mtimeMs;
        if (!best || t > best.t) best = { p: full, t };
      }
    }
  };
  for (const d of dirs) visit(d, 2);
  return best?.p;
}

export function detectPlay(cwd: string): PlayPlan {
  const custom = readJSON(path.join(cwd, ".perch", "play.json"));
  if (custom?.command || custom?.url) {
    return { kind: custom.command && !custom.url ? "custom" : custom.url && !custom.command ? "web" : "devserver", label: "Custom (.perch/play.json)", command: custom.command, args: custom.args ?? [], url: custom.url, devCommand: custom.command && custom.url ? [custom.command, ...(custom.args ?? [])].join(" ") : undefined };
  }

  if (exists(path.join(cwd, "project.godot"))) {
    const godot = findGodot();
    return godot
      ? { kind: "godot", label: "Godot project", engine: "Godot", command: godot, args: ["--path", cwd] }
      : { kind: "none", label: "Godot project", engine: "Godot", note: "Godot was not found. Set GODOT_PATH, or install it (winget install GodotEngine.GodotEngine)." };
  }

  if (exists(path.join(cwd, "Assets")) && exists(path.join(cwd, "ProjectSettings"))) {
    const exe = newestExe(["Build", "Builds", "build", "builds"].map((d) => path.join(cwd, d)).filter(exists));
    return exe
      ? { kind: "exe", label: `Unity build (${path.basename(exe)})`, engine: "Unity", command: exe, args: ["-screen-fullscreen", "0", "-screen-width", "1280", "-screen-height", "720", "-logFile", "-"] }
      : { kind: "unity", label: "Unity project", engine: "Unity", note: "Unity can't enter play mode from outside the editor. Make a Windows build into a Build/ folder, or use the Unity MCP server, and Play will run the newest build." };
  }

  const pkg = readJSON(path.join(cwd, "package.json"));
  const scripts = pkg?.scripts ?? {};
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const engine = deps.phaser ? "Phaser" : deps.pixi?.length || deps["pixi.js"] ? "PixiJS" : deps.three ? "three.js" : deps.excalibur ? "Excalibur" : deps.kaboom || deps.kaplay ? "Kaplay" : undefined;
  if (scripts.dev && (deps.vite || /vite/.test(scripts.dev))) {
    return { kind: "devserver", label: `Vite dev server${engine ? ` (${engine})` : ""}`, engine, devCommand: "npm run dev", url: "http://localhost:5173" };
  }

  // RPG Maker MZ/MV and other static web games: an index.html at the root, or in www/.
  for (const sub of ["", "www", "dist", "build", "public"]) {
    const root = path.join(cwd, sub);
    if (exists(path.join(root, "index.html"))) {
      const mz = exists(path.join(root, "js", "rmmz_core.js"));
      const mv = exists(path.join(root, "js", "rpg_core.js"));
      const eng = mz ? "RPG Maker MZ" : mv ? "RPG Maker MV" : engine;
      return { kind: "web", label: eng ? `${eng} game` : "Web game", engine: eng, root, url: "index.html" };
    }
  }

  const exe = newestExe([cwd, ...["Build", "Builds", "bin", "export", "exports"].map((d) => path.join(cwd, d))].filter(exists));
  if (exe) return { kind: "exe", label: `Program (${path.basename(exe)})`, command: exe, args: [] };

  return { kind: "none", label: "No game found", note: "Perch couldn't tell how to run this project. Add .perch/play.json with a command (and a url for web games)." };
}

// ---------- native runs ----------

// Window capture goes through a tiny helper exe (source in capture-source.ts), compiled once
// with the C# compiler that ships with Windows. Each capture then takes milliseconds.
const CAPTURE_EXE = path.join(PLAY_DIR, "perch-capture.exe");

function ensureCaptureExe(): boolean {
  if (process.platform !== "win32") return false;
  const stamp = CAPTURE_EXE + ".src";
  if (exists(CAPTURE_EXE) && exists(stamp) && fs.readFileSync(stamp, "utf8") === CAPTURE_CS) return true;
  fs.mkdirSync(PLAY_DIR, { recursive: true });
  const cs = path.join(PLAY_DIR, "capture.cs");
  fs.writeFileSync(cs, CAPTURE_CS);
  const csc = path.join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const r = spawnSync(csc, ["/nologo", "/target:exe", "/r:System.Drawing.dll", `/out:${CAPTURE_EXE}`, cs], { encoding: "utf8" });
  if (r.status !== 0) return false;
  fs.writeFileSync(stamp, CAPTURE_CS);
  return true;
}

// Windows virtual-key codes for the key names the play tool accepts (DOM-style names, plus a
// few common aliases). Single letters and digits map to themselves.
const VK: Record<string, number> = {
  Space: 0x20, " ": 0x20, Enter: 0x0d, Return: 0x0d, Escape: 0x1b, Esc: 0x1b, Tab: 0x09, Backspace: 0x08,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28, Left: 0x25, Up: 0x26, Right: 0x27, Down: 0x28,
  Shift: 0x10, Control: 0x11, Ctrl: 0x11, Alt: 0x12, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22, Insert: 0x2d, Delete: 0x2e,
  F1: 0x70, F2: 0x71, F3: 0x72, F4: 0x73, F5: 0x74, F6: 0x75, F7: 0x76, F8: 0x77, F9: 0x78, F10: 0x79, F11: 0x7a, F12: 0x7b,
};

export function virtualKey(name: string): number | undefined {
  if (VK[name] !== undefined) return VK[name];
  const k = name.replace(/^Key|^Digit/, "");
  if (/^[a-z0-9]$/i.test(k)) return k.toUpperCase().charCodeAt(0);
  return undefined;
}

// Runs the helper and returns what it printed ("" if it couldn't run or timed out).
function runHelper(args: string[], timeoutMs = 5000): Promise<string> {
  if (!ensureCaptureExe()) return Promise.resolve("");
  return new Promise((resolve) => {
    const p = spawn(CAPTURE_EXE, args, { windowsHide: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    const timer = setTimeout(() => (p.kill(), resolve("")), timeoutMs);
    p.on("exit", () => (clearTimeout(timer), resolve(out)));
    p.on("error", () => (clearTimeout(timer), resolve("")));
  });
}

export async function pressKey(pid: number, name: string, holdMs = 120): Promise<boolean> {
  const vk = virtualKey(name);
  if (vk === undefined) return false;
  return /^OK/m.test(await runHelper(["key", String(pid), String(vk), String(holdMs)]));
}

// Asynchronous on purpose: a synchronous call would freeze this process, which then can't
// drain the game's output pipe, which can stall the game and hang the capture.
// "ok", or why there was nothing to capture.
export async function captureWindow(pid: number, file: string): Promise<"ok" | "minimized" | "nowindow" | "failed"> {
  const out = await runHelper([file, String(pid)]);
  return /^OK/m.test(out) ? "ok" : /^MINIMIZED/m.test(out) ? "minimized" : /^NOWINDOW/m.test(out) ? "nowindow" : "failed";
}

const ERROR_LINE = /\b(error|exception|fatal|failed|traceback|panic|uncaught|script_error|null instance|nullreference)\b/i;

// Lines engines print on every run that mention errors without being one (no VR headset,
// Unity's empty-path probe at start-up), so they don't drown out real problems.
const NOISE = [/OpenVR (Error|failed)|VRInitError/i, /CreateDirectory '' failed/i, /Failed to load 'openxr/i, /\bno error\b/i, /error_count[=:]\s*0\b/i];

export function errorLines(log: string): string[] {
  return log
    .split(/\r?\n/)
    .filter((l) => ERROR_LINE.test(l) && !NOISE.some((n) => n.test(l)) && !/^\s*$/.test(l))
    .slice(-30);
}

export function defaultShots(seconds: number): number[] {
  if (seconds <= 3) return [seconds - 0.5];
  return [Math.min(2, seconds / 3), seconds / 2, seconds - 0.5].map((s) => Math.round(s * 10) / 10);
}

// Each run gets its own folder; run.json records the project, so the gallery can show a
// project's play screenshots.
export function newRunDir(cwd: string): string {
  const dir = path.join(PLAY_DIR, new Date().toISOString().replace(/[:.]/g, "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ cwd: path.resolve(cwd) }));
  return dir;
}

// Screenshots from recent play runs of a project, newest first.
export function playShots(cwd: string, limit = 40): string[] {
  const want = path.resolve(cwd).toLowerCase();
  let runs: string[];
  try {
    runs = fs.readdirSync(PLAY_DIR).filter((d) => /^\d{4}-/.test(d)).sort().reverse().slice(0, 200);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const run of runs) {
    const dir = path.join(PLAY_DIR, run);
    const meta = readJSON(path.join(dir, "run.json"));
    if (!meta?.cwd || String(meta.cwd).toLowerCase() !== want) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".png")).sort()) out.push(path.join(dir, f));
    if (out.length >= limit) break;
  }
  return out;
}

function killTree(pid?: number) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else
    try {
      process.kill(-pid, "SIGKILL");
    } catch {}
}

export async function runNative(plan: PlayPlan, cwd: string, opts: PlayOptions, signal?: AbortSignal): Promise<PlayResult> {
  if (!plan.command) throw new Error(plan.note ?? "Nothing to run.");
  const seconds = Math.max(1, Math.min(120, opts.seconds ?? 8));
  const shots = (opts.shots?.length ? opts.shots : defaultShots(seconds)).filter((s) => s >= 0 && s <= seconds).sort((a, b) => a - b);
  const dir = newRunDir(cwd);
  let log = "";
  const child = spawn(plan.command, plan.args ?? [], { cwd, windowsHide: false, shell: process.platform === "win32" && !/\.exe$/i.test(plan.command) });
  const add = (d: Buffer) => {
    log += d.toString("utf8");
    if (log.length > 400_000) log = log.slice(-200_000);
  };
  child.stdout?.on("data", add);
  child.stderr?.on("data", add);
  let exitCode: number | null = null;
  const exited = new Promise<void>((r) => child.on("exit", (code) => ((exitCode = code), r())));
  child.on("error", (e) => (log += `\n[failed to start: ${e.message}]`));

  // Older Unity builds open a launcher dialog first; get past it before the clock starts.
  if (plan.engine === "Unity") {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline && exitCode === null && !signal?.aborted) {
      const out = await runHelper(["unity-dialog", String(child.pid)]);
      if (/^CLICKED/m.test(out)) {
        log += "\n[perch] pressed Play! in the Unity launcher dialog (windowed)\n";
        await new Promise((r) => setTimeout(r, 1500));
        break;
      }
      if (/^NODIALOG/m.test(out)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  const started = Date.now();
  const screenshots: string[] = [];
  // Screenshots and key presses on one timeline, in time order.
  const events = [
    ...shots.map((at, i) => ({ at, run: async () => {
      const file = path.join(dir, `shot-${i + 1}-${at}s.png`);
      const r = await captureWindow(child.pid!, file);
      if (r === "ok") screenshots.push(file);
      else if (r === "minimized") log += `${log.endsWith("\n") ? "" : "\n"}[perch] no screenshot at ${at}s: the game window was minimised (a fullscreen game minimises when it isn't the active window; set it to windowed mode)\n`;
    } })),
    ...(opts.keys ?? []).map((k) => ({ at: k.at, run: async () => {
      const ok = await pressKey(child.pid!, k.key);
      // On its own line, whatever the game was in the middle of printing.
      log += `${log.endsWith("\n") ? "" : "\n"}[perch] pressed ${k.key} at ${k.at}s${ok ? "" : " (failed: no game window, or an unknown key name)"}\n`;
    } })),
  ].sort((a, b) => a.at - b.at);
  for (const ev of events) {
    const wait = started + ev.at * 1000 - Date.now();
    if (wait > 0) await Promise.race([new Promise((r) => setTimeout(r, wait)), exited]);
    if (exitCode !== null || signal?.aborted) break;
    await ev.run();
  }
  const rest = started + seconds * 1000 - Date.now();
  if (rest > 0 && exitCode === null && !signal?.aborted) await Promise.race([new Promise((r) => setTimeout(r, rest)), exited]);
  const stopped = exitCode === null;
  if (stopped) killTree(child.pid);
  await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);

  // Godot also writes a log file; use it when stdout stayed empty.
  if (!log.trim() && plan.kind === "godot") log = readGodotLog(cwd) ?? "";
  fs.writeFileSync(path.join(dir, "log.txt"), log);
  return { plan, screenshots, log: log.slice(-12_000), errors: errorLines(log), exitCode, stopped, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

function readGodotLog(cwd: string): string | undefined {
  const name = /config\/name="([^"]+)"/.exec(fs.readFileSync(path.join(cwd, "project.godot"), "utf8"))?.[1];
  if (!name) return undefined;
  const f = path.join(process.env.APPDATA ?? "", "Godot", "app_userdata", name, "logs", "godot.log");
  try {
    return fs.readFileSync(f, "utf8");
  } catch {
    return undefined;
  }
}

export function formatResult(r: PlayResult): string {
  const lines = [
    `Ran ${r.plan.label} for ${r.seconds}s; ${r.stopped ? "it was still running and Perch closed it" : `it exited by itself with code ${r.exitCode}`}.`,
    r.screenshots.length ? `Screenshots (attached for you to look at if you can see images):\n${r.screenshots.join("\n")}` : "No screenshots were captured (no game window appeared).",
    r.golden?.length ? formatGolden(r.golden) : "",
    r.warnings?.length ? `Check these frames:\n${r.warnings.join("\n")}` : "",
    r.errors.length ? `Lines that look like errors:\n${r.errors.join("\n")}` : "No error lines in the log.",
    `Log (last part):\n${r.log.slice(-6000) || "(empty)"}`,
  ];
  return lines.filter(Boolean).join("\n\n");
}

// ---------- golden screenshots ----------
// A project's known-good screenshots live in .perch/golden/, named like the shots of a run
// (shot-1-2s.png…), so each new run's shots are compared with the golden ones taken at the same time.

export interface GoldenCheck {
  shot: string;
  golden: string;
  changedPercent: number; // 100 when sizes differ
}

export function goldenDir(cwd: string) {
  return path.join(cwd, ".perch", "golden");
}

export function saveGolden(cwd: string, shots: string[]): string[] {
  const dir = goldenDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return shots.map((s) => {
    const dest = path.join(dir, path.basename(s));
    fs.copyFileSync(s, dest);
    return dest;
  });
}

export async function compareGolden(cwd: string, shots: string[]): Promise<GoldenCheck[]> {
  const dir = goldenDir(cwd);
  if (!exists(dir)) return [];
  const { loadPng, diff } = await import("./imageinfo.js");
  const out: GoldenCheck[] = [];
  for (const s of shots) {
    const g = path.join(dir, path.basename(s));
    if (!exists(g)) continue;
    try {
      out.push({ shot: s, golden: g, changedPercent: diff(loadPng(s), loadPng(g)).changedPercent });
    } catch {}
  }
  return out;
}

export function formatGolden(checks: GoldenCheck[]): string {
  if (!checks.length) return "";
  return `Compared with the project's golden screenshots (.perch/golden):\n${checks
    .map((c) => `- ${path.basename(c.shot)}: ${c.changedPercent < 0.5 ? "matches" : `${c.changedPercent}% of pixels changed`}`)
    .join("\n")}\nChanges are expected where the game animates or where you meant to change something; anything else may be a regression.`;
}
