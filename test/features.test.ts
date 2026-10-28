// Plan mode, undo, hooks, permission rules, web page reading and the Claude provider, driven
// through the real agent loop against scripted fake servers (OpenAI format and Anthropic format).

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-features-"));
process.env.USERPROFILE = tmp; // sessions, snapshots and Claude Code settings come from here
process.env.HOME = tmp;

type Reply = { content?: string; calls?: [string, object][] };
let script: Reply[] = [];
let claudeScript: string[] = []; // raw SSE bodies for the Anthropic endpoint
const requests: any[] = [];
const claudeRequests: { body: any; headers: http.IncomingHttpHeaders }[] = [];
let server: http.Server;
let baseURL = "";

function openaiSse(reply: Reply): string {
  const chunks: string[] = [];
  const push = (delta: object, finish: string | null = null) => chunks.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (reply.content) push({ content: reply.content });
  (reply.calls ?? []).forEach(([name, args], i) => push({ tool_calls: [{ index: i, id: `call_${requests.length}_${i}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }));
  push({}, reply.calls?.length ? "tool_calls" : "stop");
  chunks.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 5 } })}\n\n`, "data: [DONE]\n\n");
  return chunks.join("");
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (req.url?.includes("/v1/messages")) {
        claudeRequests.push({ body: JSON.parse(body), headers: req.headers });
        return res.end(claudeScript.shift() ?? claudeText("done"));
      }
      requests.push(JSON.parse(body));
      res.end(openaiSse(script.shift() ?? { content: "done" }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => {
  server.close();
  // Background snapshots of the test folders may still be finishing.
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {}
});

const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const start = (input = 10) => ev("message_start", { message: { id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: input, output_tokens: 0, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 } } });
const stop = (reason: string) => ev("message_delta", { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 20 } }) + ev("message_stop", {});
function claudeText(text: string) {
  return start() + ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + ev("content_block_delta", { index: 0, delta: { type: "text_delta", text } }) + ev("content_block_stop", { index: 0 }) + stop("end_turn");
}
function claudeToolCall(name: string, input: object, reason = "tool_use") {
  return (
    start() +
    ev("content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }) +
    ev("content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "I should write it." } }) +
    ev("content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig-1" } }) +
    ev("content_block_stop", { index: 0 }) +
    ev("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_1", name, input: {} } }) +
    ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }) +
    ev("content_block_stop", { index: 1 }) +
    stop(reason)
  );
}

async function setup(opts: { yolo?: boolean; hooks?: object; provider?: "fake" | "claude" } = {}) {
  const { Agent } = await import("../src/agent.js");
  const { newSession } = await import("../src/session.js");
  const work = fs.mkdtempSync(path.join(tmp, "work-"));
  const claude = opts.provider === "claude";
  const config: any = {
    model: claude ? "anthropic/claude-opus-5-5" : "fake/m",
    smallModel: "fake/m",
    providers: {
      fake: { id: "fake", name: "Fake", baseURL: baseURL + "/v1", apiKey: "x", models: [{ id: "m", name: "m", context: 100_000, output: 8000, reasoning: false }] },
      anthropic: { id: "anthropic", name: "Anthropic", baseURL, apiKey: "k", format: "anthropic", models: [{ id: "claude-opus-5-5", name: "Opus", context: 1_000_000, output: 128_000, reasoning: true, vision: true }] },
    },
    permissions: { read: "allow" },
    bashAllow: [],
    maxSteps: 20,
    compactAt: 0.8,
    compactTokens: 200_000,
    defaultMode: "ask",
    idleCompact: false,
    idleCompactHours: 2.5,
    idleCompactMinTokens: 20_000,
    hooks: opts.hooks,
  };
  const session = newSession(work, config.model);
  const tools: string[] = [];
  const asked: string[] = [];
  const agent = new Agent({
    config,
    session,
    yolo: opts.yolo,
    tools: (await import("../src/agent.js")).BASE_TOOLS,
    events: {
      onToolEnd: (c, r) => tools.push(`${c.function.name}${r.error ? "!" : ""}`),
      ask: async (tool) => (asked.push(tool), { allow: true }),
    },
  });
  return { agent, session, work, tools, asked, config };
}

