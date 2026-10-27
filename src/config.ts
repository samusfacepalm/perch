// Loads providers, models and API keys.
//
// Keys are never copied anywhere. They are looked up at start-up, in this order:
//   1. an environment variable (DEEPSEEK_API_KEY, OPENCODE_GO_API_KEY, ...)
//   2. OpenCode's auth.json  (~/.local/share/opencode/auth.json)
//   3. OpenCode's opencode.json provider options (apiKey, with {env:NAME} expansion)
// Perch's own settings live in ~/.perch/config.json and win over everything else.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Price } from "./pricing.js";

export interface ModelInfo {
  id: string; // id sent to the API
  name: string;
  context: number; // context window in tokens
  output: number; // max output tokens
  reasoning: boolean;
  vision?: boolean; // accepts images
}

export interface Provider {
  id: string;
  name: string;
  baseURL: string;
  apiKey?: string;
  keySource?: string; // where the key came from, for /status (never the key itself)
  models: ModelInfo[];
  // Extra fields merged into every request body, e.g. { thinking: { type: "enabled" } }.
  extraBody?: Record<string, unknown>;
  // Header that carries the session id, for providers that route or cache by session.
  sessionHeader?: string;
  // The built-in model list is complete: model names from OpenCode's config are ignored,
  // because the API rejects anything else. Perch's own config can still add models.
  fixedModels?: boolean;
  local?: boolean; // runs on this machine: free, and no key needed
}

export interface PerchConfig {
  model: string; // "provider/model"
  smallModel?: string; // used for titles and compaction summaries
  providers: Record<string, Provider>;
  permissions: Record<string, "allow" | "ask" | "deny">;
  bashAllow: string[]; // command prefixes that never ask
  maxSteps: number;
  compactAt: number; // fraction of the context window that triggers compaction
  // Hard ceiling on context before compaction, even for 1M-token models: answers get worse
  // and every step gets dearer as the context grows, long before the window is full.
  compactTokens: number;
  // Idle compaction: a session left alone this long, with at least this much context, is
  // summarised (by the app's hourly check, or when you come back to it). DeepSeek's cache has
  // expired by then, so the next message would otherwise pay full price for the whole context.
  idleCompact: boolean;
  idleCompactHours: number;
  idleCompactMinTokens: number;
  prices?: Record<string, Price>;
}

export const HOME = path.join(os.homedir(), ".perch");
const OPENCODE_AUTH = path.join(os.homedir(), ".local", "share", "opencode", "auth.json");
const OPENCODE_CONFIG = path.join(os.homedir(), ".config", "opencode", "opencode.json");
const PERCH_AUTH = path.join(HOME, "auth.json");

