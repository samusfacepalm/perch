// The agent loop: ask the model, run the tools it calls, feed back the results, repeat.
//
// Built for long tasks:
// - Messages are append-only between compactions, so the provider's prefix cache keeps hitting
//   (DeepSeek bills cache hits at a fraction of the price, and they come back faster).
// - When the context fills, old tool output is pruned and the conversation is summarised.
//   The todo list is kept outside the summary, so the plan survives intact.
// - Transient API errors retry with backoff (see provider.ts); a session is saved after every step.
// - Repeating the same tool call over and over is detected and interrupted.

import fs from "node:fs";
import path from "node:path";
import { chat, estimateTokens, isContextOverflow, maxOutput, type Message, type StreamEvent, type ToolCall, type ToolSpec, type Usage } from "./provider.js";
import { HOME, resolveModel, type PerchConfig } from "./config.js";
import { saveSession, type Session, type SessionUsage } from "./session.js";
import { costOf, priceFor } from "./pricing.js";
import { systemPrompt, COMPACT_PROMPT, SUBAGENT_PROMPT, continuationNote } from "./prompt.js";
import { ToolError, type Tool, type ToolContext, type ToolResult } from "./tools/types.js";
import { read, write, list, glob, grep } from "./tools/files.js";
import { edit } from "./tools/edit.js";
import { bash } from "./tools/bash.js";
import { todowrite, formatTodos } from "./tools/todo.js";
import { makeTaskTool } from "./tools/task.js";
import { makeSkillTool } from "./tools/skill.js";
import { makeMcpTools } from "./tools/mcp.js";
import { inspectImage } from "./tools/image.js";
import { webSearch, webFetch } from "./tools/web.js";
import { makePlayTool, type PlayRunner } from "./tools/play.js";
import { configuredServers } from "./mcpClient.js";
import { loadAgents, loadSkills, type AgentDef } from "./instructions.js";
import { runHooks } from "./hooks.js";
import { commandParts, judge, loadRules } from "./rules.js";
import { restore, snapshot } from "./snapshot.js";

export const BASE_TOOLS: Tool[] = [read, edit, write, bash, glob, grep, list, todowrite, inspectImage, webSearch, webFetch];

// The full tool set for a folder: the base tools, plus skills and named subagents found for it.
export function toolsFor(cwd: string, playRunner?: PlayRunner): Tool[] {
  const skills = loadSkills(cwd);
  return [
    ...BASE_TOOLS,
    makeTaskTool(loadAgents(cwd)),
    ...(skills.length ? [makeSkillTool(skills)] : []),
    ...makeMcpTools(configuredServers(cwd)),
    makePlayTool(cwd, playRunner),
  ];
}
// Calls that may run side by side. Subagents are included so several can work at once.
const PARALLEL = new Set(["read", "glob", "grep", "list", "task", "inspect_image", "mcp_tools", "skill", "web_search"]);

// refused: why Perch itself refused the call (plan mode, a rule, a hook), as opposed to the user.
export type Decision = { allow: boolean; always?: boolean; feedback?: string; refused?: string };

export interface AgentEvents {
  onStream?(e: StreamEvent): void;
  onMessage?(m: Message): void; // a finished message was added to the history
  onToolStart?(call: ToolCall, summary: string): void;
  onToolEnd?(call: ToolCall, result: ToolResult & { error?: boolean }): void;
  onStatus?(text: string): void;
  ask?(tool: string, summary: string, args: any): Promise<Decision>;
  onUnsent?(texts: string[]): void; // queued messages the run ended without reading, for the input box
}

export interface AgentOptions {
  config: PerchConfig;
  session: Session;
  events: AgentEvents;
  tools?: Tool[];
  yolo?: boolean; // approve everything
  isSubagent?: boolean;
  autoContinue?: boolean; // nudge the model when it stops with open todos
  save?: (s: Session) => void; // how to persist the session; defaults to a synchronous write
  playRunner?: PlayRunner; // how to run games; the desktop app adds web games
}

export class Agent {
  readonly config: PerchConfig;
  readonly session: Session;
  events: AgentEvents;
  private tools: Map<string, Tool>;
  private readFiles = new Map<string, number>();
  private alwaysAllow = new Set<string>();
  private controller?: AbortController;
  private lastTokens = 0;
  private toolImages: string[] = []; // images tools produced this step, shown to vision models
  private turnCalls = new Map<string, number>(); // tool calls per tool since the user last wrote
  private queued: { text: string; images?: string[] }[] = []; // sent while the agent was working
  readonly opts: AgentOptions;

