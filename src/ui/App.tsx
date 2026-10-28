// The terminal UI. Finished messages go into <Static> (printed once, part of normal terminal
// scrollback, like Claude Code); only the live area at the bottom re-renders.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import path from "node:path";
import { Agent, type Decision } from "../agent.js";
import { resolveModel, type PerchConfig } from "../config.js";
import { listSessions, saveSession, deleteSession, type Session } from "../session.js";
import type { Message } from "../provider.js";
import { formatTodos } from "../tools/todo.js";
import { Markdown } from "./Markdown.js";
import { Parrot, MiniParrot } from "./Parrot.js";

type Item =
  | { kind: "banner"; id: number }
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "tool"; id: number; name: string; summary: string; title?: string; error?: boolean; output?: string; diff?: string }
  | { kind: "note"; id: number; text: string; color?: string };

type NewItem = Item extends infer I ? (I extends Item ? Omit<I, "id"> : never) : never;

interface Props {
  config: PerchConfig;
  session: Session;
  yolo: boolean;
  autoContinue: boolean;
  firstPrompt?: string;
  models: string[];
}

interface Pending {
  tool: string;
  summary: string;
  args: any;
  resolve: (d: Decision) => void;
}

let nextId = 0;
const id = () => nextId++;

// The end of a streaming reply that fits in `rows` terminal rows at `width` columns. Ink redraws
// the whole live area on every frame, and once that area is taller than the terminal it can no
// longer erase it cleanly, so the full reply is printed only when it finishes.
export function tailLines(text: string, width: number, rows: number): string {
  const lines = text.split("\n");
  let used = 0;
  let i = lines.length;
  while (i > 0) {
    const h = Math.max(1, Math.ceil(lines[i - 1].length / Math.max(1, width)));
    if (used + h > rows) break;
    used += h;
    i--;
  }
  return i === 0 ? text : "…\n" + lines.slice(i).join("\n");
}

