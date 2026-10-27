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

type Reply = { content?: string; reasoning?: string; calls?: [string, object][]; status?: number; error?: string };
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
      if (reply.status) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        return res.end(reply.error ?? "");
      }
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

test("retireOldImages keeps only the newest batch once there are too many", async () => {
  const { retireOldImages } = await import("../src/agent.js");
  const batch = (n: number, tag: string) => ({ role: "user" as const, content: "Images produced by the tool calls above (x):", images: Array.from({ length: n }, (_, i) => `${tag}-${i}.png`) });
  const few: any[] = [batch(3, "a"), batch(3, "b")];
  retireOldImages(few);
  assert.equal(few.filter((m: any) => m.images).length, 2, "under the limit nothing changes");

  const attached = { role: "user" as const, content: "look at this", images: ["mine.png"] };
  const many: any[] = [attached, batch(3, "a"), batch(3, "b"), batch(3, "c"), batch(3, "d"), batch(3, "e")];
  retireOldImages(many);
  const kept = many.filter((m: any) => m.images);
  assert.deepEqual(kept.map((m: any) => m.images[0]), ["mine.png", "e-0.png"], "the user's own image and the newest batch stay");
  assert.match((many[1] as any).content, /a-0\.png, a-1\.png, a-2\.png/);
});

test("a message sent while the agent works is read after the current step", async () => {
  const { agent } = await setup();
  script = [{ calls: [["list", { path: "." }]] }, { content: "done" }];
  requests.length = 0;
  const run = agent.run("look around");
  agent.steer("and say hello");
  assert.equal(await run, "done");
  const second = requests[1].messages.map((m: any) => m.role + ":" + (typeof m.content === "string" ? m.content : ""));
  assert.equal(second.at(-1), "user:and say hello", "it follows the tool result");
  assert.equal(second.at(-2).split(":")[0], "tool");
});

test("a message sent during a final reply gets its own reply", async () => {
  const { agent } = await setup();
  script = [{ content: "first answer" }, { content: "second answer" }];
  requests.length = 0;
  const run = agent.run("question");
  agent.steer("follow-up");
  assert.equal(await run, "second answer");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-1).content, "follow-up");
});

test("a context overflow from the provider is summarised and retried once", async () => {
  const { agent, session } = await setup();
  session.messages.push({ role: "system", content: "s" }, { role: "user", content: "old " + "x".repeat(80_000) }, { role: "assistant", content: "noted" });
  script = [
    { status: 400, error: `{"error":{"message":"This model's maximum context length is 131072 tokens. However, you requested 150000 tokens."}}` },
    { content: "## Objective\nOld work summarised." },
    { content: "recovered" },
  ];
  requests.length = 0;
  assert.equal(await agent.run("continue"), "recovered");
  assert.equal(requests.length, 3);
  assert.equal(session.compactions, 1);
  assert.ok(!JSON.stringify(requests[2].messages).includes("x".repeat(1000)), "the old bulk is gone");
  assert.equal(requests[2].messages.at(-1).content, "continue");
});

test("a second overflow in a row is reported, not retried forever", async () => {
  const { agent, session } = await setup();
  session.messages.push({ role: "system", content: "s" }, { role: "user", content: "old " + "x".repeat(80_000) }, { role: "assistant", content: "noted" });
  const overflow = { status: 400, error: "maximum context length is 1000 tokens" };
  script = [overflow, { content: "summary" }, overflow];
  requests.length = 0;
  await assert.rejects(agent.run("continue"), /maximum context length/);
  assert.equal(requests.length, 3);
});

test("isContextOverflow tells overflow from other errors", async () => {
  const { isContextOverflow, ProviderError } = await import("../src/provider.js");
  assert.ok(isContextOverflow(new ProviderError("DeepSeek returned 400: This model's maximum context length is 131072 tokens", 400)));
  assert.ok(isContextOverflow(new ProviderError("returned 413: too big", 413)));
  assert.ok(!isContextOverflow(new ProviderError("returned 429: too many tokens per minute", 429)));
  assert.ok(!isContextOverflow(new ProviderError("returned 400: invalid tool schema", 400)));
  assert.ok(!isContextOverflow(new Error("maximum context length")));
});
