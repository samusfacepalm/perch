// Serving web games for play: a static server per folder, and the project's own dev server
// (npm run dev) when it has one. Shared by the desktop app's play window and the headless runner.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".wasm": "application/wasm",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".txt": "text/plain",
  ".glb": "model/gltf-binary", ".gltf": "model/gltf+json", ".hdr": "application/octet-stream",
};

// One static server per folder, reused across plays.
const servers = new Map<string, { port: number; server: http.Server }>();
export async function serveFolder(root: string): Promise<number> {
  root = path.resolve(root);
  const existing = servers.get(root);
  if (existing) return existing.port;
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = path.join(root, rel.endsWith("/") ? rel + "index.html" : rel);
    if (!file.startsWith(root)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      // A missing favicon isn't the game's error; don't let it show up as one.
      if (err) return rel === "/favicon.ico" ? res.writeHead(204).end() : res.writeHead(404).end("Not found");
      res.writeHead(200, { "content-type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-store" });
      res.end(data);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  server.unref(); // don't keep the CLI alive for it
  const port = (server.address() as net.AddressInfo).port;
  servers.set(root, { port, server });
  return port;
}

// Dev servers keep running between plays; they take a while to start.
const devServers = new Map<string, ChildProcess>();
export async function ensureDevServer(cwd: string, command: string, url: string, log: (s: string) => void) {
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

// Stops only the servers Perch started, by their own process IDs.
export function stopWebServers() {
  for (const { server } of servers.values()) server.close();
  servers.clear();
  for (const c of devServers.values()) if (c.pid) spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { stdio: "ignore" });
  devServers.clear();
}

// The address to load for a web plan, starting whatever server it needs.
export async function webUrl(plan: { kind: string; url?: string; root?: string; devCommand?: string }, cwd: string, log: (s: string) => void): Promise<string> {
  if (plan.kind === "web" && plan.root) return `http://127.0.0.1:${await serveFolder(plan.root)}/${(plan.url ?? "index.html").replace(/\\/g, "/")}`;
  if (plan.devCommand) await ensureDevServer(cwd, plan.devCommand, plan.url!, log);
  return plan.url!;
}
