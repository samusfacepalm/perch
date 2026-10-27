// Runs web games (RPG Maker MZ/MV, Phaser, Vite projects…) in a window the app owns, so
// screenshots come straight from the page and the browser console becomes the game's log.

import { BrowserWindow } from "electron";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { defaultShots, errorLines, newRunDir, runNative, type PlayOptions, type PlayPlan, type PlayResult } from "../src/play.js";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".wasm": "application/wasm",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".txt": "text/plain",
};

// One static server per folder, reused across plays.
const servers = new Map<string, { port: number; server: http.Server }>();
async function serveFolder(root: string): Promise<number> {
  const existing = servers.get(root);
  if (existing) return existing.port;
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = path.join(root, rel.endsWith("/") ? rel + "index.html" : rel);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end("Not found");
      res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  servers.set(root, { port, server });
  return port;
}

// Dev servers (npm run dev) keep running between plays; they take a while to start.
const devServers = new Map<string, ChildProcess>();
async function ensureDevServer(cwd: string, command: string, url: string, log: (s: string) => void) {
  const up = async () => {
    try {
      return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  };
  if (await up()) return;
  if (!devServers.has(cwd)) {
    const child = spawn(command, { cwd, shell: true, windowsHide: true });
    child.stdout?.on("data", (d) => log(d.toString()));
    child.stderr?.on("data", (d) => log(d.toString()));
    child.on("exit", () => devServers.delete(cwd));
    devServers.set(cwd, child);
  }
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (await up()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`The dev server didn't answer at ${url} within 90 seconds.`);
}

export function stopWebServers() {
  for (const { server } of servers.values()) server.close();
  servers.clear();
  for (const c of devServers.values()) if (c.pid) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
  devServers.clear();
}

// Electron's key names for sendInputEvent are close to the DOM's; map the common differences.
const KEYS: Record<string, string> = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space", Esc: "Escape", Return: "Enter" };

async function runWeb(plan: PlayPlan, cwd: string, opts: PlayOptions, signal?: AbortSignal): Promise<PlayResult> {
  const seconds = Math.max(1, Math.min(120, opts.seconds ?? 8));
  const shots = (opts.shots?.length ? opts.shots : defaultShots(seconds)).filter((s) => s >= 0 && s <= seconds).sort((a, b) => a - b);
  const dir = newRunDir();
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(...s.split(/\r?\n/).filter(Boolean));
    if (lines.length > 3000) lines.splice(0, lines.length - 2000);
  };

  let url = plan.url!;
  if (plan.kind === "web") url = `http://127.0.0.1:${await serveFolder(plan.root!)}/${plan.url ?? "index.html"}`;
  else if (plan.devCommand) await ensureDevServer(cwd, plan.devCommand, url, log);

  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    title: `Perch is playing: ${plan.label}`,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("console-message", (e: any) => log(`[${e.level ?? "log"}] ${e.message}${e.sourceId ? ` (${path.basename(e.sourceId)}:${e.lineNumber})` : ""}`));
  win.webContents.on("did-fail-load", (_e, code, desc, failedUrl) => log(`[error] failed to load ${failedUrl}: ${desc} (${code})`));
  win.webContents.on("render-process-gone", (_e, d) => log(`[error] the game's page crashed: ${d.reason}`));
  win.webContents.on("preload-error", (_e, _p, err) => log(`[error] ${err.message}`));

  const started = Date.now();
  win.loadURL(url).catch((e) => log(`[error] ${e.message}`));
  const screenshots: string[] = [];
  const events = [
    ...shots.map((at, i) => ({ at, run: async () => {
      if (win.isDestroyed()) return;
      const img = await win.webContents.capturePage();
      const file = path.join(dir, `shot-${i + 1}-${at}s.png`);
      fs.writeFileSync(file, img.toPNG());
      screenshots.push(file);
    } })),
    ...(opts.keys ?? []).map((k) => ({ at: k.at, run: async () => {
      if (win.isDestroyed()) return;
      const keyCode = KEYS[k.key] ?? k.key;
      win.webContents.sendInputEvent({ type: "keyDown", keyCode });
      if (keyCode.length === 1) win.webContents.sendInputEvent({ type: "char", keyCode });
      await new Promise((r) => setTimeout(r, 120));
      win.webContents.sendInputEvent({ type: "keyUp", keyCode });
    } })),
  ].sort((a, b) => a.at - b.at);

  for (const ev of events) {
    const wait = started + ev.at * 1000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (signal?.aborted || win.isDestroyed()) break;
    await ev.run().catch((e) => log(`[perch] ${e.message}`));
  }
  const rest = started + seconds * 1000 - Date.now();
  if (rest > 0 && !signal?.aborted && !win.isDestroyed()) await new Promise((r) => setTimeout(r, rest));
  const closedByPlayer = win.isDestroyed();
  if (!win.isDestroyed()) win.destroy();

  const text = lines.join("\n");
  fs.writeFileSync(path.join(dir, "log.txt"), text);
  return { plan, screenshots, log: text.slice(-12_000), errors: errorLines(text), exitCode: closedByPlayer ? 0 : null, stopped: !closedByPlayer, seconds: Math.round((Date.now() - started) / 100) / 10 };
}

export async function runPlay(plan: PlayPlan, cwd: string, opts: PlayOptions, signal?: AbortSignal): Promise<PlayResult> {
  if (plan.kind === "web" || plan.kind === "devserver") return runWeb(plan, cwd, opts, signal);
  return runNative(plan, cwd, opts, signal);
}
