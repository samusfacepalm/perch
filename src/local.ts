// Local models: finds GGUF files on disk and runs them with llama.cpp's llama-server, which
// speaks the OpenAI format, so a local model works like any other provider.
//
// The scan skips system and build folders and stops five folders deep (deeper in known model
// folders). Results are cached in ~/.perch/local-models.json; rescan from the app when needed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { HOME } from "./config.js";

export interface LocalModel {
  path: string;
  name: string; // file name without .gguf
  sizeGB: number;
  mmproj?: string; // vision projector in the same folder, if any
  arch?: string; // general.architecture from the GGUF header
  title?: string; // general.name
  context?: number; // trained context length
}

// Reads the GGUF header (key/value metadata, not the weights) and reports the architecture,
// the model's own name, its context length, and whether it carries a chat template, which is
// what separates chat models from the diffusion, VAE and 3D models that also ship as GGUF.
export async function ggufInfo(file: string): Promise<{ arch?: string; title?: string; context?: number; chat: boolean }> {
  const fh = await fs.promises.open(file, "r");
  let buf = Buffer.alloc(0);
  let pos = 0;
  let filePos = 0;
  const need = async (n: number) => {
    while (buf.length - pos < n) {
      const chunk = Buffer.alloc(Math.max(1 << 20, n));
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, filePos);
      if (!bytesRead) throw new Error("eof");
      filePos += bytesRead;
      buf = Buffer.concat([buf.subarray(pos), chunk.subarray(0, bytesRead)]);
      pos = 0;
    }
  };
  const u32 = async () => (await need(4), (pos += 4), buf.readUInt32LE(pos - 4));
  const u64 = async () => (await need(8), (pos += 8), Number(buf.readBigUInt64LE(pos - 8)));
  const str = async () => {
    const n = await u64();
    await need(n);
    pos += n;
    return buf.toString("utf8", pos - n, pos);
  };
  const SIZES: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  const value = async (type: number): Promise<unknown> => {
    if (type === 8) return str();
    if (type === 9) {
      const inner = await u32();
      const n = await u64();
      if (inner === 8) for (let i = 0; i < n; i++) await str();
      else {
        await need(n * (SIZES[inner] ?? 0));
        pos += n * (SIZES[inner] ?? 0);
      }
      return undefined;
    }
    const size = SIZES[type];
    if (size === undefined) throw new Error("bad type");
    await need(size);
    pos += size;
    if (type === 4) return buf.readUInt32LE(pos - 4);
    if (type === 10) return Number(buf.readBigUInt64LE(pos - 8));
    return undefined;
  };
  const out: { arch?: string; title?: string; context?: number; chat: boolean } = { chat: false };
  try {
    await need(4);
    if (buf.toString("ascii", 0, 4) !== "GGUF") return out;
    pos = 4;
    await u32(); // version
    await u64(); // tensor count
    const kvs = await u64();
    for (let i = 0; i < kvs && filePos < 64 << 20; i++) {
      const key = await str();
      const v = await value(await u32());
      if (key === "general.architecture") out.arch = v as string;
      else if (key === "general.name") out.title = v as string;
      else if (key === "tokenizer.chat_template") out.chat = true;
      else if (out.arch && key === `${out.arch}.context_length`) out.context = v as number;
    }
  } catch {
    // a truncated or unusual header: keep what was read
  } finally {
    await fh.close();
  }
  return out;
}

const CACHE = path.join(HOME, "local-models.json");
const SKIP = new Set([
  "windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information",
  "node_modules", ".git", ".venv", "venv", "__pycache__", "site-packages", ".cache\\pip", "appdata", "steamapps",
  "recovery", "msocache", "perflogs", ".npm", ".nuget", ".gradle", ".cargo", ".rustup", "library",
]);
// Places model files usually live; searched deeper than the rest of the disk.
const KNOWN = [
  path.join(os.homedir(), ".cache", "llama.cpp"),
  path.join(os.homedir(), ".cache", "huggingface"),
  path.join(os.homedir(), ".lmstudio", "models"),
  path.join(os.homedir(), ".cache", "lm-studio", "models"),
  path.join(os.homedir(), ".unsloth"),
  path.join(os.homedir(), "models"),
  path.join(os.homedir(), "AppData", "Local", "nomic.ai"),
  path.join(os.homedir(), "AppData", "Local", "llama.cpp"),
];

function drives(): string[] {
  if (process.platform !== "win32") return [os.homedir()];
  const out: string[] = [];
  for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
    const root = `${letter}:\\`;
    try {
      fs.accessSync(root);
      out.push(root);
    } catch {}
  }
  return out;
}

