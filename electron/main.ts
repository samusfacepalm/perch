// Electron main process. It owns the agents (the same Agent class the terminal UI uses)
// and talks to the window over IPC. Each open session has its own agent, so several
// sessions can work at the same time.

import { app, BrowserWindow, dialog, ipcMain, shell, nativeTheme, protocol } from "electron";
import fs from "node:fs";

import path from "node:path";
import { Agent, type Decision } from "../src/agent.js";
import { discoverLocal, fetchModels, loadConfig, modelChoices, removeKey, resolveModel, saveKey, type PerchConfig } from "../src/config.js";
import { isDeepSeekPeak } from "../src/pricing.js";
import { knownProjects } from "../src/projects.js";
import { loadAgents, loadInstructions, loadSkills } from "../src/instructions.js";
import { configuredServers, stopAllMcp } from "../src/mcpClient.js";
import { isImage, listShots, saveAttachment } from "../src/shots.js";
import { compareGolden, detectPlay, saveGolden } from "../src/play.js";
import { diffMask, imageInfo, listAssets } from "../src/assets.js";
import { installBuiltins } from "../src/builtin.js";
import { runPlay, stopWebServers } from "./playWeb.js";
import { cachedGguf, runningServers, scanGguf, startLlamaServer, stopAllLlamaServers, stopLlamaServer, type RunningServer } from "../src/local.js";
import { deleteSession, flushSaves, listSessions, loadSession, makeScratchDir, newSession, saveSession, saveSessionSoon, type Session } from "../src/session.js";

let win: BrowserWindow | null = null;
let config: PerchConfig;
const agents = new Map<string, Agent>();
const pendingAsks = new Map<number, (d: Decision) => void>();
let askId = 0;

function send(sessionId: string, type: string, data: Record<string, unknown> = {}) {
  flushStream(sessionId); // keep streamed text ahead of whatever follows it
  win?.webContents.send("event", { sessionId, type, ...data });
}

// Streamed tokens arrive dozens of times a second. Sending each one over IPC and re-rendering
// for it is what makes chat apps stutter, so text is batched and sent about 30 times a second.
const streamBuf = new Map<string, { text: string; reasoning: string; timer?: NodeJS.Timeout }>();
function queueStream(sessionId: string, kind: "text" | "reasoning", delta: string) {
  let b = streamBuf.get(sessionId);
  if (!b) streamBuf.set(sessionId, (b = { text: "", reasoning: "" }));
  b[kind] += delta;
  b.timer ??= setTimeout(() => flushStream(sessionId), 33);
}
function flushStream(sessionId: string) {
  const b = streamBuf.get(sessionId);
  if (!b) return;
  streamBuf.delete(sessionId);
  if (b.timer) clearTimeout(b.timer);
  if (b.text || b.reasoning) win?.webContents.send("event", { sessionId, type: "stream", text: b.text, reasoning: b.reasoning });
}

function snapshot(agent: Agent) {
  const s = agent.session;
  let context = 0;
  try {
    context = resolveModel(config, s.model).model.context;
  } catch {}
  return {
    id: s.id,
    title: s.title,
    cwd: s.cwd,
    scratch: s.scratch,
    model: s.model,
    history: s.history,
    todos: s.todos,
    usage: s.usage,
    compactions: s.compactions,
    compactAt: Math.min(context * config.compactAt, config.compactTokens),
    contextTokens: agent.contextTokens,
    contextWindow: context,
    busy: agent.busy,
  };
}

function agentFor(session: Session): Agent {
  const existing = agents.get(session.id);
  if (existing) return existing;
  const id = session.id;
  const agent = new Agent({
    config,
    session,
    autoContinue: false,
    save: saveSessionSoon,
    playRunner: runPlay,
    events: {
      onStream: (e) => {
        if (e.type === "text") queueStream(id, "text", e.delta);
        else if (e.type === "reasoning") queueStream(id, "reasoning", e.delta);
        else if (e.type === "retry") send(id, "status", { text: `Retrying (${e.attempt}) in ${Math.round(e.waitMs / 1000)}s: ${e.error.slice(0, 140)}` });
      },
      onMessage: (m) => send(id, "message", { message: m }),
      onToolStart: (call, summary) => send(id, "toolStart", { call, summary }),
      onToolEnd: (call, result) => {
        send(id, "toolEnd", { call, result });
        if (call.function.name === "todowrite") send(id, "todos", { todos: session.todos });
      },
      onStatus: (text) => send(id, "status", { text }),
      ask: (tool, summary, args) =>
        new Promise<Decision>((resolve) => {
          const reqId = ++askId;
          pendingAsks.set(reqId, resolve);
          send(id, "ask", { reqId, tool, summary, args });
          // Bring the window forward so a waiting permission prompt isn't missed.
          if (win && !win.isFocused()) win.flashFrame(true);
        }),
    },
  });
  agents.set(id, agent);
  return agent;
}

