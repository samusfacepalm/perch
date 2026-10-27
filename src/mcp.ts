// `perch mcp`: a Model Context Protocol server over stdio, so Claude Code (or any MCP client)
// can hand bulk work to a cheaper model. The client writes the brief; a Perch agent does the
// work headless and returns its report, the files it changed and what it cost.
//
// Safety: there is no human at the keyboard during a delegated run, so permissions are decided
// by the call's arguments instead of prompts:
//   - read, glob, grep, list, todowrite: always allowed
//   - write and edit: only with allow_edits, and only inside the working folder
//   - bash: only allowlisted commands, or any command with allow_bash
//   - play: only with allow_play (it launches the game)
// The MCP client (Claude Code) shows its user each call before it runs.

import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { Agent } from "./agent.js";
import { loadConfig, discoverLocal, modelChoices, resolveModel } from "./config.js";
import { newSession, saveSession } from "./session.js";
import { stopAllMcp } from "./mcpClient.js";

const PROTOCOL = "2025-06-18";

const TOOLS = [
  {
    name: "delegate",
    description: `Hand a self-contained task to a cheaper model (DeepSeek by default) running as a full coding agent with read, search, edit and shell tools. It returns the agent's final report, the files it changed, and the cost.

Good for bulk or mechanical work that doesn't need your judgement: renames across many files, writing boilerplate or tests from a clear pattern, summarising or searching a large codebase, converting formats, first drafts you will review.

The agent sees nothing of your conversation. Write the prompt as a complete brief: the goal, the files or area, conventions to follow, how to verify, and what the report must contain. Check its work afterwards; do not take the report on trust.`,
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The complete brief" },
        cwd: { type: "string", description: "Absolute path of the folder to work in" },
        model: { type: "string", description: "provider/model, e.g. deepseek/deepseek-flash (cheapest) or deepseek/deepseek-v4-pro. Default: Perch's configured model." },
        allow_edits: { type: "boolean", description: "Allow write and edit inside cwd. Default false (read-only)." },
        allow_bash: { type: "boolean", description: "Allow any shell command. Default false: only allowlisted read-only commands such as git status." },
        allow_play: { type: "boolean", description: "Allow the play tool, which launches the game, screenshots it and reads its log. Default false." },
        max_steps: { type: "number", description: "Step limit for this run. Default 150." },
      },
      required: ["prompt", "cwd"],
    },
  },
  {
    name: "list_models",
    description: "List the models Perch can delegate to, with which have keys.",
    inputSchema: { type: "object", properties: {} },
  },
];

function inside(root: string, p: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(root, p));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function delegate(args: any) {
  const config = loadConfig();
  await discoverLocal(config);
  if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt is required");
  const cwd = path.resolve(String(args.cwd ?? ""));
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`cwd is not a folder: ${cwd}`);
  const model = args.model ?? config.model;
  resolveModel(config, model);
  config.maxSteps = Math.max(5, Math.min(1000, Number(args.max_steps) || 150));

  const session = newSession(cwd, model);
  session.title = "[delegated] " + args.prompt.replace(/\s+/g, " ").slice(0, 50);
  const changed = new Set<string>();
  const denied: string[] = [];
  const log: string[] = [];

  const agent = new Agent({
    config,
    session,
    autoContinue: true,
    events: {
      onToolEnd: (call, r) => {
        let a: any = {};
        try {
          a = JSON.parse(call.function.arguments || "{}");
        } catch {}
        if ((call.function.name === "write" || call.function.name === "edit") && !r.error && a.path) changed.add(path.relative(cwd, path.resolve(cwd, a.path)) || a.path);
        log.push(`${r.error ? "!" : "-"} ${call.function.name} ${String(a.path ?? a.command ?? a.pattern ?? a.description ?? "").slice(0, 100)}`);
      },
      ask: async (tool, summary, a) => {
        if ((tool === "write" || tool === "edit") && args.allow_edits && typeof a.path === "string" && inside(cwd, a.path)) return { allow: true };
        if (tool === "bash" && args.allow_bash) return { allow: true };
        if (tool === "play" && args.allow_play) return { allow: true };
        denied.push(`${tool} ${summary}`.slice(0, 160));
        const why =
          tool === "bash"
            ? "Shell commands beyond the read-only allowlist are not permitted in this delegated run."
            : tool === "play"
              ? "Running the game is not permitted in this delegated run."
              : args.allow_edits
              ? "Edits outside the working folder are not permitted."
              : "This delegated run is read-only.";
        return { allow: false, feedback: `${why} Do what you can without it, and list what is left in your report.` };
      },
    },
  });

  const started = Date.now();
  const report = await agent.run(args.prompt);
  saveSession(session);
  const u = session.usage;
  const lines = [
    report || "(no report)",
    "",
    "---",
    `Model: ${model} · ${Math.round((Date.now() - started) / 1000)}s · ${log.length} tool calls · cost ${u.cost !== undefined ? "$" + u.cost.toFixed(4) : "unknown"} · input ${u.input} (cached ${u.cacheHit}) · output ${u.output}`,
    `Files changed: ${changed.size ? [...changed].join(", ") : "none"}`,
  ];
  if (denied.length) lines.push(`Denied: ${denied.join("; ")}`);
  lines.push(`Perch session: ${session.id}`);
  return lines.join("\n");
}

export async function runMcpServer() {
  const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = readline.createInterface({ input: process.stdin });
  // Logging must go to stderr: stdout carries the protocol.
  console.log = (...a: unknown[]) => process.stderr.write(a.join(" ") + "\n");

  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const { id, method, params } = msg;
    if (id === undefined) continue; // notifications need no reply
    const reply = (result: object) => send({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });
    try {
      switch (method) {
        case "initialize":
          reply({
            protocolVersion: params?.protocolVersion ?? PROTOCOL,
            capabilities: { tools: {} },
            serverInfo: { name: "perch", version: "0.1.0" },
            instructions: "Use delegate to hand self-contained, well-specified bulk work to a cheaper model. Always review what it did.",
          });
          break;
        case "ping":
          reply({});
          break;
        case "tools/list":
          reply({ tools: TOOLS });
          break;
        case "tools/call": {
          const name = params?.name;
          const args = params?.arguments ?? {};
          // Calls run concurrently, so several delegated tasks can work at once.
          void (async () => {
            try {
              const text =
                name === "delegate"
                  ? await delegate(args)
                  : name === "list_models"
                    ? await (async () => {
                        const c = loadConfig();
                        await discoverLocal(c);
                        return modelChoices(c).map((m) => `${m.ref}  ${m.name}${m.hasKey ? "" : "  (no key)"}`).join("\n");
                      })()
                    : null;
              if (text === null) return fail(-32602, `Unknown tool: ${name}`);
              reply({ content: [{ type: "text", text }] });
            } catch (err: any) {
              reply({ content: [{ type: "text", text: `Error: ${err?.message ?? err}` }], isError: true });
            }
          })();
          break;
        }
        default:
          fail(-32601, `Method not found: ${method}`);
      }
    } catch (err: any) {
      fail(-32603, String(err?.message ?? err));
    }
  }
  // The client hung up: stop any MCP servers delegated runs started.
  stopAllMcp();
}
