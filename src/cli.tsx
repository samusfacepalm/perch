import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { render } from "ink";
import { loadConfig, listModels, resolveModel } from "./config.js";
import { listSessions, loadSession, makeScratchDir, newSession, type Session } from "./session.js";
import { Agent } from "./agent.js";
import { App } from "./ui/App.js";

const HELP = `perch - a terminal coding agent for DeepSeek, OpenCode Go and other OpenAI-compatible models
(c) Feisty Parrot Studios. MIT licence.

Usage:
  perch [prompt]                 start in the current folder (optionally with a first message)
  perch -n, --no-folder          start in a fresh scratch folder under ~/.perch/scratch
  perch -c, --continue           resume the most recent session in this folder
  perch -r, --resume <id>        resume a session by id
  perch -p, --print "<task>"     run one task without the UI, print the result, exit
  perch sessions                 list sessions for this folder (--all for every folder)
  perch models                   list known models and which have keys
  perch app                      open the desktop app
  perch mcp                      run as an MCP server (lets Claude Code delegate work)

Options:
  -m, --model <provider/model>   model to use, e.g. deepseek/deepseek-v4.1-pro
  -d, --dir <folder>             work in this folder instead of the current one
      --yolo                     approve every tool call without asking
      --auto                     keep going when the model stops with open todos (default with -p)
  -h, --help`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "no-folder": { type: "boolean", short: "n" },
    continue: { type: "boolean", short: "c" },
    resume: { type: "string", short: "r" },
    print: { type: "string", short: "p" },
    model: { type: "string", short: "m" },
    dir: { type: "string", short: "d" },
    yolo: { type: "boolean" },
    auto: { type: "boolean" },
    all: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

async function main() {
  if (values.help) return console.log(HELP);
  (await import("./builtin.js")).installBuiltins();
  const config = loadConfig();

  if (positionals[0] === "mcp") {
    const { runMcpServer } = await import("./mcp.js");
    return runMcpServer();
  }

  if (positionals[0] === "app") {
    // Launch the Electron app detached, so this terminal is free again at once.
    const { createRequire } = await import("node:module");
    const { spawn, execFileSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    if (!fs.existsSync(path.join(root, "app-dist", "main.cjs"))) execFileSync(process.execPath, [path.join(root, "scripts", "build-app.mjs")], { cwd: root, stdio: "inherit" });
    const electron: string = createRequire(import.meta.url)("electron");
    spawn(electron, [root], { cwd: root, detached: true, stdio: "ignore" }).unref();
    return;
  }

  if (positionals[0] === "models") {
    for (const p of Object.values(config.providers)) {
      console.log(`${p.name} (${p.id})  ${p.baseURL}  key: ${p.keySource ?? "none"}`);
      for (const m of p.models) console.log(`  ${p.id}/${m.id}  ctx ${Math.round(m.context / 1000)}k${m.reasoning ? "  reasoning" : ""}`);
    }
    return;
  }
  if (positionals[0] === "sessions") {
    for (const s of listSessions(values.all ? undefined : process.cwd())) {
      console.log(`${s.id}  ${s.updated.slice(0, 16).replace("T", " ")}  ${String(s.messages).padStart(4)} msgs  ${s.title}${values.all ? `  (${s.cwd})` : ""}`);
    }
    return;
  }

  let session: Session;
  if (values.resume) session = loadSession(values.resume);
  else if (values.continue) {
    const last = listSessions(values.dir ?? process.cwd())[0];
    if (!last) throw new Error("No earlier session in this folder.");
    session = loadSession(last.id);
  } else {
    const scratch = !!values["no-folder"];
    const cwd = scratch ? makeScratchDir() : path.resolve(values.dir ?? process.cwd());
    if (!fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
    session = newSession(cwd, values.model ?? config.model, scratch);
  }
  if (values.model) session.model = values.model;
  resolveModel(config, session.model); // fail early on a bad model name

  const firstPrompt = values.print ?? (positionals.length ? positionals.join(" ") : undefined);

  if (values.print !== undefined) {
    const agent = new Agent({
      config,
      session,
      yolo: !!values.yolo,
      autoContinue: values.auto ?? true,
      events: {
        onStream: (e) => {
          if (e.type === "text") process.stdout.write(e.delta);
        },
        onToolStart: (c, s) => process.stderr.write(`\n> ${c.function.name} ${s}\n`),
        onToolEnd: (_c, r) => {
          if (r.error) process.stderr.write(`  ! ${r.output.split("\n")[0].slice(0, 200)}\n`);
        },
        onStatus: (t) => process.stderr.write(`\n[${t}]\n`),
        ask: async (tool, summary) => {
          process.stderr.write(`  (denied ${tool} ${summary}: run with --yolo to allow tools that ask)\n`);
          return { allow: false, feedback: "Running non-interactively; this action needs approval. Do what you can without it and report what is left." };
        },
      },
    });
    try {
      await agent.run(firstPrompt!);
    } finally {
      // MCP servers the run started are child processes; stop them so the command can exit.
      (await import("./mcpClient.js")).stopAllMcp();
    }
    const u = session.usage;
    process.stderr.write(`\n\n[session ${session.id} | in ${u.input} (cached ${u.cacheHit}) out ${u.output}]\n`);
    return;
  }

  const app = render(<App config={config} session={session} yolo={!!values.yolo} autoContinue={!!values.auto} firstPrompt={firstPrompt} models={listModels(config)} />, {
    exitOnCtrlC: false,
  });
  await app.waitUntilExit();
  (await import("./mcpClient.js")).stopAllMcp();
  console.log(`\nSession ${session.id} saved. Resume with: perch -r ${session.id}`);
  if (session.scratch) console.log(`Scratch folder: ${session.cwd}`);
}

main().catch((e) => {
  console.error(e?.message ?? e);
  // exitCode rather than exit(): exiting while fetch sockets close crashes libuv on Windows.
  process.exitCode = 1;
});