  constructor(opts: AgentOptions) {
    this.opts = opts;
    this.config = opts.config;
    this.session = opts.session;
    this.events = opts.events;
    this.tools = new Map((opts.tools ?? toolsFor(opts.session.cwd, opts.playRunner)).map((t) => [t.name, t]));
  }

  get busy() {
    return !!this.controller;
  }

  abort() {
    this.controller?.abort();
  }

  // A message the user sends while the agent works, after pi's steering queue. The model reads
  // it once the current step's tools finish, so the user can redirect without interrupting.
  steer(text: string, images?: string[]) {
    this.queued.push({ text, images });
    this.events.onStatus?.(`Perch will read your message after this step${this.queued.length > 1 ? ` (${this.queued.length} waiting)` : ""}.`);
  }

  // Move queued messages into the conversation. Returns whether there were any.
  private takeQueued(): boolean {
    if (!this.queued.length) return false;
    for (const q of this.queued.splice(0)) this.push(q.images?.length ? { role: "user", content: q.text, images: q.images } : { role: "user", content: q.text });
    this.turnCalls.clear();
    return true;
  }

  get contextTokens() {
    return this.lastTokens || estimateTokens(this.session.messages);
  }

  // Hours since this session last did anything.
  get idleHours() {
    return (Date.now() - new Date(this.session.updated).getTime()) / 3_600_000;
  }

  // Whether the session qualifies for idle summarising: switched on, idle long enough, and
  // holding enough context to be worth it. Its provider cache has expired by then, so the next
  // message would pay full price for all of it.
  shouldCompactIdle(): boolean {
    const c = this.config;
    return c.idleCompact && !this.busy && !this.opts.isSubagent && this.idleHours >= c.idleCompactHours && this.contextTokens >= c.idleCompactMinTokens;
  }

  private toolSpecs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  private push(m: Message, both = true) {
    this.session.messages.push(m);
    if (both) this.session.history.push(m);
    this.events.onMessage?.(m);
  }

  // Run one user request to completion.
  async run(input: string, images?: string[]): Promise<string> {
    if (this.controller) throw new Error("Agent is already running.");
    const returningToIdle = this.shouldCompactIdle(); // checked before this run marks it busy
    this.controller = new AbortController();
    const signal = this.controller.signal;
    try {
      if (!this.session.messages.length) {
        this.session.messages.push({ role: "system", content: systemPrompt(this.session.cwd) });
      }
      if (returningToIdle) {
        this.events.onStatus?.(`Idle for ${this.idleHours.toFixed(1)} hours with ${Math.round(this.contextTokens / 1000)}K of context: summarising before your message…`);
        await this.compact(signal);
      }
      const hook = this.opts.isSubagent ? undefined : await runHooks(this.config.hooks, "UserPromptSubmit", this.hookBase(), { prompt: input });
      if (hook?.block) {
        this.events.onStatus?.(`A hook blocked this message: ${hook.block}`);
        return `[blocked by a hook: ${hook.block}]`;
      }
      this.notePlanMode();
      if (!this.opts.isSubagent) this.checkpoint(input);
      this.push(images?.length ? { role: "user", content: input, images } : { role: "user", content: input });
      if (hook?.context.length) this.push({ role: "user", content: `Context from the user's hooks:\n${hook.context.join("\n\n")}` }, false);
      this.turnCalls.clear();
      if (this.session.title === "New session") this.session.title = input.replace(/\s+/g, " ").slice(0, 60);
      return await this.loop(signal);
    } finally {
      // An interrupt or error can leave tool calls without results, and the API rejects
      // such a history on the next request. Give every unanswered call a result.
      repairToolPairs(this.session.messages);
      repairToolPairs(this.session.history);
      this.controller = undefined;
      // After an interrupt or error, messages still waiting go back to the input box.
      if (this.queued.length) this.events.onUnsent?.(this.queued.splice(0).map((q) => q.text));
      if (!this.opts.isSubagent) (this.opts.save ?? saveSession)(this.session);
    }
  }

  private hookBase() {
    return { session_id: this.session.id, cwd: this.session.cwd };
  }

  get mode() {
    return this.session.permissionMode ?? this.config.defaultMode;
  }

  // Tell the model when plan mode starts or ends. The note is a message of its own, so the
  // system prompt and the cached history stay as they were.
  private notePlanMode() {
    const on = this.mode === "plan";
    if (on === !!this.session.planNoted) return;
    this.session.planNoted = on;
    this.push({ role: "user", content: on ? PLAN_ON : PLAN_OFF }, false);
  }