function getAgent(id: string): Agent {
  const a = agents.get(id) ?? agentFor(loadSession(id));
  return a;
}

let localReady: Promise<unknown> = Promise.resolve();

// Reload providers in place, so agents that hold the config object see new keys at once.
async function reloadConfig() {
  const fresh = loadConfig();
  await discoverLocal(fresh);
  for (const s of runningServers()) addServerProvider(fresh, s);
  Object.assign(config, fresh);
}

// A llama-server Perch started becomes a provider of its own, named after the model.
function addServerProvider(c: PerchConfig, s: RunningServer) {
  const id = "gguf-" + s.model.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  c.providers[id] = {
    id,
    name: `${s.model.title ?? s.model.name} (llama.cpp)`,
    baseURL: s.baseURL,
    local: true,
    models: [{ id: s.model.name, name: s.model.title ?? s.model.name, context: Math.min(s.model.context ?? 32768, 32768), output: 8192, reasoning: true, vision: !!s.model.mmproj }],
  };
  return `${id}/${s.model.name}`;
}

function localState() {
  const cache = cachedGguf();
  const running = new Map(runningServers().map((s) => [s.model.path, s]));
  return {
    scanned: cache.scanned ?? null,
    models: cache.models.map((m) => ({ ...m, running: running.has(m.path), port: running.get(m.path)?.port ?? null })),
  };
}

// Totals across every saved session, for the usage panel. Uses the cached session summaries,
// so it costs almost nothing after the first call.
function allUsage() {
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 86400_000).toISOString();
  const total = { cost: 0, input: 0, output: 0, cacheHit: 0, sessions: 0 };
  const day = { cost: 0, input: 0, output: 0 };
  const week = { cost: 0, input: 0, output: 0 };
  for (const { usage: u, updated } of listSessions()) {
    if (!u) continue;
    total.sessions++;
    total.cost += u.cost ?? 0;
    total.input += u.input;
    total.output += u.output;
    total.cacheHit += u.cacheHit;
    // Sessions are dated by their last activity, which is close enough for a running total.
    if (updated.startsWith(today)) Object.assign(day, { cost: day.cost + (u.cost ?? 0), input: day.input + u.input, output: day.output + u.output });
    if (updated >= weekAgo) Object.assign(week, { cost: week.cost + (u.cost ?? 0), input: week.input + u.input, output: week.output + u.output });
  }
  return { total, day, week, deepseekPeak: isDeepSeekPeak() };
}