test("permission rules use Claude Code's syntax", async () => {
  const { parseRule, judge } = await import("../src/rules.js");
  const cwd = path.join(tmp, "proj");
  const rules = [
    ...parseRule("Bash(npm run test:*)", "allow"),
    ...parseRule("Bash(git push*)", "deny"),
    ...parseRule("Edit(src/**)", "allow"),
    ...parseRule("Read(.env)", "deny"),
    ...parseRule("WebFetch(domain:godotengine.org)", "allow"),
    ...parseRule("mcp__blockbench", "ask"),
  ];
  assert.equal(judge(rules, "bash", { command: "npm run test -- --watch" }, cwd)?.action, "allow");
  assert.equal(judge(rules, "bash", { command: "npm run testing" }, cwd), undefined);
  assert.equal(judge(rules, "bash", { command: "npm run test && git push origin" }, cwd)?.action, "deny");
  assert.equal(judge(rules, "bash", { command: "npm run test && rm x" }, cwd), undefined); // one part unmatched: no allow
  assert.equal(judge(rules, "edit", { path: "src/game/a.ts" }, cwd)?.action, "allow");
  assert.equal(judge(rules, "write", { path: "docs/a.md" }, cwd), undefined);
  assert.equal(judge(rules, "read", { path: ".env" }, cwd)?.action, "deny");
  assert.equal(judge(rules, "web_fetch", { url: "https://docs.godotengine.org/x" }, cwd)?.action, "allow");
  assert.equal(judge(rules, "web_fetch", { url: "https://evil.example/x" }, cwd), undefined);
  assert.equal(judge(rules, "mcp_call", { server: "blockbench", tool: "render" }, cwd)?.action, "ask");
});

test("deny rules from Claude Code's settings hold even in yolo mode", async () => {
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), JSON.stringify({ permissions: { deny: ["Write(secret.txt)"] } }));
  try {
    const { agent, work, tools } = await setup({ yolo: true });
    script = [{ calls: [["write", { path: "secret.txt", content: "x" }]] }, { content: "ok" }];
    requests.length = 0;
    await agent.run("write it");
    assert.deepEqual(tools, ["write!"]);
    assert.ok(!fs.existsSync(path.join(work, "secret.txt")));
    assert.match(requests[1].messages.find((m: any) => m.role === "tool").content, /was refused. A permission rule denies it/);
  } finally {
    fs.rmSync(path.join(tmp, ".claude"), { recursive: true, force: true });
  }
});

test("plan mode refuses changes, allows reading, and tells the model when it starts and ends", async () => {
  const { agent, session, work, tools } = await setup({ yolo: true });
  fs.writeFileSync(path.join(work, "a.txt"), "hi\n");
  session.permissionMode = "plan";
  script = [{ calls: [["read", { path: "a.txt" }], ["write", { path: "b.txt", content: "x" }]] }, { calls: [["bash", { description: "list", command: "ls" }]] }, { calls: [["bash", { description: "delete", command: "rm a.txt" }]] }, { content: "Plan: 1. write b.txt" }];
  requests.length = 0;
  await agent.run("plan it");
  assert.deepEqual(tools, ["read", "write!", "bash", "bash!"]);
  assert.ok(!fs.existsSync(path.join(work, "b.txt")));
  assert.ok(fs.existsSync(path.join(work, "a.txt")));
  assert.ok(requests[0].messages.some((m: any) => m.role === "user" && /Plan mode is now on/.test(m.content)));
  session.permissionMode = "edits";
  script = [{ content: "doing it" }];
  requests.length = 0;
  await agent.run("go ahead");
  assert.ok(requests[0].messages.some((m: any) => m.role === "user" && /Plan mode is now off/.test(m.content)));
});

test("undo puts files back and takes the message out of the conversation", async () => {
  const { agent, session, work } = await setup({ yolo: true });
  fs.writeFileSync(path.join(work, "keep.txt"), "original\n");
  fs.mkdirSync(path.join(work, "src"));
  fs.writeFileSync(path.join(work, "src", "gone.txt"), "will be deleted\n");
  // A folder's first snapshot is made in the background; make it now so both messages get one.
  await (await import("../src/snapshot.js")).snapshot(work, { wait: true });
  script = [{ content: "first done" }];
  await agent.run("first");
  const before = { messages: session.messages.length, history: session.history.length };
  script = [
    { calls: [["read", { path: "keep.txt" }]] },
    { calls: [["write", { path: "keep.txt", content: "changed\n" }], ["write", { path: "new/dir/made.txt", content: "new\n" }], ["bash", { description: "delete", command: "rm src/gone.txt" }]] },
    { content: "second done" },
  ];
  await agent.run("second");
  assert.equal(fs.readFileSync(path.join(work, "keep.txt"), "utf8"), "changed\n");
  assert.ok(!fs.existsSync(path.join(work, "src", "gone.txt")));
  const r = await agent.undo();
  assert.equal(r.text, "second");
  assert.equal(r.conversation, true);
  assert.deepEqual(r.files, ["keep.txt", "new/dir/made.txt", "src/gone.txt"]);
  assert.equal(fs.readFileSync(path.join(work, "keep.txt"), "utf8"), "original\n");
  assert.equal(fs.readFileSync(path.join(work, "src", "gone.txt"), "utf8"), "will be deleted\n");
  assert.ok(!fs.existsSync(path.join(work, "new")));
  assert.equal(session.messages.length, before.messages);
  assert.equal(session.history.length, before.history);
  // The project's own repository, if any, is untouched: the store lives under ~/.perch.
  assert.ok(!fs.existsSync(path.join(work, ".git")));
});