export function App({ config, session, yolo, autoContinue, firstPrompt, models }: Props) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [items, setItems] = useState<Item[]>(() => [{ kind: "banner", id: id() }, ...replay(session.history)]);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [thinking, setThinking] = useState("");
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [todos, setTodos] = useState(session.todos);
  const [, force] = useState(0);
  const historyIdx = useRef(-1);
  const sent = useRef<string[]>(session.history.filter((m) => m.role === "user").map((m) => m.content).filter((c) => !c.startsWith("[compacted]")));
  const startedAt = useRef(0);
  const [elapsed, setElapsed] = useState(0);
  const auto = useRef(autoContinue);

  const add = (item: NewItem) => setItems((xs) => [...xs, { ...item, id: id() } as Item]);
  const queuedRef = useRef<string[]>([]); // typed while busy, not yet read by the model
  const streamBuf = useRef<{ text: string; reasoning: string; timer?: NodeJS.Timeout }>({ text: "", reasoning: "" });
  const flushStream = () => {
    const b = streamBuf.current;
    b.timer = undefined;
    const { text, reasoning } = b;
    b.text = b.reasoning = "";
    if (text) setStreamText((t) => t + text);
    if (reasoning) setThinking((t) => (t + reasoning).slice(-400));
  };
  const dropStream = () => {
    clearTimeout(streamBuf.current.timer);
    streamBuf.current = { text: "", reasoning: "" };
  };

  const agent = useMemo(
    () =>
      new Agent({
        config,
        session,
        yolo,
        autoContinue: autoContinue,
        events: {
          // Chunks arrive far faster than Ink draws (30 frames a second), so they are gathered
          // and handed to React once per frame instead of re-rendering for every chunk.
          onStream: (e) => {
            if (e.type === "text") streamBuf.current.text += e.delta;
            if (e.type === "reasoning") streamBuf.current.reasoning += e.delta;
            streamBuf.current.timer ??= setTimeout(flushStream, 33);
          },
          onMessage: (m) => {
            // A message typed while Perch was busy shows once the model actually reads it.
            if (m.role === "user" && queuedRef.current.includes(m.content)) {
              queuedRef.current.splice(queuedRef.current.indexOf(m.content), 1);
              add({ kind: "user", text: m.content });
            }
            if (m.role === "assistant") {
              dropStream();
              setStreamText("");
              setThinking("");
              if (m.content.trim()) add({ kind: "assistant", text: m.content.trim() });
            }
          },
          onToolStart: () => setStatus(""),
          onToolEnd: (call, r) => {
            let args: any = {};
            try {
              args = JSON.parse(call.function.arguments || "{}");
            } catch {}
            const summary = summarizeCall(call.function.name, args);
            add({ kind: "tool", name: call.function.name, summary, title: r.title, error: r.error, output: r.output, diff: r.diff });
            if (call.function.name === "todowrite") setTodos([...session.todos]);
          },
          onStatus: (t) => setStatus(t),
          ask: (tool, summary, args) => new Promise<Decision>((resolve) => setPending({ tool, summary, args, resolve })),
          onUnsent: (texts) => {
            queuedRef.current = [];
            const v = texts.join("\n");
            setInput(v);
            setCursor(v.length);
          },
        },
      }),
    [],
  );

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const send = async (text: string) => {
    if (text.startsWith("/")) return command(text);
    sent.current.push(text);
    add({ kind: "user", text });
    setBusy(true);
    startedAt.current = Date.now();
    setElapsed(0);
    try {
      await agent.run(text);
    } catch (e: any) {
      if (e?.name !== "AbortError") add({ kind: "note", text: `Error: ${e?.message ?? e}`, color: "red" });
      else add({ kind: "note", text: "Interrupted.", color: "yellow" });
      saveSession(session);
    } finally {
      dropStream();
      setStreamText("");
      setThinking("");
      setStatus("");
      setBusy(false);
      setTodos([...session.todos]);
    }
  };

  const command = async (line: string) => {
    const [cmd, ...rest] = line.slice(1).split(" ");
    const arg = rest.join(" ").trim();
    switch (cmd) {
      case "exit":
      case "quit":
        saveSession(session);
        return exit();
      case "model":
        if (!arg) return add({ kind: "note", text: `Model: ${session.model}\nAvailable:\n${models.map((m) => "  " + m).join("\n")}` });
        try {
          resolveModel(config, arg);
          session.model = arg;
          saveSession(session);
          add({ kind: "note", text: `Model set to ${arg}.` });
        } catch (e: any) {
          add({ kind: "note", text: e.message, color: "red" });
        }
        return;
      case "compact":
        setBusy(true);
        try {
          await agent.compact();
        } catch (e: any) {
          add({ kind: "note", text: `Compaction failed: ${e.message}`, color: "red" });
        }
        setBusy(false);
        return;
      case "todos":
        return add({ kind: "note", text: formatTodos(session.todos) });
      case "undo":
        try {
          const r = await agent.undo();
          setInput(r.text);
          setCursor(r.text.length);
          return add({ kind: "note", text: `Undone: ${r.files.length ? `${r.files.length} file(s) put back: ${r.files.slice(0, 8).join(", ")}${r.files.length > 8 ? "…" : ""}` : "no files had changed"}.${r.conversation ? " The message is back in the input box." : " The conversation was summarised since, so Perch was told instead."}`, color: "yellow" });
        } catch (e: any) {
          return add({ kind: "note", text: e.message, color: "red" });
        }
      case "plan": {
        const on = session.permissionMode !== "plan";
        session.permissionMode = on ? "plan" : undefined;
        saveSession(session);
        return add({ kind: "note", text: on ? "Plan mode on: Perch reads, searches and presents a plan, and changes nothing. /plan again to let it carry the plan out." : "Plan mode off: Perch can make changes again." });
      }
      case "auto":
        auto.current = !auto.current;
        agent.opts.autoContinue = auto.current;
        return add({ kind: "note", text: `Auto-continue ${auto.current ? "on: the agent keeps going while todos are open" : "off"}.` });
      case "sessions": {
        const list = listSessions(session.cwd).slice(0, 15);
        return add({ kind: "note", text: list.length ? list.map((s) => `${s.id}  ${s.updated.slice(0, 16).replace("T", " ")}  ${s.title}`).join("\n") + "\n\nResume one with: perch -r <id>" : "No sessions for this folder." });
      }
      case "delete":
        if (!arg) return add({ kind: "note", text: "Usage: /delete <session id>" });
        if (arg === session.id) return add({ kind: "note", text: "That is the current session.", color: "red" });
        deleteSession(arg);
        return add({ kind: "note", text: `Deleted ${arg}.` });
      case "cd": {
        if (!arg) return add({ kind: "note", text: `Working directory: ${session.cwd}` });
        const dir = path.resolve(session.cwd, arg);
        session.cwd = dir;
        session.scratch = false;
        saveSession(session);
        return add({ kind: "note", text: `Working directory is now ${dir}. Tools use it from the next message.` });
      }
      case "status": {
        const u = session.usage;
        const { provider, model } = resolveModel(config, session.model);
        const pct = Math.round((agent.contextTokens / model.context) * 100);
        return add({
          kind: "note",
          text: [
            `Session ${session.id}  "${session.title}"`,
            `Folder  ${session.cwd}${session.scratch ? " (scratch)" : ""}`,
            `Model   ${session.model} via ${provider.baseURL} (key from ${provider.keySource ?? "nowhere"})`,
            `Context ~${agent.contextTokens} tokens (${pct}% of ${model.context}), compacted ${session.compactions}x`,
            `Tokens  in ${u.input}, of which cached ${u.cacheHit} (${u.input ? Math.round((u.cacheHit / u.input) * 100) : 0}%), out ${u.output}`,
          ].join("\n"),
        });
      }
      case "help":
      default:
        return add({
          kind: "note",
          text: `/model [provider/model]  show or switch model
/status                  folder, model, context use, cache hits
/todos                   show the todo list
/compact                 summarise the conversation now
/plan                    toggle plan mode: read and plan only, change nothing
/undo                    put files back as they were before your last message, and take it back
/auto                    toggle auto-continue while todos are open
/cd <folder>             change working folder (e.g. move a scratch session into a project)
/sessions  /delete <id>  list or delete sessions
/exit                    save and quit
Keys: Enter send, Ctrl+J or Shift+Enter new line, Esc interrupt, Up/Down history, Ctrl+C twice quit`,
        });
    }
  };

  useEffect(() => {
    if (firstPrompt) void send(firstPrompt);
  }, []);

  const lastCtrlC = useRef(0);
  usePaste((text) => {
    if (pending) return;
    const clean = text.replace(/\r\n?/g, "\n");
    setInput((v) => v.slice(0, cursor) + clean + v.slice(cursor));
    setCursor((c) => c + clean.length);
  });

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") {
      if (busy) {
        agent.abort();
        return;
      }
      if (Date.now() - lastCtrlC.current < 1500) {
        saveSession(session);
        return exit();
      }
      lastCtrlC.current = Date.now();
      setStatus("Press Ctrl+C again to quit.");
      return;
    }
    if (pending) {
      const answer = ch.toLowerCase();
      const done = (d: Decision) => {
        pending.resolve(d);
        setPending(null);
      };
      if (answer === "y" || key.return) done({ allow: true });
      else if (answer === "a") done({ allow: true, always: true });
      else if (answer === "n" || key.escape) done({ allow: false });
      return;
    }
    if (key.escape) {
      if (busy) agent.abort();
      return;
    }
    if (key.return && !key.shift) {
      const text = input.trim();
      if (!text) return;
      if (busy && text.startsWith("/")) return setStatus("Commands wait until Perch finishes; Esc stops it.");
      setInput("");
      setCursor(0);
      historyIdx.current = -1;
      if (busy) {
        // Perch reads it after the current step, without being interrupted.
        sent.current.push(text);
        queuedRef.current.push(text);
        agent.steer(text);
        return;
      }
      void send(text);
      return;
    }
    if ((key.return && key.shift) || (key.ctrl && ch === "j")) {
      setInput((v) => v.slice(0, cursor) + "\n" + v.slice(cursor));
      setCursor((c) => c + 1);
      return;
    }
    if (key.upArrow || key.downArrow) {
      const h = sent.current;
      if (!h.length) return;
      let i = historyIdx.current;
      i = key.upArrow ? (i < 0 ? h.length - 1 : Math.max(0, i - 1)) : i < 0 ? -1 : i + 1;
      if (i >= h.length) i = -1;
      historyIdx.current = i;
      const v = i < 0 ? "" : h[i];
      setInput(v);
      setCursor(v.length);
      return;
    }
    if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.rightArrow) return setCursor((c) => Math.min(input.length, c + 1));
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setInput((v) => v.slice(0, cursor - 1) + v.slice(cursor));
      setCursor((c) => c - 1);
      return;
    }
    if (key.ctrl && ch === "u") {
      setInput("");
      setCursor(0);
      return;
    }
    if (ch && !key.ctrl && !key.meta) {
      setInput((v) => v.slice(0, cursor) + ch + v.slice(cursor));
      setCursor((c) => c + ch.length);
    }
  });

  const open = todos.filter((t) => t.status !== "completed" && t.status !== "cancelled");
  const width = Math.max(40, columns - 2);

  return (
    <>
      <Static items={items}>{(item) => <ItemView key={item.id} item={item} session={session} width={width} />}</Static>
      <Box flexDirection="column">
        {busy && thinking && !streamText && (
          <Text dimColor italic wrap="truncate-end">
            {"  thinking: " + thinking.replace(/\s+/g, " ").slice(-(width - 14))}
          </Text>
        )}
        {streamText && (
          <Box marginLeft={2}>
            <Text>{tailLines(streamText, width - 2, Math.max(5, rows - 10 - (open.length ? todos.length + 1 : 0)))}</Text>
          </Box>
        )}
        {todos.length > 0 && open.length > 0 && (
          <Box flexDirection="column" marginTop={1} marginLeft={2}>
            {todos.map((t, i) => (
              <Text key={i} color={t.status === "in_progress" ? "cyan" : undefined} dimColor={t.status === "completed" || t.status === "cancelled"} strikethrough={t.status === "cancelled"}>
                {t.status === "completed" ? "✔" : t.status === "in_progress" ? "▸" : "○"} {t.content}
              </Text>
            ))}
          </Box>
        )}
        {pending && <PermissionPrompt pending={pending} width={width} />}
        {status && (
          <Text color="yellow" wrap="truncate-end">
            {"  " + status}
          </Text>
        )}
        {busy && !pending && (
          <Text>
            {"  "}
            <MiniParrot tick={elapsed} /> <Text color="magenta">working {elapsed}s</Text> <Text dimColor>(Esc to interrupt)</Text>
          </Text>
        )}
        <Box borderStyle="round" borderColor={busy ? "gray" : "cyan"} paddingX={1} width={width} marginTop={1}>
          <Text>
            <Text color="cyan">{"> "}</Text>
            {input.slice(0, cursor)}
            <Text inverse>{input[cursor] ?? " "}</Text>
            {input.slice(cursor + 1)}
            {busy && !input && <Text dimColor>Perch reads anything you send here after its current step</Text>}
          </Text>
        </Box>
        <Text dimColor wrap="truncate-end">
          {"  "}
          {session.model} · {shortPath(session.cwd)}
          {session.scratch ? " (no folder)" : ""} · ctx {Math.round(agent.contextTokens / 1000)}k
          {yolo ? " · yolo" : ""}
          {auto.current ? " · auto" : ""} · /help
        </Text>
      </Box>
    </>
  );
}

