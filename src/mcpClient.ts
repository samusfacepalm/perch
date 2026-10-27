// Perch as an MCP client: uses the MCP servers already set up for OpenCode and Claude Code.
//
// Servers start lazily, the first time the model asks for one, so opening Perch costs nothing
// however many servers are configured. The model sees two small tools (mcp_tools to browse,
// mcp_call to run) instead of every server's schemas, which would bloat every request.
// Images that tools return are saved to ~/.perch/mcp-images, where the screenshot gallery
// picks them up.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { HOME } from "./config.js";

export interface ServerConfig {
  name: string;
  source: string; // "OpenCode", "Claude Code", "project"
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const PROTOCOL = "2025-06-18";
export const IMAGE_DIR = path.join(HOME, "mcp-images");

function readJSON(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

const expand = (v: string) => v.replace(/\{env:([A-Za-z0-9_]+)\}|\$\{([A-Za-z0-9_]+)\}/g, (_, a, b) => process.env[a ?? b] ?? "");
const expandAll = (o?: Record<string, string>) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, expand(String(v))])) : undefined);

// Every MCP server configured for OpenCode or Claude Code (user and project scope), minus Perch itself.
export function configuredServers(cwd: string): ServerConfig[] {
  const out = new Map<string, ServerConfig>();
  const add = (name: string, c: ServerConfig) => {
    if (name === "perch" || (c.args ?? []).some((a) => /perch\.mjs|[\\/]harness[\\/]bin/i.test(a))) return;
    out.set(name, c);
  };
  const fromClaude = (servers: any, source: string) => {
    for (const [name, s] of Object.entries<any>(servers ?? {})) {
      if (s?.disabled) continue;
      if (s.url) add(name, { name, source, type: "http", url: expand(s.url), headers: expandAll(s.headers) });
      else if (s.command) add(name, { name, source, type: "stdio", command: s.command, args: (s.args ?? []).map(String), env: expandAll(s.env) });
    }
  };

  const oc = readJSON(path.join(os.homedir(), ".config", "opencode", "opencode.json"));
  for (const [name, s] of Object.entries<any>(oc?.mcp ?? {})) {
    if (s?.enabled === false) continue;
    if (s.type === "remote" && s.url) add(name, { name, source: "OpenCode", type: "http", url: expand(s.url), headers: expandAll(s.headers) });
    else if (s.type === "local" && Array.isArray(s.command)) add(name, { name, source: "OpenCode", type: "stdio", command: s.command[0], args: s.command.slice(1), env: expandAll(s.environment) });
  }

  const cc = readJSON(path.join(os.homedir(), ".claude.json"));
  fromClaude(cc?.mcpServers, "Claude Code");
  const projectKey = Object.keys(cc?.projects ?? {}).find((k) => path.resolve(k).toLowerCase() === path.resolve(cwd).toLowerCase());
  if (projectKey) fromClaude(cc.projects[projectKey]?.mcpServers, "Claude Code (project)");
  fromClaude(readJSON(path.join(cwd, ".mcp.json"))?.mcpServers, "project .mcp.json");
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class Connection {
  private proc?: ChildProcess;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private sessionId?: string;
  private buffer = "";
  instructions?: string;
  tools?: McpTool[];
  error?: string;

  constructor(readonly cfg: ServerConfig) {}

  async start() {
    if (this.cfg.type === "stdio") {
      // npx, uvx and similar are .cmd shims on Windows and need a shell to start.
      // Through a shell the arguments must be quoted by hand, or paths with spaces break apart.
      const needsShell = process.platform === "win32" && !/\.exe$/i.test(this.cfg.command!);
      const quote = (a: string) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
      const opts = { env: { ...process.env, ...this.cfg.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
      this.proc = needsShell
        ? spawn([this.cfg.command!, ...(this.cfg.args ?? [])].map(quote).join(" "), { ...opts, shell: true })
        : spawn(this.cfg.command!, this.cfg.args ?? [], opts);
      this.proc.stdout!.on("data", (d: Buffer) => {
        this.buffer += d.toString("utf8");
        let nl: number;
        while ((nl = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (line) this.onMessage(line);
        }
      });
      let stderr = "";
      this.proc.stderr!.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
      this.proc.on("exit", (code) => {
        const err = new Error(`MCP server "${this.cfg.name}" exited (code ${code}). ${stderr.slice(-500)}`);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
        this.proc = undefined;
      });
    }
    const init = await this.request("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "perch", version: "0.1.0" },
    }, 90_000); // first runs of npx/uvx servers download packages
    this.instructions = init?.instructions;
    await this.notify("notifications/initialized");
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.request("tools/list", cursor ? { cursor } : {});
      tools.push(...(r?.tools ?? []));
      cursor = r?.nextCursor;
    } while (cursor);
    this.tools = tools;
  }

  private onMessage(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  }

  private async notify(method: string, params?: object) {
    const body = { jsonrpc: "2.0", method, ...(params ? { params } : {}) };
    if (this.cfg.type === "stdio") this.proc?.stdin?.write(JSON.stringify(body) + "\n");
    else await this.post(body).catch(() => {});
  }

  request(method: string, params: object = {}, timeoutMs = 300_000): Promise<any> {
    const id = this.nextId++;
    const body = { jsonrpc: "2.0", id, method, params };
    if (this.cfg.type === "http") return this.post(body, timeoutMs);
    if (!this.proc) return Promise.reject(new Error(`MCP server "${this.cfg.name}" is not running.`));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server "${this.cfg.name}" did not answer ${method} within ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin!.write(JSON.stringify(body) + "\n");
    });
  }

  // Streamable HTTP: the reply is JSON, or an SSE stream carrying the JSON-RPC response.
  private async post(body: any, timeoutMs = 300_000): Promise<any> {
    const res = await fetch(this.cfg.url!, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": PROTOCOL,
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.cfg.headers,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (body.id === undefined) return;
    if (!res.ok) throw new Error(`MCP server "${this.cfg.name}" returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const type = res.headers.get("content-type") ?? "";
    let msg: any;
    if (type.includes("text/event-stream")) {
      const text = await res.text();
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try {
          const m = JSON.parse(line.slice(5).trim());
          if (m.id === body.id) msg = m;
        } catch {}
      }
    } else msg = await res.json();
    if (!msg) throw new Error(`MCP server "${this.cfg.name}" sent no reply to ${body.method}.`);
    if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
    return msg.result;
  }

  stop() {
    if (this.proc?.pid && process.platform === "win32") spawnSync("taskkill", ["/pid", String(this.proc.pid), "/T", "/F"], { stdio: "ignore" });
    else this.proc?.kill();
    this.proc = undefined;
  }
}

// One connection per server per process, shared by every session in it.
const connections = new Map<string, Promise<Connection>>();

export async function connect(cfg: ServerConfig): Promise<Connection> {
  const key = `${cfg.name}|${cfg.command ?? cfg.url}`;
  let p = connections.get(key);
  if (!p) {
    p = (async () => {
      const c = new Connection(cfg);
      await c.start();
      return c;
    })();
    connections.set(key, p);
    p.catch(() => connections.delete(key)); // let a later call retry
  }
  return p;
}

export function stopAllMcp() {
  for (const p of connections.values()) p.then((c) => c.stop()).catch(() => {});
  connections.clear();
}

export interface CallResult {
  text: string;
  images: string[]; // saved file paths
  isError: boolean;
}

export async function callTool(cfg: ServerConfig, tool: string, args: unknown): Promise<CallResult> {
  const c = await connect(cfg);
  const r = await c.request("tools/call", { name: tool, arguments: args ?? {} });
  const parts: string[] = [];
  const images: string[] = [];
  for (const item of r?.content ?? []) {
    if (item.type === "text") parts.push(item.text);
    else if (item.type === "image" && item.data) {
      fs.mkdirSync(IMAGE_DIR, { recursive: true });
      const ext = (item.mimeType ?? "image/png").split("/")[1]?.replace("jpeg", "jpg") ?? "png";
      const file = path.join(IMAGE_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${cfg.name}-${tool}.${ext}`.replace(/[^\w.\-\\/:]/g, "_"));
      fs.writeFileSync(file, Buffer.from(item.data, "base64"));
      images.push(file);
    } else if (item.type === "resource") parts.push(item.resource?.text ?? `[resource ${item.resource?.uri}]`);
    else if (item.type === "resource_link") parts.push(`[resource ${item.uri}]`);
  }
  if (r?.structuredContent && !parts.length) parts.push(JSON.stringify(r.structuredContent, null, 2));
  return { text: parts.join("\n"), images, isError: !!r?.isError };
}
