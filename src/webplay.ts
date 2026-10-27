// Headless web play: outside the desktop app, web games and pages run in a headless Chrome or
// Edge that Perch starts for the run, driven over the DevTools protocol. Each run gets its own
// browser, profile and port, and Perch closes only that browser, by its own process ID.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { defaultShots, errorLines, newRunDir, type PlayOptions, type PlayPlan, type PlayResult } from "./play.js";
import { webUrl } from "./webserve.js";

export function findBrowser(): string | undefined {
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    process.env.PERCH_BROWSER,
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

// DOM key name → what Input.dispatchKeyEvent needs.
function keyInfo(name: string): { key: string; code: string; vk: number; text?: string } {
  const named: Record<string, [string, string, number, string?]> = {
    Space: [" ", "Space", 32, " "], " ": [" ", "Space", 32, " "], Enter: ["Enter", "Enter", 13, "\r"], Return: ["Enter", "Enter", 13, "\r"],
    Escape: ["Escape", "Escape", 27], Esc: ["Escape", "Escape", 27], Tab: ["Tab", "Tab", 9], Backspace: ["Backspace", "Backspace", 8],
    Shift: ["Shift", "ShiftLeft", 16], Control: ["Control", "ControlLeft", 17], Alt: ["Alt", "AltLeft", 18],
    ArrowLeft: ["ArrowLeft", "ArrowLeft", 37], ArrowUp: ["ArrowUp", "ArrowUp", 38], ArrowRight: ["ArrowRight", "ArrowRight", 39], ArrowDown: ["ArrowDown", "ArrowDown", 40],
  };
  if (named[name]) {
    const [key, code, vk, text] = named[name];
    return { key, code, vk, text };
  }
  const f = /^F(\d{1,2})$/.exec(name);
  if (f) return { key: name, code: name, vk: 111 + Number(f[1]) };
  if (/^[a-z]$/i.test(name)) return { key: name.toLowerCase(), code: `Key${name.toUpperCase()}`, vk: name.toUpperCase().charCodeAt(0), text: name.toLowerCase() };
  if (/^\d$/.test(name)) return { key: name, code: `Digit${name}`, vk: name.charCodeAt(0), text: name };
  return { key: name, code: name, vk: 0 };
}

class Cdp {
  private n = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  constructor(private ws: WebSocket, onEvent: (method: string, params: any) => void) {
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === undefined) return onEvent(msg.method, msg.params);
      const w = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      if (msg.error) w?.reject(new Error(msg.error.message));
      else w?.resolve(msg.result);
    });
  }
  static async connect(url: string, onEvent: (method: string, params: any) => void) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("Couldn't connect to the headless browser.")), { once: true });
    });
    return new Cdp(ws, onEvent);
  }
  call(method: string, params: object = {}): Promise<any> {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function describeArg(a: any): string {
  if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
  return a.description ?? a.type ?? "";
}

export async function runWebHeadless(plan: PlayPlan, cwd: string, opts: PlayOptions, signal?: AbortSignal): Promise<PlayResult> {
  const exe = findBrowser();
  if (!exe) throw new Error("No Chrome or Edge found to run the page in. Install one, or set PERCH_BROWSER to its path.");
  const seconds = Math.max(1, Math.min(120, opts.seconds ?? 8));
  const shots = (opts.shots?.length ? opts.shots : defaultShots(seconds)).filter((s) => s >= 0 && s <= seconds).sort((a, b) => a - b);
  const dir = newRunDir(cwd);
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(...s.split(/\r?\n/).filter(Boolean));
    if (lines.length > 3000) lines.splice(0, lines.length - 2000);
  };
  const url = await webUrl(plan, cwd, log);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "perch-play-"));
  const child = spawn(
    exe,
    [
      "--headless=new",
      "--remote-debugging-port=0", // the browser picks a free port and writes it to DevToolsActivePort
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      "--ignore-gpu-blocklist",
      "--enable-unsafe-swiftshader", // software WebGL when there's no GPU to use
      "--window-size=1280,720",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  let cdp: Cdp | undefined;
  const started = Date.now();
  const screenshots: string[] = [];
  try {
    const portFile = path.join(profile, "DevToolsActivePort");
    let port = 0;
    for (let i = 0; i < 100 && !port; i++) {
      if (child.exitCode !== null) throw new Error(`The headless browser exited straight away (code ${child.exitCode}).`);
      if (fs.existsSync(portFile)) port = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]) || 0;
      if (!port) await sleep(100);
    }
    if (!port) throw new Error("The headless browser didn't start within 10 seconds.");
    const targets: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === "page");
    if (!page) throw new Error("The headless browser opened no page.");

    cdp = await Cdp.connect(page.webSocketDebuggerUrl, (method, p) => {
      if (method === "Runtime.consoleAPICalled") {
        const where = p.stackTrace?.callFrames?.[0];
        const level = p.type === "warning" ? "warn" : p.type;
        log(`[${level}] ${p.args.map(describeArg).join(" ")}${where?.url ? ` (${path.basename(where.url)}:${where.lineNumber + 1})` : ""}`);
      } else if (method === "Runtime.exceptionThrown") {
        const d = p.exceptionDetails;
        log(`[error] ${d.exception?.description ?? d.text}${d.url ? ` (${path.basename(d.url)}:${d.lineNumber + 1})` : ""}`);
      } else if (method === "Log.entryAdded") {
        log(`[${p.entry.level}] ${p.entry.text}${p.entry.url ? ` (${p.entry.url})` : ""}`);
      }
    });
    await cdp.call("Runtime.enable");
    await cdp.call("Log.enable");
    await cdp.call("Page.enable");
    await cdp.call("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true }); // so key presses reach the page
    const nav = await cdp.call("Page.navigate", { url });
    if (nav.errorText) log(`[error] failed to load ${url}: ${nav.errorText}`);

    const c = cdp;
    const events = [
      ...shots.map((at, i) => ({ at, run: async () => {
        const r = await c.call("Page.captureScreenshot", { format: "png" });
        const file = path.join(dir, `shot-${i + 1}-${at}s.png`);
        fs.writeFileSync(file, Buffer.from(r.data, "base64"));
        screenshots.push(file);
      } })),
      ...(opts.keys ?? []).map((k) => ({ at: k.at, run: async () => {
        const { key, code, vk, text } = keyInfo(k.key);
        await c.call("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode: vk, text });
        await sleep(120);
        await c.call("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk });
      } })),
    ].sort((a, b) => a.at - b.at);
    for (const ev of events) {
      const wait = started + ev.at * 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      if (signal?.aborted) break;
      await ev.run().catch((e) => log(`[perch] ${e.message}`));
    }
    const rest = started + seconds * 1000 - Date.now();
    if (rest > 0 && !signal?.aborted) await sleep(rest);
  } finally {
    cdp?.close();
    if (child.pid && child.exitCode === null) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGKILL");
    }
    // The browser lets go of its profile a moment after it exits.
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(200);
      }
    }
  }

  const text = lines.join("\n");
  fs.writeFileSync(path.join(dir, "log.txt"), text);
  return { plan, screenshots, log: text.slice(-12_000), errors: errorLines(text), exitCode: null, stopped: true, seconds: Math.round((Date.now() - started) / 100) / 10 };
}