function shortPath(p: string) {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

function summarizeCall(name: string, a: any): string {
  switch (name) {
    case "bash":
      return a.command ?? "";
    case "read":
    case "write":
    case "edit":
    case "list":
      return a.path ?? "";
    case "glob":
      return a.pattern ?? "";
    case "grep":
      return `/${a.pattern ?? ""}/${a.include ? " " + a.include : ""}`;
    case "task":
      return a.description ?? "";
    case "todowrite":
      return "";
    default:
      return JSON.stringify(a).slice(0, 80);
  }
}

function PermissionPrompt({ pending, width }: { pending: Pending; width: number }) {
  const detail =
    pending.tool === "bash"
      ? pending.args.command
      : pending.tool === "edit"
        ? [pending.args.path, ...(Array.isArray(pending.args.edits) && pending.args.edits.length ? pending.args.edits : [pending.args]).slice(0, 4).map((e: any) => `- ${String(e.old_string).split("\n").slice(0, 8).join("\n- ")}\n+ ${String(e.new_string).split("\n").slice(0, 8).join("\n+ ")}`)].join("\n")
        : pending.tool === "write"
          ? `${pending.args.path} (${String(pending.args.content ?? "").split("\n").length} lines)`
          : pending.summary;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} width={width}>
      <Text color="yellow" bold>
        Allow {pending.tool}?
      </Text>
      <Text>{detail}</Text>
      {pending.args?.description && <Text dimColor>{pending.args.description}</Text>}
      <Text>
        <Text color="green">y</Text>es · <Text color="green">a</Text>lways (this session) · <Text color="red">n</Text>o
      </Text>
    </Box>
  );
}

