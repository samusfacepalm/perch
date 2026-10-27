// Drives the real agent loop against a scripted fake OpenAI-compatible server.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perch-test-"));
process.env.USERPROFILE = tmp; // keep sessions and spill files out of the real ~/.perch
process.env.HOME = tmp;

type Reply = { content?: string; reasoning?: string; calls?: [string, object][] };
let script: Reply[] = [];
const requests: any[] = [];
let server: http.Server;
let baseURL = "";

function sse(reply: Reply): string {
  const chunks: string[] = [];
  const push = (delta: object, finish: string | null = null) =>
    chunks.push(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  if (reply.reasoning) push({ reasoning_content: reply.reasoning });
  if (reply.content) push({ content: reply.content });
  (reply.calls ?? []).forEach(([name, args], i) => {
    push({ tool_calls: [{ index: i, id: `call_${requests.length}_${i}`, type: "function", function: { name, arguments: "" } }] });
    const json = JSON.stringify(args);
    push({ tool_calls: [{ index: i, function: { arguments: json.slice(0, 5) } }] });
    push({ tool_calls: [{ index: i, function: { arguments: json.slice(5) } }] });
  });
  push({}, reply.calls?.length ? "tool_calls" : "stop");
  chunks.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800 } })}\n\n`);
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const reply = script.shift() ?? { content: "done" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseURL = `http://127.0.0.1:${(server.address() as any).port}/v1`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function setup(reasoning = true) {
  const { Agent } = await import("../src/agent.js");
  const { newSession } = await import("../src/session.js");
  const work = fs.mkdtempSync(path.join(tmp, "work-"));
  const config = {
    model: "fake/m",
    smallModel: "fake/m",
    providers: { fake: { id: "fake", name: "Fake", baseURL, apiKey: "x", models: [{ id: "m", name: "m", context: 100_000, output: 8000, reasoning }] } },
    permissions: {},
    bashAllow: [],
    maxSteps: 50,
    compactAt: 0.8,
    compactTokens: 200_000,
    idleCompact: true,
    idleCompactHours: 2.5,
    idleCompactMinTokens: 20_000,
  };
  const session = newSession(work, "fake/m");
  const tools: string[] = [];
  const agent = new Agent({ config, session, yolo: true, events: { onToolEnd: (c, r) => tools.push(`${c.function.name}${r.error ? "!" : ""}`) } });
  return { agent, session, work, tools };
}

test("write, read, edit and bash run through the loop", async () => {
  const { agent, session, work, tools } = await setup();
  script = [
    { reasoning: "plan", calls: [["todowrite", { todos: [{ content: "make file", status: "in_progress" }] }]] },
    { calls: [["write", { path: "a.txt", content: "hello\nworld\n" }]] },
    { calls: [["read", { path: "a.txt" }]] },
    { calls: [["edit", { path: "a.txt", old_string: "world", new_string: "perch" }]] },
    { calls: [["bash", { description: "show file", command: "cat a.txt" }]] },
    { content: "All done." },
  ];
  requests.length = 0;
  const out = await agent.run("make a file");
  assert.equal(out, "All done.");
  assert.equal(fs.readFileSync(path.join(work, "a.txt"), "utf8"), "hello\nperch\n");
  assert.deepEqual(tools, ["todowrite", "write", "read", "edit", "bash"]);
  assert.equal(session.todos[0].content, "make file");
  // reasoning_content is echoed back on every assistant message for reasoning models
  const last = requests[requests.length - 1];
  const assistants = last.messages.filter((m: any) => m.role === "assistant");
  assert.ok(assistants.every((m: any) => typeof m.reasoning_content === "string"));
  assert.equal(assistants[0].reasoning_content, "plan");
  // the bash tool result carried the file contents
  const bashResult = last.messages.filter((m: any) => m.role === "tool").pop();
  assert.match(bashResult.content, /perch/);
  assert.equal(session.usage.cacheHit, 800 * 6);
});

test("edit before read is refused and the model sees why", async () => {
  const { agent, work, tools } = await setup();
  fs.writeFileSync(path.join(work, "b.txt"), "x\n");
  script = [{ calls: [["edit", { path: "b.txt", old_string: "x", new_string: "y" }]] }, { content: "ok" }];
  requests.length = 0;
  await agent.run("edit b");
  assert.deepEqual(tools, ["edit!"]);
  const toolMsg = requests[1].messages.find((m: any) => m.role === "tool");
  assert.match(toolMsg.content, /must read/);
});

test("compaction keeps the system prompt, summary and recent tail", async () => {
  const { agent, session } = await setup();
  script = [{ content: "ok" }];
  await agent.run("first");
  for (let i = 0; i < 30; i++) {
    session.messages.push({ role: "user", content: `filler ${i} ` + "x".repeat(4000) });
    session.messages.push({ role: "assistant", content: "noted" });
  }
  script = [{ content: "## Objective\nTest the harness.\n" + "detail ".repeat(60) }];
  requests.length = 0;
  await agent.compact();
  assert.equal(requests.length, 1);
  // cache-friendly: same system prompt and tools as the main conversation
  assert.equal(requests[0].messages[0].content, session.messages[0].content);
  assert.ok(requests[0].tools?.length);
  assert.equal(session.messages[0].role, "system");
  assert.match(session.messages[1].content, /Test the harness/);
  assert.ok(session.messages.length < 62);
  assert.equal(session.compactions, 1);
});

test("unanswered tool calls get filler results", async () => {
  const { repairToolPairs } = await import("../src/agent.js");
  const msgs: any[] = [
    { role: "assistant", content: "", tool_calls: [{ id: "a", type: "function", function: { name: "read", arguments: "{}" } }, { id: "b", type: "function", function: { name: "read", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "ok" },
    { role: "user", content: "next" },
  ];
  repairToolPairs(msgs);
  assert.deepEqual(msgs.map((m) => m.role), ["assistant", "tool", "tool", "user"]);
  assert.equal(msgs[2].tool_call_id, "b");
});
