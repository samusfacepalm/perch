// A streaming client for OpenAI-compatible chat completion APIs (DeepSeek, OpenCode Go, Ollama, llama.cpp).
// Plain fetch and SSE parsing, so provider quirks stay visible here instead of hidden in an SDK.

import fs from "node:fs";
import path from "node:path";
import type { ModelInfo, Provider } from "./config.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: string[] } // images: file paths, encoded only when sent
  | { role: "assistant"; content: string; reasoning_content?: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface Usage {
  input: number;
  output: number;
  cacheHit: number; // prompt tokens served from the provider's prefix cache
  reasoning: number;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool_start"; index: number; name: string }
  | { type: "retry"; attempt: number; waitMs: number; error: string };

export interface Completion {
  message: Extract<Message, { role: "assistant" }>;
  finishReason: string;
  usage: Usage;
}

export interface ChatRequest {
  provider: Provider;
  model: ModelInfo;
  messages: Message[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  maxTokens?: number;
  sessionId?: string;
  onEvent?: (e: StreamEvent) => void;
}

const USER_AGENT = "perch/0.1.0";
const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);
const MAX_ATTEMPTS = 8;

export class ProviderError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

// Long tasks run for hours, so transient failures get patient retries with backoff
// instead of killing the session.
export async function chat(req: ChatRequest): Promise<Completion> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await chatOnce(req);
    } catch (err: any) {
      if (err?.name === "AbortError") throw err;
      const retryable = err instanceof ProviderError ? err.retryable : true; // network errors retry
      if (!retryable || attempt === MAX_ATTEMPTS) throw err;
      lastError = err;
      const waitMs = Math.min(60_000, 1000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
      req.onEvent?.({ type: "retry", attempt, waitMs, error: String(err?.message ?? err) });
      await sleep(waitMs, req.signal);
    }
  }
  throw lastError;
}

async function chatOnce(req: ChatRequest): Promise<Completion> {
  const { provider, model } = req;
  if (!provider.apiKey && !/localhost|127\.0\.0\.1/.test(provider.baseURL)) {
    throw new ProviderError(`No API key for ${provider.name}. Set it in the environment or in OpenCode.`);
  }
  const body: Record<string, unknown> = {
    model: model.id,
    messages: req.messages.map(toWire(model)),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: req.maxTokens ?? maxOutput(model),
    ...provider.extraBody,
  };
  if (req.tools?.length) body.tools = req.tools;

  const res = await fetch(provider.baseURL.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      ...(provider.sessionHeader && req.sessionId ? { [provider.sessionHeader]: req.sessionId } : {}),
      ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(
      `${provider.name} returned ${res.status}: ${text.slice(0, 500)}`,
      res.status,
      RETRY_STATUS.has(res.status),
    );
  }

  let content = "";
  let reasoning = "";
  let finishReason = "stop";
  const calls: ToolCall[] = [];
  const usage: Usage = { input: 0, output: 0, cacheHit: 0, reasoning: 0 };

  for await (const data of sse(res.body, req.signal)) {
    if (data === "[DONE]") break;
    let chunk: any;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw new ProviderError(chunk.error.message ?? JSON.stringify(chunk.error), undefined, true);
    if (chunk.usage) {
      const u = chunk.usage;
      usage.input = u.prompt_tokens ?? usage.input;
      usage.output = u.completion_tokens ?? usage.output;
      // DeepSeek reports prompt_cache_hit_tokens; OpenAI-style servers report prompt_tokens_details.cached_tokens.
      usage.cacheHit = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? usage.cacheHit;
      usage.reasoning = u.completion_tokens_details?.reasoning_tokens ?? usage.reasoning;
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta ?? {};
    // DeepSeek uses reasoning_content; some OpenAI-compatible servers use reasoning.
    const r = delta.reasoning_content ?? delta.reasoning;
    if (typeof r === "string" && r) {
      reasoning += r;
      req.onEvent?.({ type: "reasoning", delta: r });
    }
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      req.onEvent?.({ type: "text", delta: delta.content });
    }
    for (const tc of delta.tool_calls ?? []) {
      const i = tc.index ?? calls.length;
      if (!calls[i]) {
        calls[i] = { id: tc.id ?? `call_${i}`, type: "function", function: { name: "", arguments: "" } };
      }
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name) {
        calls[i].function.name += tc.function.name;
        req.onEvent?.({ type: "tool_start", index: i, name: calls[i].function.name });
      }
      if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const message: Completion["message"] = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  const toolCalls = calls.filter(Boolean);
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { message, finishReason, usage };
}

// What goes over the wire. For reasoning models every assistant message carries
// reasoning_content, empty if need be: DeepSeek's thinking mode rejects tool-call histories
// without it (OpenCode does the same in provider/transform.ts). Non-reasoning servers get it
// stripped because some reject unknown fields.
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };

// Images go to models that can see them as data URLs, read from disk at send time. Other
// models get the file paths and a note, so they can still refer to the files.
function userToWire(m: Extract<Message, { role: "user" }>, model: ModelInfo) {
  if (!m.images?.length) return { role: "user", content: m.content };
  if (!model.vision) {
    return { role: "user", content: `${m.content}\n\n[Attached images; this model cannot see images, but the files are here: ${m.images.join(", ")}]` };
  }
  const parts: unknown[] = [{ type: "text", text: m.content || "(image)" }];
  for (const file of m.images) {
    try {
      const data = fs.readFileSync(file).toString("base64");
      parts.push({ type: "image_url", image_url: { url: `data:${MIME[path.extname(file).toLowerCase()] ?? "image/png"};base64,${data}` } });
    } catch {
      parts.push({ type: "text", text: `[image no longer on disk: ${file}]` });
    }
  }
  return { role: "user", content: parts };
}

function toWire(model: ModelInfo) {
  return (m: Message) => {
    if (m.role === "user") return userToWire(m, model);
    if (m.role !== "assistant") return m;
    const out: Record<string, unknown> = { role: "assistant", content: m.content ?? "" };
    if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
    if (model.reasoning) out.reasoning_content = m.reasoning_content ?? "";
    return out;
  };
}

async function* sse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.startsWith("data:")) yield line.slice(5).trimStart();
      }
    }
    if (buffer.startsWith("data:")) yield buffer.slice(5).trimStart();
  } finally {
    reader.releaseLock();
  }
}

// Reasoning counts against max_tokens, so thinking models get DeepSeek's own thinking-mode
// default of 64K; others get 32K, as OpenCode uses. Some servers reject larger values.
export function maxOutput(model: ModelInfo): number {
  return Math.min(model.output, model.reasoning ? 65_536 : 32_000);
}

// Rough token count for budgeting before the server tells us the real number.
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length;
    if (m.role === "user") chars += (m.images?.length ?? 0) * 3000; // roughly 850 tokens an image
    if (m.role === "assistant") {
      chars += (m.reasoning_content ?? "").length;
      for (const tc of m.tool_calls ?? []) chars += tc.function.arguments.length + tc.function.name.length;
    }
  }
  return Math.ceil(chars / 3.5);
}