  // Record the folder before a message, so the message's changes can be undone. It runs while
  // the model is thinking; tools wait for it before they run, so nothing changes files first.
  private checkpointing?: Promise<void>;
  private checkpoint(text: string) {
    const at = { text, messages: this.session.messages.length, history: this.session.history.length, compactions: this.session.compactions, at: new Date().toISOString() };
    this.checkpointing = snapshot(this.session.cwd).then((tree) => {
      if (!tree) return;
      const list = (this.session.checkpoints ??= []);
      list.push({ tree, ...at });
      if (list.length > 50) list.splice(0, list.length - 50);
    });
  }

  // Undo the last message: put the folder back as it was before it, and take the message and
  // everything after it out of the conversation. Returns the message text for the input box.
  async undo(): Promise<{ text: string; files: string[]; conversation: boolean }> {
    if (this.busy) throw new Error("Perch is working; stop it before undoing.");
    await this.checkpointing;
    const cp = this.session.checkpoints?.pop();
    if (!cp) throw new Error("Nothing to undo in this session.");
    const files = await restore(this.session.cwd, cp.tree);
    // After a summary the old messages are gone from what the model sees, so the conversation
    // can't be cut back; the model is told instead.
    const conversation = cp.compactions === this.session.compactions && cp.messages <= this.session.messages.length;
    if (conversation) {
      this.session.messages.length = cp.messages;
      this.session.history.length = Math.min(cp.history, this.session.history.length);
    } else {
      this.push({ role: "user", content: `The user undid the request "${cp.text.slice(0, 300)}": the files are back as they were before it (${files.length} changed). Treat that work as not done.` }, false);
    }
    this.lastTokens = 0;
    if (!this.opts.isSubagent) (this.opts.save ?? saveSession)(this.session);
    return { text: cp.text, files, conversation };
  }

  private async loop(signal: AbortSignal): Promise<string> {
    const { provider, model } = resolveModel(this.config, this.session.model);
    let nudges = 0;
    let stopHooks = 0;
    const recent: string[] = [];

    // Compaction trigger, after DeepSeek Harness: leave room for a full reply plus a margin.
    const limit = Math.min(model.context * this.config.compactAt, model.context - maxOutput(model) - 65_536, this.config.compactTokens);

    let overflowed = false;
    for (let step = 0; step < this.config.maxSteps; step++) {
      if (signal.aborted) return "[interrupted]";
      if (this.contextTokens > limit) await this.compact(signal);
      retireOldImages(this.session.messages);

      // On the last allowed step, tools are withdrawn so the model writes a hand-over instead.
      const last = step === this.config.maxSteps - 1;
      if (last) this.push({ role: "user", content: MAX_STEPS_PROMPT }, false);

      let res: Awaited<ReturnType<typeof chat>>;
      try {
        res = await chat({
          provider,
          model,
          messages: this.session.messages,
          tools: last ? undefined : this.toolSpecs(),
          signal,
          sessionId: this.session.id,
          thinking: this.session.thinking,
          onEvent: (e) => {
            if (e.type === "retry") this.events.onStatus?.(`${provider.name} error, retry ${e.attempt} in ${Math.round(e.waitMs / 1000)}s: ${e.error.slice(0, 120)}`);
            this.events.onStream?.(e);
          },
        });
      } catch (e) {
        // The token estimate can undershoot, so the provider may reject the request as too long.
        // Summarise and try once more, as pi does, instead of ending the run.
        if (overflowed || !isContextOverflow(e)) throw e;
        overflowed = true;
        this.events.onStatus?.("The conversation no longer fits the model's context; summarising and trying again…");
        await this.compact(signal, true);
        continue;
      }
      overflowed = false;
      this.addUsage(res.usage, this.session.model);
      this.lastTokens = res.usage.input + res.usage.output;
      this.push(res.message);

      const calls = res.message.tool_calls ?? [];
      if (!calls.length) {
        if (res.finishReason === "length") {
          this.push({ role: "user", content: "Your reply was cut off by the output limit. Continue exactly where you stopped." }, false);
          continue;
        }
        if (this.takeQueued()) continue; // the user wrote while this reply was being written

        const open = this.session.todos.filter((t) => t.status === "pending" || t.status === "in_progress");
        if (this.opts.autoContinue && open.length && nudges < 3) {
          nudges++;
          this.push({ role: "user", content: continuationNote(formatTodos(this.session.todos)) }, false);
          continue;
        }
        // A Stop hook can send the agent back to work (exit code 2), a few times at most.
        if (!this.opts.isSubagent && this.config.hooks?.Stop && stopHooks < 3) {
          const stop = await runHooks(this.config.hooks, "Stop", this.hookBase(), { stop_hook_active: stopHooks > 0, last_message: res.message.content });
          if (stop.block) {
            stopHooks++;
            this.push({ role: "user", content: `A hook asks you to keep going: ${stop.block}` }, false);
            continue;
          }
        }
        return res.message.content;
      }

      // Read-only tools run in parallel; anything that changes state runs in order.
      const results: Message[] = [];
      const runOne = async (call: ToolCall) => {
        const out = await this.execute(call, signal);
        results.push({ role: "tool", tool_call_id: call.id, content: out });
      };
      if (calls.every((c) => PARALLEL.has(c.function.name))) {
        const outs = await Promise.all(calls.map((c) => this.execute(c, signal).then((content) => ({ c, content }))));
        for (const { c, content } of outs) results.push({ role: "tool", tool_call_id: c.id, content });
      } else {
        for (const call of calls) await runOne(call);
      }
      for (const r of results) this.push(r);
      nudges = 0; // the model is making progress, so it earns fresh nudges

      // Tool results can only carry text, so screenshots and other images the tools produced
      // follow as a user message, for models that can see. The newest four, to bound the cost.
      if (this.toolImages.length && model.vision) {
        const images = this.toolImages.slice(-4);
        this.push({ role: "user", content: `${TOOL_IMAGES} (${images.length} of ${this.toolImages.length}):`, images }, false);
      }
      this.toolImages = [];
      this.takeQueued();

      // The same call three times in a row usually means the model is stuck.
      for (const c of calls) recent.push(c.function.name + c.function.arguments);
      if (recent.length >= 3 && recent.slice(-3).every((x) => x === recent[recent.length - 1])) {
        this.push({
          role: "user",
          content: "You have made the same tool call three times in a row with the same arguments. Stop repeating it. Step back, say what is going wrong, and try a different approach.",
        }, false);
        recent.length = 0;
      }
      if (!this.opts.isSubagent) (this.opts.save ?? saveSession)(this.session);
    }
    return `[stopped after ${this.config.maxSteps} steps; send a message to continue]`;
  }