function ItemView({ item, session, width }: { item: Item; session: Session; width: number }) {
  switch (item.kind) {
    case "banner":
      return (
        <Box borderStyle="round" borderColor="cyan" paddingX={1} width={Math.min(width, 72)}>
          <Parrot />
          <Box flexDirection="column" justifyContent="center">
            <Text bold color="cyan">
              perch
            </Text>
            <Text dimColor>{session.model}</Text>
            <Text dimColor>{session.scratch ? `no folder (scratch: ${shortPath(session.cwd)})` : shortPath(session.cwd)}</Text>
            <Text dimColor>/help for commands</Text>
          </Box>
        </Box>
      );
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan">{"> "}</Text>
          <Text>{item.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1} marginLeft={2}>
          <Markdown text={item.text} />
        </Box>
      );
    case "note":
      return (
        <Box marginTop={1} marginLeft={2}>
          <Text color={item.color ?? "gray"}>{item.text}</Text>
        </Box>
      );
    case "tool":
      return <ToolView item={item} width={width} />;
  }
}

function ToolView({ item, width }: { item: Extract<Item, { kind: "tool" }>; width: number }) {
  const head = (
    <Text wrap="truncate-end">
      <Text color={item.error ? "red" : "green"}>● </Text>
      <Text bold>{item.name}</Text> <Text dimColor>{item.summary.split("\n")[0].slice(0, width - item.name.length - 6)}</Text>
    </Text>
  );
  let body: React.ReactNode = null;
  if (item.diff) {
    const lines = item.diff.split("\n").slice(4).filter((l) => !l.startsWith("\\"));
    const shown = lines.slice(0, 30);
    body = (
      <Box flexDirection="column" marginLeft={2}>
        {shown.map((l, i) => (
          <Text key={i} color={l.startsWith("+") ? "green" : l.startsWith("-") ? "red" : l.startsWith("@@") ? "cyan" : undefined} dimColor={!/^[+-@]/.test(l)} wrap="truncate-end">
            {l}
          </Text>
        ))}
        {lines.length > 30 && <Text dimColor>… {lines.length - 30} more lines</Text>}
      </Box>
    );
  } else if (item.error) {
    body = (
      <Box marginLeft={2}>
        <Text color="red">{(item.output ?? "").split("\n").slice(0, 6).join("\n")}</Text>
      </Box>
    );
  } else if (item.name === "bash" || item.name === "task") {
    const lines = (item.output ?? "").split("\n");
    body = (
      <Box flexDirection="column" marginLeft={2}>
        <Text dimColor>{lines.slice(0, item.name === "task" ? 12 : 6).join("\n")}</Text>
        {lines.length > (item.name === "task" ? 12 : 6) && <Text dimColor>… {lines.length - (item.name === "task" ? 12 : 6)} more lines</Text>}
      </Box>
    );
  } else if (item.name === "todowrite") {
    return null;
  } else if (item.title) {
    body = (
      <Box marginLeft={2}>
        <Text dimColor>⎿ {item.title}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" marginTop={1}>
      {head}
      {body}
    </Box>
  );
}

// Rebuild the transcript from a saved session when resuming.
function replay(history: Message[]): Item[] {
  const out: Item[] = [];
  const calls = new Map<string, { name: string; args: any }>();
  for (const m of history) {
    if (m.role === "user") {
      if (m.content.startsWith("[compacted]")) out.push({ kind: "note", id: id(), text: "(earlier conversation summarised)" });
      else out.push({ kind: "user", id: id(), text: m.content });
    } else if (m.role === "assistant") {
      if (m.content.trim()) out.push({ kind: "assistant", id: id(), text: m.content.trim() });
      for (const c of m.tool_calls ?? []) {
        let args: any = {};
        try {
          args = JSON.parse(c.function.arguments || "{}");
        } catch {}
        calls.set(c.id, { name: c.function.name, args });
      }
    } else if (m.role === "tool") {
      const c = calls.get(m.tool_call_id);
      if (c && c.name !== "todowrite") out.push({ kind: "tool", id: id(), name: c.name, summary: summarizeCall(c.name, c.args), error: m.content.startsWith("Error"), output: m.content });
    }
  }
  return out;
}