export async function scanGguf(onProgress?: (dir: string) => void): Promise<LocalModel[]> {
  const found = new Map<string, LocalModel>();
  const visit = async (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    onProgress?.(dir);
    const ggufs = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".gguf"));
    const mmproj = ggufs.find((e) => /mmproj/i.test(e.name));
    for (const e of ggufs) {
      if (/mmproj/i.test(e.name)) continue;
      // Split models (-00002-of-00003) are loaded from their first part.
      const part = /-(\d{5})-of-\d{5}\.gguf$/i.exec(e.name);
      if (part && part[1] !== "00001") continue;
      const full = path.join(dir, e.name);
      try {
        const size = (await fs.promises.stat(full)).size;
        if (size < 50_000_000) continue; // tokenizer vocab files and the like
        found.set(full.toLowerCase(), {
          path: full,
          name: e.name.replace(/(-\d{5}-of-\d{5})?\.gguf$/i, ""),
          sizeGB: Math.round((size / 1e9) * 10) / 10,
          mmproj: mmproj ? path.join(dir, mmproj.name) : undefined,
        });
      } catch {}
    }
    if (depth <= 0) return;
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP.has(e.name.toLowerCase()))
        .map((e) => visit(path.join(dir, e.name), depth - 1)),
    );
  };
  await Promise.all([...drives().map((d) => visit(d, 5)), ...KNOWN.map((d) => visit(d, 8))]);
  // Keep chat models only.
  const models: LocalModel[] = [];
  for (const m of found.values()) {
    const info = await ggufInfo(m.path);
    if (!info.chat) continue;
    models.push({ ...m, arch: info.arch, title: info.title, context: info.context });
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ scanned: new Date().toISOString(), models }, null, 1));
  return models;
}

export function cachedGguf(): { scanned?: string; models: LocalModel[] } {
  try {
    return JSON.parse(fs.readFileSync(CACHE, "utf8"));
  } catch {
    return { models: [] };
  }
}

export function findLlamaServer(): string | undefined {
  const own = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(HOME, "config.json"), "utf8")).llamaServer;
    } catch {
      return undefined;
    }
  })();
  if (own && fs.existsSync(own)) return own;
  const r = spawnSync(process.platform === "win32" ? "where" : "which", ["llama-server"], { encoding: "utf8" });
  const hit = r.stdout?.split(/\r?\n/).find((l) => l.trim());
  if (hit?.trim()) return hit.trim();
  // Unsloth Studio ships its own build.
  const unsloth = path.join(os.homedir(), ".unsloth", "llama.cpp", "build", "bin", "Release", "llama-server.exe");
  return fs.existsSync(unsloth) ? unsloth : undefined;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export interface RunningServer {
  model: LocalModel;
  port: number;
  baseURL: string;
  process: ChildProcess;
  log: string[];
}

const running = new Map<string, RunningServer>();

export function runningServers(): RunningServer[] {
  return [...running.values()];
}

// Starts llama-server for a model and resolves once it answers. Context defaults to 32K and all
// layers go to the GPU when there is one (llama.cpp falls back to CPU by itself).
export async function startLlamaServer(model: LocalModel, opts: { context?: number; gpuLayers?: number } = {}): Promise<RunningServer> {
  const existing = running.get(model.path);
  if (existing && existing.process.exitCode === null) return existing;
  const exe = findLlamaServer();
  if (!exe) throw new Error("llama-server was not found. Install llama.cpp (winget install ggml.llamacpp) or set \"llamaServer\" in ~/.perch/config.json.");
  const port = await freePort();
  const args = ["-m", model.path, "--port", String(port), "--host", "127.0.0.1", "-c", String(opts.context ?? 32768), "-ngl", String(opts.gpuLayers ?? 999), "--jinja"];
  if (model.mmproj) args.push("--mmproj", model.mmproj);
  const child = spawn(exe, args, { windowsHide: true });
  const log: string[] = [];
  const keep = (d: Buffer) => {
    for (const line of d.toString().split(/\r?\n/)) if (line.trim()) log.push(line);
    if (log.length > 200) log.splice(0, log.length - 200);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const server: RunningServer = { model, port, baseURL: `http://127.0.0.1:${port}/v1`, process: child, log };
  running.set(model.path, server);
  child.on("exit", () => running.delete(model.path));

  // Loading a big model can take a while; wait up to five minutes for /health to say ok.
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`llama-server exited while loading:\n${log.slice(-12).join("\n")}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return server;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("llama-server did not become ready within five minutes.");
}

export function stopLlamaServer(modelPath: string) {
  const s = running.get(modelPath);
  if (!s) return;
  if (process.platform === "win32" && s.process.pid) spawnSync("taskkill", ["/pid", String(s.process.pid), "/T", "/F"], { stdio: "ignore" });
  else s.process.kill();
  running.delete(modelPath);
}

export function stopAllLlamaServers() {
  for (const p of [...running.keys()]) stopLlamaServer(p);
}