  private async execute(call: ToolCall, signal: AbortSignal): Promise<string> {
    // Models sometimes capitalise tool names; accept that rather than fail the call.
    const tool = this.tools.get(call.function.name) ?? this.tools.get(call.function.name.toLowerCase());
    if (!tool) {
      const result = { output: `Unknown tool "${call.function.name}". Available: ${[...this.tools.keys()].join(", ")}`, error: true };
      this.events.onToolEnd?.(call, result);
      return result.output;
    }
    let args: any;
    try {
      args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
    } catch {
      const result = { output: `Your arguments for ${tool.name} were not valid JSON: ${call.function.arguments.slice(0, 300)}`, error: true };
      this.events.onToolEnd?.(call, result);
      return result.output;
    }
    const summary = safe(() => tool.summarize(args)) ?? "";
    this.events.onToolStart?.(call, summary);
    await this.checkpointing; // the undo snapshot is taken before any tool changes a file

    const pre = this.config.hooks?.PreToolUse ? await runHooks(this.config.hooks, "PreToolUse", this.hookBase(), { tool_name: tool.name, tool_input: args }) : undefined;
    const decision: Decision = pre?.block
      ? { allow: false, refused: `A hook blocked it: ${pre.block}` }
      : pre?.decision === "allow" && !this.planBlocks(tool, args)
        ? { allow: true }
        : await this.permit(tool, summary, args);
    if (!decision.allow) {
      const output = decision.refused
        ? `This ${tool.name} call was refused. ${decision.refused}`
        : `The user declined this ${tool.name} call.${decision.feedback ? ` They said: ${decision.feedback}` : " Ask them how to proceed, or try another way."}`;
      this.events.onToolEnd?.(call, { output, error: true, title: "declined" });
      return output;
    }

    const ctx: ToolContext = {
      cwd: this.session.cwd,
      signal,
      session: this.session,
      readFiles: this.readFiles,
      turnCalls: this.turnCalls.set(tool.name, (this.turnCalls.get(tool.name) ?? 0) + 1),
      runSubagent: this.opts.isSubagent ? undefined : (d, p, def) => this.runSubagent(d, p, signal, def),
    };
    try {
      const result = await tool.run(args, ctx);
      if (this.config.hooks?.PostToolUse) {
        const post = await runHooks(this.config.hooks, "PostToolUse", this.hookBase(), { tool_name: tool.name, tool_input: args, tool_response: result.output.slice(0, 100_000) });
        if (post.block) result.output += `\n\n[Feedback from the user's hook: ${post.block}]`;
      }
      result.output = spillLongOutput(result.output, tool.name, !!ctx.runSubagent);
      if (result.images?.length) this.toolImages.push(...result.images);
      this.events.onToolEnd?.(call, result);
      return result.output;
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      const output = e instanceof ToolError ? `Error: ${e.message}` : `Error: ${e?.stack ?? e}`;
      this.events.onToolEnd?.(call, { output, error: true });
      return output;
    }
  }

