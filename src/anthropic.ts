// Claude through Anthropic's own Messages API, so Perch can drive the strongest coding models
// with their prompt cache and thinking intact. The OpenAI-format client in provider.ts calls
// this for providers whose format is "anthropic".
//
// - The system prompt goes in `system`; top-level cache_control caches the conversation so far
//   on every request, so long sessions read their history from the cache.
// - Thinking blocks come back with signatures and are replayed unchanged on later requests.
//   Perch's compaction and image retirement rewrite earlier turns, which invalidates them, so
//   every request asks the API to drop invalid blocks rather than fail (block_binding).
// - Thinking is always on for current Claude models; Perch's thinking level sets the effort.
// - When a safety classifier declines, the API retries on a fallback model ("default" routing).

import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { Completion, ChatRequest, Message, Usage } from "./provider.js";
import { ProviderError, RETRY_STATUS } from "./provider.js";

const BETAS = ["thinking-binding-controls-2026-08-01", "server-side-fallback-2026-07-01"];
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
// Models that accept server-side refusal fallbacks.
const FALLBACKS = /^claude-(opus-5-5|fable-5-1|sonnet-5-5)$/;

const clients = new Map<string, Anthropic>();
function client(baseURL: string, apiKey: string): Anthropic {
  const key = baseURL + "|" + apiKey;
  let c = clients.get(key);
  // Perch's chat() retries with its own backoff and status messages, so the SDK doesn't.
  // The SDK adds /v1 itself; proxies are often configured with it already.
  if (!c) clients.set(key, (c = new Anthropic({ apiKey, baseURL: baseURL.replace(/\/v1\/?$/, ""), maxRetries: 0, timeout: 30 * 60_000 })));
  return c;
}

function imageBlocks(files: string[]): any[] {
  return files.map((file) => {
    try {
      const data = fs.readFileSync(file).toString("base64");
      return { type: "image", source: { type: "base64", media_type: MIME[path.extname(file).toLowerCase()] ?? "image/png", data } };
    } catch {
      return { type: "text", text: `[image no longer on disk: ${file}]` };
    }
  });
}

// Perch's history in Anthropic's shape. Consecutive messages with the same role are fine:
// the API joins them into one turn, so tool results and the images after them stay in order.
export function toAnthropic(messages: Message[], vision: boolean): { system: string; messages: any[] } {
  let system = "";
  const out: any[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system += (system ? "\n\n" : "") + m.content;
    } else if (m.role === "user") {
      const content: any[] = [];
      if (m.images?.length && vision) content.push(...imageBlocks(m.images));
      const note = m.images?.length && !vision ? `\n\n[Attached images; this model cannot see them, but the files are here: ${m.images.join(", ")}]` : "";
      content.push({ type: "text", text: (m.content || "(image)") + note });
      out.push({ role: "user", content });
    } else if (m.role === "assistant") {
      const content: any[] = [...(m.thinking_blocks ?? [])];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = c.function.arguments.trim() ? JSON.parse(c.function.arguments) : {};
        } catch {
          input = { _unparsed: c.function.arguments };
        }
        content.push({ type: "tool_use", id: c.id, name: c.function.name, input });
      }
      if (!content.some((b) => b.type !== "thinking" && b.type !== "redacted_thinking")) content.push({ type: "text", text: "(no reply)" });
      out.push({ role: "assistant", content });
    } else {
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content || "(no output)" }] });
    }
  }
  return { system, messages: out };
}

const EFFORT = { off: "low", low: "low", high: "high", max: "max" } as const;

export async function chatAnthropic(req: ChatRequest): Promise<Completion> {
  const { provider, model } = req;
  if (!provider.apiKey) throw new ProviderError(`No API key for ${provider.name}. Set ANTHROPIC_API_KEY, or add the key in Keys & models.`);
  const { system, messages } = toAnthropic(req.messages, !!model.vision);
  const params: any = {
    model: model.id,
    max_tokens: req.maxTokens ?? Math.min(model.output, 64_000),
    system,
    messages,
    cache_control: { type: "ephemeral" },
    thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    // Coding needs more thought than the API's default effort (medium on Opus 5.5).
    output_config: { effort: EFFORT[req.thinking ?? "high"] },
    betas: BETAS,
  };
  if (FALLBACKS.test(model.id)) params.fallbacks = "default";
  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters, eager_input_streaming: true }));
  }

  let stream;
  try {
    stream = client(provider.baseURL, provider.apiKey).beta.messages.stream(params, { signal: req.signal });
    const names = new Map<number, string>();
    for await (const ev of stream as AsyncIterable<any>) {
      if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
        names.set(ev.index, ev.content_block.name);
        req.onEvent?.({ type: "tool_start", index: ev.index, name: ev.content_block.name });
      } else if (ev.type === "content_block_delta") {
        if (ev.delta.type === "text_delta") req.onEvent?.({ type: "text", delta: ev.delta.text });
        else if (ev.delta.type === "thinking_delta") req.onEvent?.({ type: "reasoning", delta: ev.delta.thinking });
      }
    }
    const final: any = await stream.finalMessage();
    return fromAnthropic(final);
  } catch (err: any) {
    if (err?.name === "AbortError" || req.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (err instanceof Anthropic.APIError) {
      const status = err.status ?? undefined;
      throw new ProviderError(`${provider.name} returned ${status ?? "an error"}: ${String(err.message).slice(0, 500)}`, status, status === undefined || RETRY_STATUS.has(status));
    }
    throw err;
  }
}

export function fromAnthropic(final: any): Completion {
  let content = "";
  let reasoning = "";
  const thinking: unknown[] = [];
  const calls: Completion["message"]["tool_calls"] = [];
  for (const b of final.content ?? []) {
    if (b.type === "text") content += b.text;
    else if (b.type === "thinking") {
      thinking.push(b);
      reasoning += b.thinking ?? "";
    } else if (b.type === "redacted_thinking") thinking.push(b);
    else if (b.type === "tool_use") calls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
    // fallback blocks mark a switch of model after a refusal; nothing to replay.
  }
  const u = final.usage ?? {};
  const cacheHit = u.cache_read_input_tokens ?? 0;
  const usage: Usage = {
    input: (u.input_tokens ?? 0) + cacheHit + (u.cache_creation_input_tokens ?? 0),
    output: u.output_tokens ?? 0,
    cacheHit,
    reasoning: 0,
  };
  const stop: string = final.stop_reason ?? "end_turn";
  if (stop === "refusal") content += `${content ? "\n\n" : ""}[Claude declined this request${final.stop_details?.category ? ` (${final.stop_details.category})` : ""}.]`;
  const message: Completion["message"] = { role: "assistant", content };
  if (reasoning) message.reasoning_content = reasoning;
  if (thinking.length) message.thinking_blocks = thinking;
  // A reply cut off by max_tokens can end in a tool call with half its input, which must not
  // run. Dropping it lets the agent ask the model to continue instead.
  if (calls.length && stop !== "max_tokens" && stop !== "refusal") message.tool_calls = calls;
  const finishReason = stop === "max_tokens" ? "length" : stop === "tool_use" ? "tool_calls" : stop;
  return { message, finishReason, usage };
}