test("hooks can block a tool call and add context to a prompt", async () => {
  const node = JSON.stringify(process.execPath.replace(/\\/g, "/"));
  const hooks = {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `${node} -e "process.stderr.write('no shell today'); process.exit(2)"` }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `${node} -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('prompt was: '+JSON.parse(s).prompt))"` }] }],
  };
  const { agent, tools } = await setup({ yolo: true, hooks });
  script = [{ calls: [["bash", { description: "x", command: "echo hi" }]] }, { content: "ok" }];
  requests.length = 0;
  await agent.run("hello hooks");
  assert.deepEqual(tools, ["bash!"]);
  assert.ok(requests[0].messages.some((m: any) => m.role === "user" && /prompt was: hello hooks/.test(m.content)));
  assert.match(requests[1].messages.find((m: any) => m.role === "tool").content, /no shell today/);
});

test("web pages become readable text", async () => {
  const { htmlToText } = await import("../src/tools/web.js");
  const html = `<html><head><title>Docs &amp; more</title><script>var x=1</script></head><body><nav>menu</nav><main>
    <h2>Install</h2><p>Run <code>npm i</code> then see <a href="/guide">the guide</a>.</p><ul><li>one</li><li>two</li></ul>
    <pre><code>let a = 1 &lt; 2;</code></pre></main></body></html>`;
  const text = htmlToText(html, "https://example.com/docs/");
  assert.match(text, /^# Docs & more/);
  assert.match(text, /## Install/);
  assert.match(text, /\[the guide\]\(https:\/\/example\.com\/guide\)/);
  assert.match(text, /`npm i`/);
  assert.match(text, /- one\n- two/);
  assert.match(text, /```\nlet a = 1 < 2;\n```/);
  assert.doesNotMatch(text, /menu|var x/);
});

test("Claude: tools, thinking replay, caching and usage through the Messages API", async () => {
  const { agent, session, work, tools } = await setup({ yolo: true, provider: "claude" });
  claudeScript = [claudeToolCall("write", { path: "c.txt", content: "from claude\n" }), claudeText("Written.")];
  claudeRequests.length = 0;
  const out = await agent.run("write c.txt");
  assert.equal(out, "Written.");
  assert.deepEqual(tools, ["write"]);
  assert.equal(fs.readFileSync(path.join(work, "c.txt"), "utf8"), "from claude\n");
  const [first, second] = claudeRequests;
  assert.equal(first.headers.authorization, "Bearer k");
  assert.match(String(first.headers["anthropic-beta"]), /thinking-binding-controls-2026-08-01/);
  assert.equal(typeof first.body.system, "string");
  assert.ok(first.body.messages.every((m: any) => m.role !== "system"));
  assert.deepEqual(first.body.cache_control, { type: "ephemeral" });
  assert.equal(first.body.thinking.type, "adaptive");
  assert.equal(first.body.thinking.block_binding.prefix_mismatch_behavior, "drop_block");
  assert.equal(first.body.output_config.effort, "high");
  assert.equal(first.body.fallbacks, "default");
  assert.ok(first.body.tools.some((t: any) => t.name === "write" && t.input_schema && t.eager_input_streaming));
  // The second request replays the signed thinking block unchanged, then the tool call and its result.
  const assistant = second.body.messages.find((m: any) => m.role === "assistant");
  assert.deepEqual(assistant.content[0], { type: "thinking", thinking: "I should write it.", signature: "sig-1" });
  assert.deepEqual(assistant.content[1], { type: "tool_use", id: "toolu_1", name: "write", input: { path: "c.txt", content: "from claude\n" } });
  const result = second.body.messages.at(-1).content[0];
  assert.equal(result.type, "tool_result");
  assert.equal(result.tool_use_id, "toolu_1");
  // input counts cached and newly cached tokens, so the cache hit rate reads right
  assert.equal(session.usage.input, 2 * (10 + 900 + 50));
  assert.equal(session.usage.cacheHit, 1800);
  assert.ok((session.usage.cost ?? 0) > 0);
});

test("Claude: a tool call cut off by max_tokens is not run", async () => {
  const { agent, tools } = await setup({ yolo: true, provider: "claude" });
  claudeScript = [claudeToolCall("write", { path: "half.txt", content: "x" }, "max_tokens"), claudeText("Continued.")];
  claudeRequests.length = 0;
  const out = await agent.run("go");
  assert.equal(out, "Continued.");
  assert.deepEqual(tools, []);
  assert.match(JSON.stringify(claudeRequests[1].body.messages.at(-1)), /cut off by the output limit/);
});