  // In plan mode only reading and research run. Returns why a call is refused, if it is.
  private planBlocks(tool: Tool, args: any): string | undefined {
    if (this.mode !== "plan" || PLAN_TOOLS.has(tool.name)) return undefined;
    if (tool.name === "bash") {
      const parts = commandParts(String(args.command ?? ""));
      if (parts.length && parts.every((p) => PLAN_BASH.some((c) => p === c || p.startsWith(c + " "))) && !/[>`$]/.test(String(args.command))) return undefined;
    }
    return "Plan mode is on, so only reading and research run. Finish the plan and present it; the user will switch plan mode off to have it carried out.";
  }

  private async permit(tool: Tool, summary: string, args: any): Promise<Decision> {
    const plan = this.planBlocks(tool, args);
    if (plan) return { allow: false, refused: plan };
    // Rules from Claude Code's settings and Perch's config. A deny rule holds even in yolo mode.
    const ruled = judge(loadRules(this.session.cwd, this.config.rules), tool.name, args, this.session.cwd);
    if (ruled?.action === "deny") return { allow: false, refused: `A permission rule denies it (${ruled.rule}).` };
    if (this.opts.yolo) return { allow: true };
    if (ruled?.action === "allow") return { allow: true };
    const rule = ruled?.action === "ask" ? "ask" : (this.config.permissions[tool.name] ?? "ask");
    if (rule === "deny") return { allow: false, refused: `${tool.name} is switched off in the configuration.` };
    if (rule === "allow") return { allow: true };
    // Opening a page runs it in a browser sandbox, not on the PC itself, so it never asks.
    if (tool.name === "play" && typeof args.page === "string") return { allow: true };
    // Session permission modes: "edits" lets file changes through, "all" lets everything
    // through except shell commands that look destructive, which still ask. An "ask" rule
    // asks in every mode.
    const mode = ruled?.action === "ask" ? "ask" : this.mode;
    if (mode === "all" && !(tool.name === "bash" && looksDestructive(String(args.command ?? "")))) return { allow: true };
    if ((mode === "edits" || mode === "all") && (tool.name === "write" || tool.name === "edit")) return { allow: true };
    if (tool.name === "bash") {
      const cmd = String(args.command ?? "").trim();
      // Allowlisted prefixes skip the prompt, but not when chained with other commands.
      const simple = !/[;&|`$<>]/.test(cmd.replace(/2>&1/g, ""));
      if (simple && this.config.bashAllow.some((p) => cmd === p || cmd.startsWith(p + " "))) return { allow: true };
      const key = "bash:" + cmd.split(/\s+/).slice(0, 2).join(" ");
      if (this.alwaysAllow.has(key)) return { allow: true };
      const d = (await this.events.ask?.(tool.name, summary, args)) ?? { allow: false };
      if (d.allow && d.always) this.alwaysAllow.add(key);
      return d;
    }
    // "Always" for an MCP call covers that server only, and for a fetch that site only.
    const key = tool.name === "mcp_call" ? `mcp:${args.server}` : tool.name === "web_fetch" ? `web:${hostOf(args.url)}` : tool.name;
    if (this.alwaysAllow.has(key)) return { allow: true };
    const d = (await this.events.ask?.(tool.name, summary, args)) ?? { allow: false };
    if (d.allow && d.always) this.alwaysAllow.add(key);
    return d;
  }

  // Add one request's tokens and cost to the session, in total and per model.
  private addUsage(u: Usage, ref: string) {
    let local = false;
    try {
      local = !!resolveModel(this.config, ref).provider.local;
    } catch {}
    const cost = costOf(u, priceFor(ref, this.config.prices, local));
    this.mergeUsage({ ...u, cost, byModel: { [ref]: { ...u, cost: cost ?? 0, priced: cost !== undefined, requests: 1 } } });
  }

  private mergeUsage(u: SessionUsage) {
    const s = this.session.usage;
    s.input += u.input;
    s.output += u.output;
    s.cacheHit += u.cacheHit;
    s.reasoning += u.reasoning;
    s.cost = (s.cost ?? 0) + (u.cost ?? 0);
    s.byModel ??= {};
    for (const [ref, m] of Object.entries(u.byModel ?? {})) {
      const t = (s.byModel[ref] ??= { input: 0, output: 0, cacheHit: 0, reasoning: 0, cost: 0, priced: m.priced, requests: 0 });
      t.input += m.input;
      t.output += m.output;
      t.cacheHit += m.cacheHit;
      t.reasoning += m.reasoning;
      t.cost += m.cost;
      t.requests += m.requests;
    }
  }

  // Summarise the conversation so far and carry on from the summary.
  // overflowed: the provider just rejected the conversation as too long, so asking the same
  // model with the whole conversation would fail too; go straight to the fallback.
  async compact(signal?: AbortSignal, overflowed = false) {
    this.events.onStatus?.("Context nearly full; summarising the conversation...");
    const [system, ...rest] = this.session.messages;
    const main = resolveModel(this.config, this.session.model);
    const keep = Math.min(32_000, Math.floor(0.16 * Math.min(main.model.context, this.config.compactTokens)));
    const { head, tail } = splitTail(rest, keep);
    if (!head.length) return; // nothing old enough to summarise
    const prior = this.session.summary
      ? `<prior-summary>\n${this.session.summary}\n</prior-summary>\n\nThe conversation happened after that summary. Write one new summary covering both. Anything you leave out is lost for good. Where they disagree, the conversation is newer and wins; move finished work from Active to Completed.\n\n`
      : "";

    // First choice, from DeepSeek Harness: ask the same model, with the same system prompt,
    // tools and messages, and the instruction appended. The whole request then hits the warm
    // prefix cache, which makes the summary cheap and quick.
    let text = "";
    if (!overflowed) try {
      const res = await chat({
        provider: main.provider,
        model: main.model,
        signal,
        sessionId: this.session.id,
        thinking: this.session.thinking,
        tools: this.toolSpecs(),
        messages: [...this.session.messages, { role: "user", content: `${prior}${COMPACT_PROMPT}\n\nDo not call any tools. Reply with the summary only.` }],
      });
      this.addUsage(res.usage, this.session.model);
      text = res.message.content.trim();
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
    }

    // Fallback: a plain transcript sent to the small model, with old tool output pruned.
    if (text.length < 200) {
      const ref = this.config.smallModel ?? this.session.model;
      const { provider, model } = resolveModel(this.config, ref);
      const transcript = pruneToolOutputs(head, 40_000).map(render).join("\n\n");
      const res = await chat({
        provider,
        model,
        signal,
        sessionId: this.session.id,
        thinking: this.session.thinking,
        messages: [
          { role: "system", content: COMPACT_PROMPT },
          { role: "user", content: `${prior}<conversation>\n${clip(transcript, model.context * 3 - 40_000)}\n</conversation>` },
        ],
      });
      this.addUsage(res.usage, ref);
      text = res.message.content.trim();
    }
    this.session.summary = text;
    const files = [...this.readFiles.keys()].slice(-30).join("\n");
    const summary = [
      `This conversation was summarised to free up context (summary ${this.session.compactions + 1}). Continue the task directly from the messages that follow, without acknowledging this checkpoint.`,
      this.session.summary,
      `## Todo list (current)\n${formatTodos(this.session.todos)}`,
      files ? `## Files read so far (re-read before editing if unsure of their contents)\n${files}` : "",
    ].filter(Boolean).join("\n\n");
    // Claude's thinking blocks are bound to the conversation before them, which the summary
    // replaces, so the kept messages go on without them (their text and tool calls stay).
    for (const m of tail) if (m.role === "assistant") delete m.thinking_blocks;
    const carryOn = tail.length ? [] : [{ role: "user" as const, content: "Continue if you have next steps, or stop and ask if you are unsure how to proceed." }];
    this.session.messages = [system, { role: "user", content: summary }, ...tail, ...carryOn];
    this.session.history.push({ role: "user", content: `[compacted]\n${summary}` });
    this.session.compactions++;
    this.lastTokens = 0;
    this.events.onStatus?.(`Summarised (${this.session.compactions} so far).`);
    if (!this.opts.isSubagent) (this.opts.save ?? saveSession)(this.session);
  }

  private async runSubagent(description: string, prompt: string, signal: AbortSignal, def?: AgentDef): Promise<string> {
    const { newSession } = await import("./session.js");
    // A named agent may ask for its own model; fall back to this session's if that one isn't usable here.
    let model = this.session.model;
    if (def?.model) {
      try {
        resolveModel(this.config, def.model);
        model = def.model;
      } catch {}
    }
    const child = newSession(this.session.cwd, model);
    child.permissionMode = this.session.permissionMode; // a subagent in plan mode only reads too
    const role = def ? `\n\n# Your role: ${def.name}\n${def.prompt}` : "";
    child.messages.push({ role: "system", content: systemPrompt(this.session.cwd) + "\n\n" + SUBAGENT_PROMPT + role });
    const sub = new Agent({
      ...this.opts,
      session: child,
      isSubagent: true,
      autoContinue: false,
      // Named agents can be limited to a set of tools (e.g. read-only reviewers).
      tools: [...this.tools.values()].filter((t) => t.name !== "task" && (!def?.tools || def.tools.includes(t.name))),
      events: {
        ask: this.events.ask,
        onStatus: this.events.onStatus,
        onToolStart: (c, s) => this.events.onStatus?.(`[${description}] ${c.function.name} ${s}`.slice(0, 160)),
      },
    });
    sub.alwaysAllow = this.alwaysAllow;
    const onAbort = () => sub.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const out = await sub.run(prompt);
      this.mergeUsage(child.usage);
      return out || "(the subagent finished without a report)";
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

// Plan mode: what may run, and what the model is told when it starts and ends.
const PLAN_TOOLS = new Set(["read", "glob", "grep", "list", "todowrite", "task", "skill", "mcp_tools", "inspect_image", "web_search", "web_fetch"]);
const PLAN_BASH = ["ls", "pwd", "cat", "head", "tail", "wc", "git status", "git diff", "git log", "git show", "git branch", "node --version", "python --version"];
const PLAN_ON = `Plan mode is now on. Research and plan only: read files, search, look things up, and run read-only commands. Don't edit files or run anything that changes them; those calls will be refused.
When you have a plan, present it: the steps in order, the files each one touches, and how you'll check the result. Then stop. The user will switch plan mode off when they want it carried out.`;
const PLAN_OFF = "Plan mode is now off: you can make changes again. If you presented a plan and the user's next message approves it, carry it out.";

const MAX_STEPS_PROMPT =`You have reached the maximum number of steps for this request. Tools are now disabled. Reply with text only:
1. What is done and verified.
2. What remains, and exactly where you stopped.
3. What to do next.
The user can send a message to let you continue.`;

const SPILL_CHARS = 50_000;
const SPILL_LINES = 2000;

// Very long tool output is saved to a file; the model gets the start, the end and the path,
// and can grep or read the rest. This keeps one noisy command from flooding the context.
function spillLongOutput(output: string, tool: string, canDelegate: boolean): string {
  const lines = output.split("\n");
  if (output.length <= SPILL_CHARS && lines.length <= SPILL_LINES) return output;
  const dir = path.join(HOME, "tool-output");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${tool}.txt`);
  fs.writeFileSync(file, output);
  const head = lines.slice(0, 200).join("\n").slice(0, 12_000);
  const tail = lines.slice(-100).join("\n").slice(-8_000);
  const hint = canDelegate
    ? "Use grep or read with offset/limit on that file, or hand it to a task subagent to digest. Do not read the whole file."
    : "Use grep or read with offset/limit on that file. Do not read the whole file.";
  return `${head}\n\n... [${lines.length} lines, ${output.length} characters in total; middle omitted] ...\n\n${tail}\n\nFull output saved to: ${file}\n${hint}`;
}

// Commands that delete, overwrite or rewrite history in bulk. In full-auto mode these still
// ask, because they're the ones that can't be taken back.
const DESTRUCTIVE = [
  /\brm\s+(-\w*[rf]\w*\s+)+/i, // rm -rf, rm -r, rm -f
  /\b(rmdir|rd)\s+\/s\b/i, // rmdir /s
  /\bdel\s+(\/\w\s+)*\/[sq]\b/i, // del /s /q
  /\bRemove-Item\b.*-Recurse/i,
  /\b(git\s+push|npm\s+publish|gh\s+release\s+create)\b/i, // publishing reaches other people
  // Stopping programs by name or pattern can hit the user's own; stopping by PID is fine.
  /\btaskkill\b(?!.*\/pid\b)/i,
  /\bStop-Process\b.*-(Name|ProcessName)\b|\bGet-Process\b.*\|\s*Stop-Process\b/i,
  /\b(killall|pkill)\b/i,
  /Browser\.close|Target\.closeTarget|\/json\/(close|version)/i, // closing browsers over the debugging protocol
  /\bgit\s+(push\s+.*(--force|-f\b)|reset\s+--hard|clean\s+-\w*[fdx]|checkout\s+--\s+\.|branch\s+-D|stash\s+(drop|clear))/i,
  // Formatting a disk, not Format-Table or --format=...: the format command takes a drive letter.
  /(^|[;&|(]\s*|\/[ck]\s+)format(\.com)?\s+[a-z]:|\b(Format-Volume|Clear-Disk|diskpart)\b|\bmkfs(\.\w+)?\s/i,
  // Shutting down the PC, not `wsl --shutdown`: the shutdown command with /s, /r or /p.
  /(^|[;&|(]\s*)shutdown(\.exe)?\s+[-/][srpf]\b|\b(Stop-Computer|Restart-Computer)\b/i,
  /\b(drop\s+(table|database)|truncate\s+table)\b/i,
  />\s*\/dev\/sd|\bdd\s+if=/i,
];

export function looksDestructive(cmd: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(cmd));
}

// A look-and-fix loop piles up screenshots, and every request re-sends them all. Once there are
// more than MAX_IMAGES, only the newest batch stays; older ones become their file paths. They go
// all at once rather than one by one, so the prompt cache breaks once every few plays, not every play.
const TOOL_IMAGES = "Images produced by the tool calls above";
const MAX_IMAGES = 12;
export function retireOldImages(messages: Message[]) {
  const batches = messages.filter((m): m is Extract<Message, { role: "user" }> => m.role === "user" && !!m.images?.length && m.content.startsWith(TOOL_IMAGES));
  if (batches.reduce((n, m) => n + m.images!.length, 0) <= MAX_IMAGES) return;
  for (const m of batches.slice(0, -1)) {
    m.content += ` [No longer shown, to save context; the files are ${m.images!.join(", ")}]`;
    delete m.images;
  }
}

export function repairToolPairs(messages: Message[]) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    let j = i + 1;
    const answered = new Set<string>();
    while (j < messages.length && messages[j].role === "tool") {
      answered.add((messages[j] as Extract<Message, { role: "tool" }>).tool_call_id);
      j++;
    }
    const missing = m.tool_calls.filter((c) => !answered.has(c.id));
    const filler: Message[] = missing.map((c) => ({ role: "tool", tool_call_id: c.id, content: "[not run: interrupted before this call finished]" }));
    messages.splice(j, 0, ...filler);
    i = j + filler.length - 1;
  }
}

function hostOf(url: unknown): string {
  try {
    return new URL(String(url)).hostname;
  } catch {
    return String(url);
  }
}

function safe<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

function clip(text: string, maxChars: number) {
  return text.length > maxChars ? "[earliest part cut]\n" + text.slice(-maxChars) : text;
}

// Split off the most recent messages (about `keepTokens`) to keep word for word. The split
// lands on a user message or an assistant message, never on a tool result, because a tool
// result must follow the assistant message that called it.
export function splitTail(messages: Message[], keepTokens: number): { head: Message[]; tail: Message[] } {
  let used = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    used += estimateTokens([messages[i]]);
    if (used > keepTokens) break;
    if (messages[i].role !== "tool") cut = i;
  }
  return { head: messages.slice(0, cut), tail: messages.slice(cut) };
}

// Keep the most recent `keepChars` of tool output verbatim; older tool output becomes a stub.
export function pruneToolOutputs(messages: Message[], keepChars: number): Message[] {
  let budget = keepChars;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== "tool") continue;
    if (budget > 0) {
      budget -= m.content.length;
      continue;
    }
    if (m.content.length > 200) out[i] = { ...m, content: m.content.slice(0, 200) + "\n[older tool output pruned]" };
  }
  return out;
}

function render(m: Message): string {
  switch (m.role) {
    case "user":
      return `USER: ${m.content}`;
    case "assistant": {
      const calls = (m.tool_calls ?? []).map((c) => `CALL ${c.function.name} ${c.function.arguments.slice(0, 600)}`).join("\n");
      return `ASSISTANT: ${m.content}${calls ? "\n" + calls : ""}`;
    }
    case "tool":
      return `RESULT: ${m.content.slice(0, 4000)}`;
    default:
      return "";
  }
}
