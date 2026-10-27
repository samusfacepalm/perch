// Runs web games (RPG Maker MZ/MV, Phaser, Vite projects…) in a window the app owns, so
// screenshots come straight from the page and the browser console becomes the game's log.

import { BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { defaultShots, errorLines, newRunDir, runNative, type PlayOptions, type PlayPlan, type PlayResult } from "../src/play.js";
import { webUrl } from "../src/webserve.js";
export { stopWebServers } from "../src/webserve.js";

// Electron's key names for sendInputEvent are close to the DOM's; map the common differences.
const KEYS: Record<string, string> = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", " ": "Space", Esc: "Escape", Return: "Enter" };

async function runWeb(plan: PlayPlan, cwd: string, opts: PlayOptions, signal?: AbortSignal): Promise<PlayResult> {
  const seconds = Math.max(1, Math.min(120, opts.seconds ?? 8));
  const shots = (opts.shots?.length ? opts.shots : defaultShots(seconds)).filter((s) => s >= 0 && s <= seconds).sort((a, b) => a - b);
  const dir = newRunDir(cwd);
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(...s.split(/\r?\n/).filter(Boolean));
    if (lines.length > 3000) lines.splice(0, lines.length - 2000);
  };

  const url = await webUrl(plan, cwd, log);

  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    title: `Perch is playing: ${plan.label}`,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("console-message", (e: any) => {
    // Electron's own development banner isn't the game's output.
    if (/^Electron Security Warning/.test(e.message ?? "")) return;
    log(`[${e.level ?? "log"}] ${e.message}${e.sourceId ? ` (${path.basename(e.sourceId)}:${e.lineNumber})` : ""}`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, failedUrl) => log(`[error] failed to load ${failedUrl}: ${desc} (${code})`));
  win.webContents.on("render-process-gone", (_e, d) => log(`[error] the game's page crashed: ${d.reason}`));
  win.webContents.on("preload-error", (_e, _p, err) => log(`[error] ${err.message}`));

  const started = Date.now();
  win.loadURL(url).catch((e) => log(`[error] ${e.message}`));
  const screenshots: string[] = [];
  const events = [
    ...shots.map((at, i) => ({ at, run: async () => {
      if (win.isDestroyed()) return;
      if (opts.script) {
        try {
          const v = await win.webContents.executeJavaScript(opts.script, true);
          if (v !== undefined) log(`[script] ${typeof v === "string" ? v : JSON.stringify(v)}`.slice(0, 2000));
        } catch (e: any) {
          log(`[error] script: ${e?.message ?? e}`);
        }
        // Let the page draw the change before the shot.
        await win.webContents.executeJavaScript("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))", true).catch(() => {});
        if (win.isDestroyed()) return;
      }
      const z = opts.zoom;
      let img = await win.webContents.capturePage(z ? { x: z.x, y: z.y, width: z.width, height: z.height } : undefined);
      if (z) img = img.resize({ width: z.width * 2, height: z.height * 2, quality: "best" });
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