function readJSON(file: string): any {
  try {
    // opencode.jsonc may hold comments; strip // and /* */ outside strings well enough for config files.
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    try {
      return JSON.parse(text);
    } catch {
      return JSON.parse(text.replace(/\/\*[\s\S]*?\*\/|(^|[^:"])\/\/.*$/gm, "$1"));
    }
  } catch {
    return undefined;
  }
}

function expandEnv(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/\{env:([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? "");
}

const model = (id: string, name: string, context: number, output: number, reasoning: boolean): ModelInfo => ({
  id,
  name,
  context,
  output,
  reasoning,
});

// Providers Perch knows without any config. Model lists are starting points:
// OpenCode's config and Perch's own config add to them.
// "kimi-k3.1-pro" -> "Kimi K3.1 Pro", "glm-5.3-flash" -> "GLM 5.3 Flash".
const ACRONYMS = new Set(["glm", "gpt", "hy", "oss"]);
const BRANDS: Record<string, string> = { deepseek: "DeepSeek", minimax: "MiniMax", mimo: "MiMo", longcat: "LongCat", qwen: "Qwen" };
export function prettyName(id: string): string {
  return id
    .split("-")
    .map((w) => BRANDS[w] ?? (ACRONYMS.has(w) ? w.toUpperCase() : /^[a-z]\d/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// DeepSeek's API accepts only these names (checked against the live API, Oct 2026).
// The OpenCode Go list is the models.dev entry for its OpenAI-compatible route;
// models it serves through Anthropic- or Google-format routes are left out.
function builtinProviders(): Record<string, Provider> {
  const M = 1_048_576;
  const go = (id: string, reasoning = true, context = 200_000) => model(id, prettyName(id), context, 32_000, reasoning);
  return {
    deepseek: {
      id: "deepseek",
      name: "DeepSeek",
      baseURL: "https://api.deepseek.com",
      fixedModels: true,
      models: [
        { ...model("deepseek-flash", "DeepSeek V4.1 Flash (1017)", M, 393_216, true), vision: true },
        model("deepseek-v4-pro", "DeepSeek V4 Pro (0813)", M, 393_216, true),
        { ...model("deepseek-v4-flash", "DeepSeek V4 Flash (old name, now V4.1 Flash)", M, 393_216, true), vision: true },
      ],
    },
    "opencode-go": {
      id: "opencode-go",
      name: "OpenCode Go",
      baseURL: "https://opencode.ai/inference/go/openai/v1",
      // Go asks clients for their own user agent and a stable session id (opencode.ai/docs/go).
      sessionHeader: "x-opencode-session",
      // Go's /models also lists models served only through its Anthropic and Google routes,
      // which this OpenAI-format client can't call, so the curated list stands.
      fixedModels: true,
      models: [
        go("deepseek-v4-pro", true, M),
        go("deepseek-v4.1-flash", true, M),
        go("glm-5.3"),
        go("glm-5.3-flash"),
        go("glm-5.2"),
        go("kimi-k3.1-pro"),
        go("kimi-k3"),
        go("kimi-k2.7-code"),
        go("mimo-v2.6-pro"),
        go("mimo-v2.6-flash"),
        go("minimax-m3.1-flash"),
        go("longcat-2.0"),
        go("step-5-preview"),
        go("hy4-preview"),
      ],
    },
    "ollama-cloud": {
      id: "ollama-cloud",
      name: "Ollama Cloud",
      baseURL: "https://ollama.com/v1",
      models: [],
    },
    openrouter: {
      id: "openrouter",
      name: "OpenRouter",
      baseURL: "https://openrouter.ai/api/v1",
      models: [],
    },
  };
}

const ENV_KEYS: Record<string, string[]> = {
  deepseek: ["DEEPSEEK_API_KEY"],
  "opencode-go": ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"],
  "ollama-cloud": ["OLLAMA_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
};

function mergeModels(provider: Provider, models: Record<string, any> | undefined) {
  if (!models) return;
  for (const [id, m] of Object.entries(models)) {
    const existing = provider.models.find((x) => x.id === id);
    const info = model(
      id,
      m?.name ?? existing?.name ?? id,
      m?.limit?.context ?? existing?.context ?? 128_000,
      m?.limit?.output ?? existing?.output ?? 16_384,
      m?.reasoning ?? existing?.reasoning ?? /reason|think|r1/i.test(id),
    );
    if (existing) Object.assign(existing, info);
    else provider.models.push(info);
  }
}

export function loadConfig(): PerchConfig {
  const providers = builtinProviders();

  // OpenCode's providers: reuse their base URLs and model lists.
  const oc = readJSON(OPENCODE_CONFIG) ?? readJSON(OPENCODE_CONFIG + "c");
  for (const [id, p] of Object.entries<any>(oc?.provider ?? {})) {
    if (!p || typeof p !== "object") continue;
    const target = (providers[id] ??= { id, name: p.name ?? id, baseURL: "", models: [] });
    if (p.options?.baseURL) target.baseURL = p.options.baseURL;
    const key = expandEnv(p.options?.apiKey);
    if (key) {
      target.apiKey = key;
      target.keySource = "opencode.json";
    }
    if (!target.fixedModels) mergeModels(target, p.models);
  }

  // OpenCode's stored logins.
  const auth = readJSON(OPENCODE_AUTH) ?? {};
  for (const [id, entry] of Object.entries<any>(auth)) {
    if (entry?.type === "api" && entry.key && providers[id] && !providers[id].apiKey) {
      providers[id].apiKey = entry.key;
      providers[id].keySource = "opencode auth.json";
    }
  }

  // Perch's own config.
  const own = readJSON(path.join(HOME, "config.json")) ?? {};
  for (const [id, p] of Object.entries<any>(own.providers ?? {})) {
    const target = (providers[id] ??= { id, name: p.name ?? id, baseURL: "", models: [] });
    if (p.name) target.name = p.name;
    if (p.baseURL) target.baseURL = p.baseURL;
    if (p.apiKey) {
      target.apiKey = expandEnv(p.apiKey);
      target.keySource = "perch config.json";
    }
    if (p.extraBody) target.extraBody = p.extraBody;
    if (p.sessionHeader) target.sessionHeader = p.sessionHeader;
    mergeModels(target, p.models);
  }

  // Environment variables beat stored keys, so a rotated key in the environment always wins.
  for (const [id, names] of Object.entries(ENV_KEYS)) {
    for (const name of names) {
      if (process.env[name] && providers[id]) {
        providers[id].apiKey = process.env[name];
        providers[id].keySource = `$${name}`;
        break;
      }
    }
  }

  // Keys imported through Perch beat everything, including the environment: importing a key
  // is a deliberate act, and a stale environment variable must not silently override it.
  for (const [id, entry] of Object.entries<any>(readJSON(PERCH_AUTH) ?? {})) {
    if (!entry?.key) continue;
    const target = (providers[id] ??= { id, name: entry.name ?? id, baseURL: entry.baseURL ?? "", models: [] });
    if (entry.baseURL) target.baseURL = entry.baseURL;
    target.apiKey = entry.key;
    target.keySource = "perch auth.json";
    for (const m of entry.models ?? []) if (!target.models.some((x) => x.id === m)) target.models.push(model(m, prettyName(m), 128_000, 16_384, false));
  }

  for (const [id, p] of Object.entries(providers)) {
    if (/localhost|127\.0\.0\.1|\[::1\]/.test(p.baseURL)) p.local = true;
    // Perch speaks the OpenAI chat format only; Anthropic-format endpoints are skipped.
    if (!p.baseURL || /\/anthropic(\/|$)/.test(p.baseURL)) delete providers[id];
  }

  return {
    model: own.model ?? "deepseek/deepseek-v4-pro",
    smallModel: own.smallModel ?? "deepseek/deepseek-flash",
    providers,
    permissions: {
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      todowrite: "allow",
      task: "allow",
      skill: "allow",
      mcp_tools: "allow",
      mcp_call: "ask",
      play: "ask",
      inspect_image: "allow",
      write: "ask",
      edit: "ask",
      bash: "ask",
      ...(own.permissions ?? {}),
    },
    bashAllow: own.bashAllow ?? [
      "ls", "pwd", "cat", "head", "tail", "wc", "git status", "git diff", "git log", "git show",
      "npm test", "npm run", "npx tsc", "node --version", "python --version",
    ],
    maxSteps: own.maxSteps ?? 400,
    compactAt: own.compactAt ?? 0.8,
    compactTokens: own.compactTokens ?? 200_000,
    idleCompact: own.idleCompact ?? true,
    idleCompactHours: own.idleCompactHours ?? 2.5,
    idleCompactMinTokens: own.idleCompactMinTokens ?? 500_000,
    prices: own.prices,
  };
}

export function resolveModel(config: PerchConfig, ref: string): { provider: Provider; model: ModelInfo } {
  const slash = ref.indexOf("/");
  if (slash < 0) throw new Error(`Model must look like provider/model, got "${ref}"`);
  const providerId = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const provider = config.providers[providerId];
  if (!provider) throw new Error(`Unknown provider "${providerId}". Known: ${Object.keys(config.providers).join(", ")}`);
  const found = provider.models.find((m) => m.id === modelId) ?? model(modelId, modelId, 128_000, 16_384, false);
  return { provider, model: found };
}

export function listModels(config: PerchConfig): string[] {
  return Object.values(config.providers).flatMap((p) => p.models.map((m) => `${p.id}/${m.id}`));
}

export interface ModelChoice {
  ref: string; // provider/model
  name: string;
  provider: string;
  hasKey: boolean;
  vision: boolean;
}

export function modelChoices(config: PerchConfig): ModelChoice[] {
  return Object.values(config.providers).flatMap((p) =>
    p.models.map((m) => ({
      ref: `${p.id}/${m.id}`,
      name: m.name === m.id ? prettyName(m.id) : m.name,
      provider: p.name,
      hasKey: !!p.apiKey || !!p.local,
      vision: !!m.vision,
    })),
  );
}

// Ask a provider which models it serves (OpenAI-style GET /models). Also checks the key.
export async function fetchModels(baseURL: string, apiKey?: string, timeoutMs = 8000): Promise<string[]> {
  const res = await fetch(baseURL.replace(/\/$/, "") + "/models", {
    headers: { "user-agent": "perch/0.1.0", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  const body: any = await res.json();
  return (body.data ?? body.models ?? []).map((m: any) => m.id ?? m.name).filter(Boolean);
}

// Save an imported key (and optionally a custom base URL) to ~/.perch/auth.json.
// Writes one setting to ~/.perch/config.json, keeping everything else in the file.
export function saveSetting(name: string, value: unknown) {
  const file = path.join(HOME, "config.json");
  const own = readJSON(file) ?? {};
  own[name] = value;
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(own, null, 2));
}

export function saveKey(id: string, key: string, opts: { baseURL?: string; name?: string; models?: string[] } = {}) {
  const all = readJSON(PERCH_AUTH) ?? {};
  all[id] = { ...(all[id] ?? {}), key, ...opts };
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(PERCH_AUTH, JSON.stringify(all, null, 2), { mode: 0o600 });
}

export function removeKey(id: string) {
  const all = readJSON(PERCH_AUTH) ?? {};
  delete all[id];
  fs.writeFileSync(PERCH_AUTH, JSON.stringify(all, null, 2), { mode: 0o600 });
}

// Local servers that speak the OpenAI format, probed at start-up.
const LOCAL_SERVERS = [
  { id: "ollama", name: "Ollama (local)", baseURL: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", name: "LM Studio (local)", baseURL: "http://127.0.0.1:1234/v1" },
  { id: "llamacpp", name: "llama.cpp (local)", baseURL: "http://127.0.0.1:8080/v1" },
  { id: "vllm", name: "vLLM (local)", baseURL: "http://127.0.0.1:8000/v1" },
];

// Finds running local model servers and adds their models. Servers that aren't running are
// skipped after a short timeout. A configured provider at the same address keeps its own entry.
export async function discoverLocal(config: PerchConfig): Promise<string[]> {
  const found: string[] = [];
  await Promise.all(
    LOCAL_SERVERS.map(async (srv) => {
      let ids: string[];
      try {
        ids = await fetchModels(srv.baseURL, undefined, 800);
      } catch {
        return;
      }
      const sameAddress = Object.values(config.providers).find((p) => p.baseURL.replace(/\/$/, "").replace("localhost", "127.0.0.1") === srv.baseURL);
      const target = sameAddress ?? (config.providers[srv.id] = { id: srv.id, name: srv.name, baseURL: srv.baseURL, models: [], local: true });
      for (const m of ids) if (!target.models.some((x) => x.id === m)) target.models.push(model(m, m, 32_768, 8192, false));
      found.push(`${target.name}: ${ids.length} models`);
    }),
  );
  return found;
}