function registerIpc() {
  // The window gets what it needs at once; local models are added when the scan finishes.
  ipcMain.handle("init", () => {
    localReady.then(() => send("*", "models", { models: modelChoices(config) }));
    return { models: modelChoices(config), defaultModel: config.model, sessions: listSessions() };
  });

  ipcMain.handle("models:list", () => modelChoices(config));

  ipcMain.handle("keys:list", () =>
    Object.values(config.providers).map((p) => ({
      id: p.id,
      name: p.name,
      baseURL: p.baseURL,
      keySource: p.keySource ?? null,
      local: !!p.local,
      models: p.models.length,
    })),
  );

  // Check the key by asking the provider for its model list, then save it and reload.
  ipcMain.handle("keys:save", async (_e, opts: { id: string; key: string; baseURL?: string; name?: string }) => {
    const existing = config.providers[opts.id];
    const baseURL = opts.baseURL || existing?.baseURL;
    if (!baseURL) throw new Error("A base URL is needed for a custom provider.");
    let models: string[] = [];
    let warning = "";
    try {
      models = await fetchModels(baseURL, opts.key.trim());
    } catch (err: any) {
      // Some providers don't offer GET /models; a 401/403 means the key itself is bad.
      if (/^40[13]/.test(String(err?.message))) throw new Error(`The provider rejected this key (${err.message.slice(0, 160)})`);
      warning = `Saved, but the model list could not be fetched: ${String(err?.message ?? err).slice(0, 160)}`;
    }
    const custom = !existing || opts.baseURL;
    saveKey(opts.id, opts.key.trim(), {
      ...(custom ? { baseURL, name: opts.name || existing?.name || opts.id } : {}),
      ...(existing?.fixedModels ? {} : { models }),
    });
    await reloadConfig();
    return { models, warning };
  });

  ipcMain.handle("keys:remove", async (_e, id: string) => {
    removeKey(id);
    await reloadConfig();
  });

  ipcMain.handle("usage:all", () => allUsage());

  ipcMain.handle("local:list", () => localState());

  // The Play button: same runner the agent's play tool uses.
  ipcMain.handle("play:detect", (_e, id: string) => detectPlay(getAgent(id).session.cwd));
  ipcMain.handle("play:run", async (_e, id: string, opts: { seconds?: number }) => {
    const a = getAgent(id);
    const plan = detectPlay(a.session.cwd);
    if (plan.kind === "none" || plan.kind === "unity") throw new Error(plan.note ?? "Nothing to run.");
    send(id, "status", { text: `Playing ${plan.label}…` });
    try {
      const r = await runPlay(plan, a.session.cwd, { seconds: opts?.seconds ?? 8 });
      r.golden = await compareGolden(a.session.cwd, r.screenshots);
      return r;
    } finally {
      send(id, "status", { text: "" });
    }
  });

  ipcMain.handle("golden:save", (_e, id: string, shots: string[]) => saveGolden(getAgent(id).session.cwd, shots));
  ipcMain.handle("image:info", (_e, file: string, frame?: { w: number; h: number }) => {
    try {
      return imageInfo(file, frame);
    } catch (e: any) {
      return { error: String(e?.message ?? e) };
    }
  });
  ipcMain.handle("image:diff", (_e, a: string, b: string) => {
    try {
      return diffMask(a, b);
    } catch (e: any) {
      return { error: String(e?.message ?? e) };
    }
  });
  ipcMain.handle("assets:list", (_e, id: string) => listAssets(getAgent(id).session.cwd));

  ipcMain.handle("shots:list", async (_e, id: string) => {
    const a = getAgent(id);
    return listShots(a.session.cwd, a.session.history, new Date(a.session.created).getTime());
  });
  ipcMain.handle("attach:save", (_e, bytes: Uint8Array, mime: string) => saveAttachment(bytes, mime));
  ipcMain.handle("file:reveal", (_e, p: string) => shell.showItemInFolder(p));

  ipcMain.handle("setup:for", (_e, cwd: string) => ({
    instructions: loadInstructions(cwd).map((f) => ({ path: f.path, kind: f.kind, chars: f.text.length })),
    skills: loadSkills(cwd).map((s) => ({ name: s.name, source: s.source })),
    agents: loadAgents(cwd).map((a) => ({ name: a.name, model: a.model ?? null })),
    mcp: configuredServers(cwd).map((s) => ({ name: s.name, source: s.source, target: s.url ?? [s.command, ...(s.args ?? [])].join(" ") })),
  }));
  ipcMain.handle("local:scan", async () => {
    await scanGguf();
    return localState();
  });
  ipcMain.handle("local:start", async (_e, modelPath: string) => {
    const model = cachedGguf().models.find((m) => m.path === modelPath);
    if (!model) throw new Error("Model not found; scan again.");
    const server = await startLlamaServer(model);
    const ref = addServerProvider(config, server);
    send("*", "models", { models: modelChoices(config) });
    return { ref, state: localState() };
  });
  ipcMain.handle("local:stop", (_e, modelPath: string) => {
    stopLlamaServer(modelPath);
    for (const [id, p] of Object.entries(config.providers)) if (id.startsWith("gguf-") && !runningServers().some((s) => s.baseURL === p.baseURL)) delete config.providers[id];
    send("*", "models", { models: modelChoices(config) });
    return localState();
  });

  ipcMain.handle("projects:list", () => knownProjects());

  ipcMain.handle("sessions:list", () => listSessions());

  ipcMain.handle("session:new", (_e, opts: { cwd: string | null; model?: string }) => {
    const scratch = !opts.cwd;
    const s = newSession(opts.cwd ?? makeScratchDir(), opts.model ?? config.model, scratch);
    saveSession(s); // synchronous, so the session list includes it straight away
    return snapshot(agentFor(s));
  });

  ipcMain.handle("session:open", (_e, id: string) => snapshot(getAgent(id)));

  ipcMain.handle("session:delete", (_e, id: string) => {
    const a = agents.get(id);
    if (a?.busy) a.abort();
    agents.delete(id);
    deleteSession(id);
    return listSessions();
  });

  ipcMain.handle("session:setModel", (_e, id: string, model: string) => {
    resolveModel(config, model); // throws on an unknown model
    const a = getAgent(id);
    a.session.model = model;
    saveSessionSoon(a.session);
    return snapshot(a);
  });

  ipcMain.handle("session:setCwd", (_e, id: string, cwd: string) => {
    const a = getAgent(id);
    a.session.cwd = cwd;
    a.session.scratch = false;
    saveSessionSoon(a.session);
    return snapshot(a);
  });

  ipcMain.handle("session:setAuto", (_e, id: string, on: boolean) => {
    getAgent(id).opts.autoContinue = on;
    return on;
  });

  ipcMain.handle("folder:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle("folder:open", (_e, dir: string) => shell.openPath(dir));

  ipcMain.handle("agent:send", async (_e, id: string, text: string, images?: string[]) => {
    const a = getAgent(id);
    if (a.busy) throw new Error("This session is already working.");
    send(id, "busy", { busy: true });
    try {
      await a.run(text, images?.filter(isImage));
    } catch (err: any) {
      if (err?.name !== "AbortError") send(id, "error", { text: String(err?.message ?? err) });
      else send(id, "status", { text: "Interrupted." });
    } finally {
      send(id, "busy", { busy: false });
      send(id, "snapshot", { snapshot: snapshot(a) });
      flushSaves(); // write now, so the list below shows the new title
      send("*", "sessions", { sessions: listSessions() });
    }
  });

  ipcMain.handle("agent:abort", (_e, id: string) => agents.get(id)?.abort());

  ipcMain.handle("agent:compact", async (_e, id: string) => {
    const a = getAgent(id);
    send(id, "busy", { busy: true });
    try {
      await a.compact();
    } catch (err: any) {
      send(id, "error", { text: `Compaction failed: ${err?.message ?? err}` });
    } finally {
      send(id, "busy", { busy: false });
      send(id, "snapshot", { snapshot: snapshot(a) });
    }
  });

  ipcMain.handle("permission:answer", (_e, reqId: number, decision: Decision) => {
    pendingAsks.get(reqId)?.(decision);
    pendingAsks.delete(reqId);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false, // shown on ready-to-show, so there is no blank flash
    minWidth: 760,
    minHeight: 500,
    title: "Perch",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#14171a" : "#f7f5f0",
    icon: path.join(__dirname, "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.once("ready-to-show", () => win?.show());
  win.loadFile(path.join(__dirname, "index.html"));
  // Links in replies open in the real browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("focus", () => win?.flashFrame(false));
  win.on("closed", () => (win = null));
}

app.setAppUserModelId("Perch");

// A separate profile for development, so a test window can run beside the real one.
if (process.env.PERCH_DEV_PROFILE) app.setPath("userData", path.join(app.getPath("temp"), "perch-dev-profile"));

// One copy of Perch at a time: launching it again brings the open window forward.
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

// perch-file://img/?p=<encoded path> serves local images to the window. Images only, so the
// page can never read other files through it.
protocol.registerSchemesAsPrivileged([{ scheme: "perch-file", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

app.whenReady().then(() => {
  installBuiltins();
  protocol.handle("perch-file", (req) => {
    const file = new URL(req.url).searchParams.get("p") ?? "";
    if (!isImage(file) && !/\.(ogg|wav|mp3|m4a|flac)$/i.test(file)) return new Response("Not an image or sound", { status: 403 });
    // Node's reader copes with paths past Windows' 260-character limit; Chromium's doesn't.
    const ext = file.split(".").pop()!.toLowerCase();
    const audio: Record<string, string> = { ogg: "audio/ogg", wav: "audio/wav", mp3: "audio/mpeg", m4a: "audio/mp4", flac: "audio/flac" };
    const type = audio[ext] ?? (ext === "jpg" || ext === "jpeg" ? "image/jpeg" : `image/${ext}`);
    return fs.promises
      .readFile(file)
      .then((buf) => new Response(buf, { headers: { "content-type": type, "cache-control": "max-age=60" } }))
      .catch(() => new Response("Not found", { status: 404 }));
  });
  config = loadConfig();
  localReady = discoverLocal(config);
  registerIpc();
  createWindow();
});

app.on("before-quit", () => {
  for (const a of agents.values()) if (a.busy) a.abort();
  flushSaves();
  stopAllLlamaServers();
  stopAllMcp();
  stopWebServers();
  for (const a of agents.values()) saveSession(a.session);
});

app.on("window-all-closed", () => app.quit());
