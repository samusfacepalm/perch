import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Marked } from "marked";
import type { PerchApi } from "../preload.js";
import { BIRDS, BIRD_URLS, mascot } from "./mascots.js";
import { Composer } from "./Composer.js";
import { bus, Lightbox, ShotsPanel, Thumbs } from "./gallery.js";
import { PlayButton, PlayCard, type PlayResult } from "./play.js";

declare global {
  interface Window {
    perch: PerchApi;
  }
}
const api = window.perch;

// ---------- types shared with the main process (kept loose on purpose) ----------

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}
type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: string[] }
  | { role: "assistant"; content: string; reasoning_content?: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };
interface Todo {
  content: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
}
interface Snapshot {
  id: string;
  title: string;
  cwd: string;
  scratch: boolean;
  model: string;
  history: Message[];
  todos: Todo[];
  usage: {
    input: number;
    output: number;
    cacheHit: number;
    reasoning: number;
    cost?: number;
    byModel?: Record<string, { input: number; output: number; cacheHit: number; cost: number; priced: boolean; requests: number }>;
  };
  compactions: number;
  compactAt: number;
  permissionMode?: "ask" | "edits" | "all" | "plan";
  keepGoing?: boolean;
  undo?: string | null; // the message an undo would take back
  undos?: number;
  thinking?: "off" | "low" | "high" | "max";
  contextTokens: number;
  contextWindow: number;
  busy: boolean;
}
interface ModelChoice {
  ref: string;
  name: string;
  provider: string;
  hasKey: boolean;
  vision?: boolean;
  thinkingLevels?: boolean;
}
interface KeyInfo {
  id: string;
  name: string;
  baseURL: string;
  keySource: string | null;
  local: boolean;
  models: number;
}
interface AllUsage {
  total: { cost: number; input: number; output: number; cacheHit: number; sessions: number };
  day: { cost: number; input: number; output: number };
  week: { cost: number; input: number; output: number };
  byModel: Record<string, { cost: number; input: number; output: number; cacheHit: number; requests: number; priced: boolean }>;
  deepseekPeak: boolean;
}
interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  updated: string;
  messages: number;
}
interface Ask {
  reqId: number;
  tool: string;
  summary: string;
  args: any;
}
interface ToolMeta {
  images?: string[];
  title?: string;
  diff?: string;
  error?: boolean;
  running?: boolean;
}
interface Live {
  snap: Snapshot;
  stream: string;
  thinking: string;
  status: string;
  error: string;
  ask: Ask | null;
  meta: Record<string, ToolMeta>;
  startedAt: number;
  shotsKey?: number; // bumps when new images arrive, to refresh the gallery
  statusLog?: string[]; // status messages this session, kept for verbose mode
}

// ---------- markdown ----------

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const md = new Marked({ async: false, gfm: true, breaks: false });
// Raw HTML from the model is shown as text, never rendered.
md.use({ renderer: { html: (token: any) => escapeHtml(token.text ?? "") } });
const renderMd = (text: string) => md.parse(text) as string;

function MD({ text }: { text: string }) {
  const html = useMemo(() => renderMd(text), [text]);
  return (
    <div
      className="md"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (a) {
          e.preventDefault();
          window.open(a.getAttribute("href") ?? "", "_blank");
        }
      }}
    />
  );
}

// ---------- the parrot ----------

// The parrot is vector art in electron/parrot.svg; scripts/icon.mjs builds the app icon from it.
export function Parrot({ size = 48 }: { size?: number; blink?: boolean }) {
  const [id, setId] = useState(mascot.get());
  useEffect(() => mascot.subscribe(setId), []);
  const bird = BIRDS.find((b) => b.id === id);
  return <img src={BIRD_URLS[id]} width={size} height={size} alt={bird?.name ?? "Perch parrot"} draggable={false} style={{ display: "block" }} />;
}

// A parrot with opinions: now and then it cocks its head or hops on its own, and a click makes it
// squawk something cheeky.
const SQUAWKS = [
  "Squawk! Ship it!",
  "I bite things to check they're real metal.",
  "Who's a pretty coder? You are.",
  "Crackers first, then code.",
  "I saw that typo.",
  "Feisty, not grumpy.",
  "Is that a bug? I'll eat it.",
  "Pieces of eight! Er, bytes.",
  "Polly wants a passing test.",
  "Don't make me peck the compiler.",
];

// The flightless birds come down from the branch by parachute: the kākāpō spreads its stubby
// wings, as real ones do, and the kiwi, having no wings worth spreading, brings a parachute.
const FLIGHTLESS = new Set(["kiwi", "kakapo"]);

function Chute({ bird }: { bird: string }) {
  if (bird === "kiwi") {
    return (
      <svg className="chute" viewBox="0 0 40 30" aria-hidden>
        <path d="M2 14 Q 20 -6 38 14 Z" fill="#e5534b" />
        <path d="M11 14 Q 14 2 20 1 Q 26 2 29 14 Z" fill="#fff6e8" />
        <path d="M17 14 Q 18 3 20 1 Q 22 3 23 14 Z" fill="#e5534b" />
        <path d="M2 14 L 20 30 M11 14 L 20 30 M29 14 L 20 30 M38 14 L 20 30" stroke="#d8d2c4" strokeWidth="0.8" />
      </svg>
    );
  }
  const wing = <svg viewBox="0 0 30 14"><path d="M30 7 C 20 0 6 0 0 6 C 8 8 18 12 30 10 Z" fill="#80a33a" /><path d="M24 6 L 10 4 M22 9 L 8 7" stroke="#4f6e22" strokeWidth="1" /></svg>;
  return (
    <>
      <span className="glide l" aria-hidden>{wing}</span>
      <span className="glide r" aria-hidden>{wing}</span>
    </>
  );
}

function CheekyParrot({ size }: { size: number }) {
  const [say, setSay] = useState<string | null>(null);
  const [fidget, setFidget] = useState("");
  const [bird, setBird] = useState(mascot.get());
  useEffect(() => mascot.subscribe(setBird), []);
  const last = useRef(-1);
  useEffect(() => {
    const i = setInterval(() => {
      const moves = ["idle-cock", "idle-hop", "idle-ruffle", ...(FLIGHTLESS.has(mascot.get()) ? ["idle-parachute", "idle-parachute"] : [])];
      const m = moves[Math.floor(Math.random() * moves.length)];
      setFidget(m);
      setTimeout(() => setFidget(""), m === "idle-parachute" ? 2600 : 1200);
    }, 7000 + Math.random() * 4000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    if (!say) return;
    const t = setTimeout(() => setSay(null), 2600);
    return () => clearTimeout(t);
  }, [say]);
  const squawk = () => {
    let n = Math.floor(Math.random() * SQUAWKS.length);
    if (n === last.current) n = (n + 1) % SQUAWKS.length;
    last.current = n;
    setSay(SQUAWKS[n]);
    setFidget("idle-squawk");
    setTimeout(() => setFidget(""), 600);
  };
  return (
    <button className={`cheeky ${fidget}`} onClick={squawk} title="Poke the parrot">
      {say && <span className="squawk" key={say}>{say}</span>}
      {fidget === "idle-parachute" && <Chute bird={bird} />}
      <Parrot size={size} />
    </button>
  );
}

// Choose the mascot: click the bird at the top of the sidebar.
function MascotPicker({ onClose }: { onClose: () => void }) {
  const [id, setId] = useState(mascot.get());
  useEffect(() => mascot.subscribe(setId), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="mascot-back" onClick={onClose}>
      <div className="mascot-picker" onClick={(e) => e.stopPropagation()}>
        <div className="mascot-title">Choose your bird</div>
        <div className="mascot-grid">
          {BIRDS.map((b) => (
            <button key={b.id} className={`mascot ${id === b.id ? "on" : ""}`} onClick={() => mascot.set(b.id)} title={b.name}>
              <img src={BIRD_URLS[b.id]} alt="" />
              <span>{b.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// The parrot keeps you company while Perch works. What it does depends on what Perch is doing:
// a curious head tilt while thinking, a chatty bob while writing, and a rotating repertoire of
// dance moves while tools run. All CSS transforms, so it costs nothing.
const DANCES = ["bob", "hop", "wiggle", "spin", "flap", "moonwalk", "sway", "headbang", "tiptoe", "strut", "peck", "puff", "backflip"];
const QUIPS: Record<string, string[]> = {
  thinking: ["Pondering…", "Tilting head thoughtfully…", "Consulting the flock…", "Having a think…"],
  writing: ["Squawking out an answer…", "Writing it up…", "Choosing words carefully…"],
  tools: [
    "Working…",
    "Cracking a seed…",
    "Ruffling feathers…",
    "Pecking at the code…",
    "Rearranging the nest…",
    "Squawking at the compiler…",
    "Hunting for crackers…",
    "Preening the pixels…",
    "Doing a little dance…",
    "Flapping about productively…",
  ],
};

function WorkingParrot({ startedAt, activity }: { startedAt: number; activity: "thinking" | "writing" | "tools" }) {
  const [tick, setTick] = useState(0);
  const [bird, setBird] = useState(mascot.get());
  useEffect(() => mascot.subscribe(setBird), []);
  useEffect(() => {
    const i = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(i);
  }, []);
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  // A new move every 2.5 seconds, never the same one twice in a row.
  const step = Math.floor(tick / 2.5);
  const dance = FLIGHTLESS.has(bird) && step % 3 === 0 ? "parachute" : DANCES[(step * 7 + Math.floor(startedAt / 1000)) % DANCES.length];
  const move = activity === "thinking" ? "tilt" : activity === "writing" ? "chatter" : dance;
  const quips = QUIPS[activity];
  const quip = quips[Math.floor(tick / 4 + startedAt / 1000) % quips.length];
  return (
    <div className="working">
      <span className={`dancer move-${move}`} key={move + step}>
        {move === "parachute" && <Chute bird={bird} />}
        <Parrot size={44} />
        {move === "sway" && (
          <>
            <span className="note n1">♪</span>
            <span className="note n2">♫</span>
          </>
        )}
        {move === "tilt" && <span className="note think">?</span>}
        {move === "spin" && <span className="note sparkle">✦</span>}
      </span>
      <span>
        {quip} <span className="muted">{secs}s</span>
      </span>
    </div>
  );
}

// ---------- helpers ----------

function parseArgs(s: string): any {
  try {
    return JSON.parse(s || "{}");
  } catch {
    return {};
  }
}

function callSummary(name: string, a: any): string {
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
      return `${a.todos?.length ?? 0} items`;
    default:
      return "";
  }
}

const base = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

// ---------- transcript pieces ----------

function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n").slice(4).filter((l) => !l.startsWith("\\"));
  return (
    <pre className="diff">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "ctx"}>
          {l || " "}
        </div>
      ))}
    </pre>
  );
}

function ToolCard({ call, output, meta, verbose }: { call: ToolCall; output?: string; meta?: ToolMeta; verbose?: boolean }) {
  const args = parseArgs(call.function.arguments);
  const name = call.function.name;
  const error = meta?.error ?? (output ? /^Error|declined/.test(output) : false);
  const running = output === undefined;
  const [open, setOpen] = useState(!!verbose);
  useEffect(() => setOpen(!!verbose), [verbose]);
  if (name === "todowrite") return null;
  const hasBody = !!(meta?.diff || output);
  const autoOpen = !!meta?.diff && !open;
  return (
    <div className={`tool ${error ? "err" : ""} ${running ? "running" : ""}`}>
      <button className="tool-head" onClick={() => hasBody && setOpen((o) => !o)}>
        <span className="dot" />
        <span className="tname">{name}</span>
        <span className="targ">{callSummary(name, args)}</span>
        {meta?.title && name !== "bash" && <span className="ttitle">{meta.title}</span>}
        {hasBody && <span className="chev">{open ? "▾" : "▸"}</span>}
      </button>
      {args.description && name === "bash" && <div className="tdesc">{args.description}</div>}
      {verbose && <pre className="targs">{JSON.stringify(args, null, 2)}</pre>}
      {(autoOpen || open) && meta?.diff && <DiffView diff={meta.diff} />}
      {meta?.images?.length ? <Thumbs paths={meta.images} /> : null}
      {open && output && !meta?.diff && <pre className="tout">{output}</pre>}
      {!open && !meta?.diff && error && output && <pre className="tout">{output.split("\n").slice(0, 4).join("\n")}</pre>}
    </div>
  );
}

const MemoToolCard = React.memo(ToolCard);

const UserMsg = React.memo(function UserMsg({ text, images }: { text: string; images?: string[] }) {
  return (
    <div className="msg user">
      <div className="bubble">
        {images?.length ? <Thumbs paths={images} /> : null}
        {text}
      </div>
    </div>
  );
});

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

// A finished reply's reasoning: folded to one line, or open in verbose mode.
const ThoughtBlock = React.memo(function ThoughtBlock({ text, verbose }: { text: string; verbose?: boolean }) {
  const [open, setOpen] = useState(!!verbose);
  useEffect(() => setOpen(!!verbose), [verbose]);
  return (
    <div className={`thought ${open ? "open" : ""}`}>
      <button className="thought-head" onClick={() => setOpen((o) => !o)}>
        <span className="chev">{open ? "▾" : "▸"}</span> Thought for {words(text).toLocaleString()} words
      </button>
      {open && <div className="thought-body">{text}</div>}
    </div>
  );
});

// Reasoning as it streams in, scrolled to the newest line.
function ThinkingBox({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);
  return (
    <div className="thought open live">
      <div className="thought-head">
        <span className="thinking-dot" /> Thinking… {words(text).toLocaleString()} words
      </div>
      <div className="thought-body" ref={box}>
        {text}
      </div>
    </div>
  );
}

const AssistantMsg = React.memo(function AssistantMsg({ text }: { text: string }) {
  return (
    <div className="msg assistant">
      <MD text={text} />
    </div>
  );
});

const PAGE = 150;

// Re-renders only when the history or tool metadata changes, never for streamed text.
// Long sessions show their latest items, with a button to load earlier ones.
const Transcript = React.memo(function Transcript({ history, meta, verbose }: { history: Message[]; meta: Record<string, ToolMeta>; verbose: boolean }) {
  const [shown, setShown] = useState(PAGE);
  const items = useMemo(() => {
    const results = new Map<string, string>();
    for (const m of history) if (m.role === "tool") results.set(m.tool_call_id, m.content);
    const out: { key: string; node: (meta: Record<string, ToolMeta>) => React.ReactNode }[] = [];
    history.forEach((m, i) => {
      if (m.role === "user") {
        if (m.content.startsWith("[compacted]")) out.push({ key: `c${i}`, node: () => <div className="compacted">Earlier conversation summarised</div> });
        else out.push({ key: `u${i}`, node: () => <UserMsg text={m.content} images={m.images} /> });
      } else if (m.role === "assistant") {
        if (m.reasoning_content?.trim()) out.push({ key: `t${i}`, node: () => <ThoughtBlock text={m.reasoning_content!} verbose={verbose} /> });
        if (m.content.trim()) out.push({ key: `a${i}`, node: () => <AssistantMsg text={m.content} /> });
        for (const c of m.tool_calls ?? []) {
          if (c.function.name === "todowrite") continue;
          const output = results.get(c.id);
          out.push({ key: c.id, node: (mt) => <MemoToolCard call={c} output={output} meta={mt[c.id]} verbose={verbose} /> });
        }
      }
    });
    return out;
  }, [history, verbose]);
  const start = Math.max(0, items.length - shown);
  return (
    <>
      {start > 0 && (
        <button className="earlier" onClick={() => setShown((n) => n + PAGE)}>
          Show {Math.min(PAGE, start)} earlier items ({start} hidden)
        </button>
      )}
      {items.slice(start).map((it) => (
        <React.Fragment key={it.key}>{it.node(meta)}</React.Fragment>
      ))}
    </>
  );
});

// The live tail: streamed reply and thinking. The only part that changes while a reply streams.
function LiveTail({ live, verbose }: { live: Live; verbose: boolean }) {
  return (
    <>
      {verbose && live.statusLog?.length ? (
        <div className="status-log">
          {live.statusLog.map((s, i) => (
            <div key={i}>{s}</div>
          ))}
        </div>
      ) : null}
      {live.snap.busy && live.thinking && !live.stream && <ThinkingBox text={live.thinking} />}
      {live.stream && (
        <div className="msg assistant streaming">
          <StreamText text={live.stream} />
        </div>
      )}
    </>
  );
}

// Markdown parsing is cheap but not free; while streaming, parse at most ~8 times a second.
function StreamText({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    const wait = 120 - (Date.now() - last.current);
    if (wait <= 0) {
      last.current = Date.now();
      setShown(text);
      return;
    }
    const t = setTimeout(() => {
      last.current = Date.now();
      setShown(text);
    }, wait);
    return () => clearTimeout(t);
  }, [text]);
  return <MD text={shown} />;
}

function PermissionCard({ ask, onAnswer }: { ask: Ask; onAnswer: (d: { allow: boolean; always?: boolean; feedback?: string }) => void }) {
  const [feedback, setFeedback] = useState("");
  const a = ask.args ?? {};
  let detail: React.ReactNode = <code>{ask.summary}</code>;
  if (ask.tool === "bash") detail = <pre className="cmd">{a.command}</pre>;
  if (ask.tool === "edit")
    detail = (
      <>
        <div className="path">{a.path}</div>
        {(Array.isArray(a.edits) && a.edits.length ? a.edits : [a]).map((e: any, n: number) => (
          <pre className="diff" key={n}>
            {String(e.old_string ?? "").split("\n").map((l: string, i: number) => (
              <div key={"o" + i} className="del">- {l}</div>
            ))}
            {String(e.new_string ?? "").split("\n").map((l: string, i: number) => (
              <div key={"n" + i} className="add">+ {l}</div>
            ))}
          </pre>
        ))}
      </>
    );
  if (ask.tool === "write")
    detail = (
      <>
        <div className="path">{a.path}</div>
        <pre className="tout">{String(a.content ?? "").split("\n").slice(0, 30).join("\n")}</pre>
      </>
    );
  return (
    <div className="permission">
      <div className="ptitle">
        Allow <b>{ask.tool}</b>?{a.description && <span className="pdesc"> {a.description}</span>}
      </div>
      {detail}
      <div className="pactions">
        <button className="primary" onClick={() => onAnswer({ allow: true })} autoFocus>
          Allow
        </button>
        <button onClick={() => onAnswer({ allow: true, always: true })}>Always this session</button>
        <input placeholder="Or tell it what to do instead…" value={feedback} onChange={(e) => setFeedback(e.target.value)} onKeyDown={(e) => e.key === "Enter" && onAnswer({ allow: false, feedback: feedback || undefined })} />
        <button className="danger" onClick={() => onAnswer({ allow: false, feedback: feedback || undefined })}>
          Deny
        </button>
      </div>
    </div>
  );
}

const money = (n: number | undefined) => (n === undefined ? "–" : n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

function Todos({ todos }: { todos: Todo[] }) {
  if (!todos.length) return <div className="muted small">No plan yet. The agent writes one for tasks with several steps.</div>;
  return (
    <>
      {todos.map((t, i) => (
        <div key={i} className={`todo ${t.status}`}>
          <span className="tick">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : t.status === "cancelled" ? "–" : "○"}</span>
          {t.content}
        </div>
      ))}
    </>
  );
}

function Meter({ value, max, mark }: { value: number; max: number; mark?: number }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="meter">
      <div className="fill" style={{ width: `${pct}%` }} />
      {mark !== undefined && max > 0 && <div className="mark" style={{ left: `${Math.min(100, (mark / max) * 100)}%` }} title="Summarising starts here" />}
    </div>
  );
}

function Row({ label, children, big }: { label: string; children: React.ReactNode; big?: boolean }) {
  return (
    <div className="kv">
      <span>{label}</span>
      <b className={big ? "big" : ""}>{children}</b>
    </div>
  );
}

// When Perch summarises: the normal limit while working, and the idle sweep.
function SummarySettings() {
  const [s, setS] = useState<{ idleCompact: boolean; idleCompactHours: number; idleCompactMinTokens: number; compactTokens: number } | null>(null);
  useEffect(() => {
    api.getSettings().then(setS);
  }, []);
  if (!s) return null;
  const set = async (name: string, value: unknown) => setS({ ...s, [name]: await api.setSetting(name, value) });
  return (
    <div className="summary-settings">
      <label className="kv">
        <span title="While working, Perch summarises the conversation once it reaches this size">Summarise while working at</span>
        <select value={s.compactTokens} onChange={(e) => set("compactTokens", Number(e.target.value))}>
          {[200_000, 400_000, 600_000, 800_000].map((n) => (
            <option key={n} value={n}>
              {n / 1000}K
            </option>
          ))}
        </select>
      </label>
      <label className="kv toggle-row" title="Once an hour, and when you return to a session, summarise sessions left idle with a lot of context. DeepSeek's cache has expired by then, so the next message would pay full price for all of it.">
        <span>
          Summarise idle sessions
          <span className="muted small"> (idle {s.idleCompactHours}h+, over {Math.round(s.idleCompactMinTokens / 1000)}K)</span>
        </span>
        <input type="checkbox" checked={s.idleCompact} onChange={(e) => set("idleCompact", e.target.checked)} />
      </label>
      {s.idleCompact && s.compactTokens <= s.idleCompactMinTokens && (
        <div className="warn small">Sessions are summarised at {s.compactTokens / 1000}K while working, so none reach {Math.round(s.idleCompactMinTokens / 1000)}K. Raise the first setting for idle summarising to matter.</div>
      )}
    </div>
  );
}

function UsagePanel({ snap, models }: { snap: Snapshot; models: ModelChoice[] }) {
  const [all, setAll] = useState<AllUsage | null>(null);
  useEffect(() => {
    api.allUsage().then(setAll);
  }, [snap.usage.input, snap.id]);
  const u = snap.usage;
  const name = (ref: string) => models.find((m) => m.ref === ref)?.name ?? ref;
  const cacheRate = u.input ? Math.round((u.cacheHit / u.input) * 100) : 0;
  const perModel = Object.entries(u.byModel ?? {});
  return (
    <div className="usage">
      <section>
        <h4>Context</h4>
        <Meter value={snap.contextTokens} max={snap.contextWindow} mark={snap.compactAt} />
        <Row label="In use">
          {fmtK(snap.contextTokens)} / {fmtK(snap.contextWindow)}
        </Row>
        <Row label="Summarises at">{fmtK(snap.compactAt)}</Row>
        <Row label="Summarised so far">{snap.compactions}×</Row>
        <SummarySettings />
      </section>
      <section>
        <h4>This session</h4>
        <Row label="Cost" big>
          {money(u.cost ?? 0)}
        </Row>
        <Row label="Input tokens">{fmtK(u.input)}</Row>
        <Row label="…from cache">
          {fmtK(u.cacheHit)} ({cacheRate}%)
        </Row>
        <Row label="Output tokens">{fmtK(u.output)}</Row>
        {u.reasoning > 0 && <Row label="…of which thinking">{fmtK(u.reasoning)}</Row>}
        {perModel.length > 0 && (
          <table className="models">
            <tbody>
              {perModel.map(([ref, m]) => (
                <tr key={ref}>
                  <td title={ref}>{name(ref)}</td>
                  <td>{m.requests} req</td>
                  <td>{m.priced ? money(m.cost) : "no price"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {all && (
        <section>
          <h4>All sessions</h4>
          <Row label="Today">{money(all.day.cost)}</Row>
          <Row label="Last 7 days">{money(all.week.cost)}</Row>
          <Row label={`All time (${all.total.sessions} sessions)`}>{money(all.total.cost)}</Row>
          <Row label="Cache hit rate">{all.total.input ? Math.round((all.total.cacheHit / all.total.input) * 100) : 0}%</Row>
          <div className={`peak ${all.deepseekPeak ? "on" : ""}`}>{all.deepseekPeak ? "DeepSeek peak hours: prices are doubled right now." : "DeepSeek off-peak: half price right now."}</div>
        </section>
      )}
      <div className="muted small">Costs are estimates from published prices. Local models count as free. Sessions from before cost tracking show $0.</div>
    </div>
  );
}

function SidePanel({ snap, models, shotsKey, onClose }: { snap: Snapshot; models: ModelChoice[]; shotsKey: number; onClose?: () => void }) {
  const hasPlan = snap.todos.length > 0;
  const [tab, setTab] = useState<"plan" | "usage" | "shots" | "setup">(hasPlan ? "plan" : "usage");
  useEffect(() => {
    if (hasPlan) setTab("plan");
  }, [hasPlan]);
  const done = snap.todos.filter((t) => t.status === "completed").length;
  return (
    <aside className="side">
      <div className="tabs">
        <button className={tab === "plan" ? "on" : ""} onClick={() => setTab("plan")}>
          Plan {hasPlan && <span>{done}/{snap.todos.length}</span>}
        </button>
        <button className={tab === "usage" ? "on" : ""} onClick={() => setTab("usage")}>
          Usage <span>{money(snap.usage.cost ?? 0)}</span>
        </button>
        <button className={tab === "shots" ? "on" : ""} onClick={() => setTab("shots")}>
          Shots
        </button>
        <button className={tab === "setup" ? "on" : ""} onClick={() => setTab("setup")}>
          Setup
        </button>
        {onClose && (
          <button className="close-sheet" onClick={onClose} title="Close">
            ✕
          </button>
        )}
      </div>
      <div className="side-body">{tab === "plan" ? (
          <Todos todos={snap.todos} />
        ) : tab === "usage" ? (
          <UsagePanel snap={snap} models={models} />
        ) : tab === "shots" ? (
          <ShotsPanel sessionId={snap.id} refreshKey={shotsKey + (snap.busy ? 0 : 1000)} />
        ) : (
          <SetupPanel cwd={snap.cwd} />
        )}</div>
    </aside>
  );
}

function ModelSelect({ value, models, disabled, onChange }: { value: string; models: ModelChoice[]; disabled?: boolean; onChange: (ref: string) => void }) {
  const groups = new Map<string, ModelChoice[]>();
  for (const m of models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} title={value}>
      {!models.some((m) => m.ref === value) && <option value={value}>{value}</option>}
      {[...groups.entries()].map(([provider, ms]) => (
        <optgroup key={provider} label={provider + (ms[0].hasKey ? "" : " (no key)")}>
          {ms.map((m) => (
            <option key={m.ref} value={m.ref} disabled={!m.hasKey}>
              {m.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}


interface LocalModelRow {
  path: string;
  name: string;
  title?: string;
  sizeGB: number;
  context?: number;
  arch?: string;
  running: boolean;
  port: number | null;
}

function LocalModels({ onChanged }: { onChanged: () => void }) {
  const [state, setState] = useState<{ scanned: string | null; models: LocalModelRow[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api.localList().then(setState);
  }, []);
  const act = async (label: string, f: () => Promise<any>) => {
    setBusy(label);
    setError("");
    try {
      const r = await f();
      setState(r.state ?? r);
      onChanged();
    } catch (err: any) {
      setError(String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    }
    setBusy(null);
  };
  return (
    <>
      <h4>Local models (llama.cpp)</h4>
      <div className="muted small">
        GGUF chat models found on your drives. Start one and it appears in the model picker; it costs nothing and nothing leaves your PC.
        {state?.scanned ? ` Last scan ${ago(state.scanned)}.` : " Not scanned yet."}
      </div>
      <table className="keys">
        <tbody>
          {state?.models.map((m) => (
            <tr key={m.path}>
              <td>
                <b>{m.title ?? m.name}</b>
                <div className="muted small mono">{m.path}</div>
              </td>
              <td className="small muted">
                {m.sizeGB} GB{m.context ? ` · ${fmtK(m.context)} ctx` : ""}
              </td>
              <td className="small">{m.running ? <span className="ok">running on :{m.port}</span> : <span className="muted">stopped</span>}</td>
              <td>
                {m.running ? (
                  <button className="small-btn" disabled={!!busy} onClick={() => act("stop", () => api.localStop(m.path))}>
                    Stop
                  </button>
                ) : (
                  <button className="small-btn" disabled={!!busy} onClick={() => act("start:" + m.path, () => api.localStart(m.path))}>
                    {busy === "start:" + m.path ? "Loading…" : "Start"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button disabled={!!busy} onClick={() => act("scan", () => api.localScan())}>
        {busy === "scan" ? "Scanning drives… (about a minute and a half)" : state?.scanned ? "Scan again" : "Scan drives for models"}
      </button>
      {error && <pre className="bad small" style={{ whiteSpace: "pre-wrap" }}>{error}</pre>}
    </>
  );
}

function SetupPanel({ cwd }: { cwd: string }) {
  const [info, setInfo] = useState<{ instructions: { path: string; kind: string; chars: number }[]; skills: { name: string; source: string }[]; agents: { name: string; model: string | null }[] } | null>(null);
  useEffect(() => {
    api.setupFor(cwd).then(setInfo);
  }, [cwd]);
  if (!info) return null;
  const label: Record<string, string> = { global: "Your instructions", project: "Project instructions", memory: "Claude Code's notes for this project" };
  return (
    <div className="usage">
      <section>
        <h4>Instructions loaded</h4>
        {info.instructions.length === 0 && <div className="muted small">None found.</div>}
        {info.instructions.map((f) => (
          <div key={f.path} className="setup-file" title={f.path}>
            <div>{label[f.kind] ?? f.kind}</div>
            <div className="muted small mono">{f.path}</div>
            <div className="muted small">{fmtK(f.chars)} characters{f.kind === "global" && f.path.includes("opencode") ? " (only the parts not already in CLAUDE.md)" : ""}</div>
          </div>
        ))}
      </section>
      <section>
        <h4>Skills ({info.skills.length})</h4>
        <div className="muted small">Loaded on demand when a task matches. {[...new Set(info.skills.map((s) => s.source))].join(", ")}</div>
        <div className="chips">
          {info.skills.slice(0, 40).map((s) => (
            <span key={s.name} className="src">
              {s.name}
            </span>
          ))}
          {info.skills.length > 40 && <span className="muted small">+{info.skills.length - 40} more</span>}
        </div>
      </section>
      <section>
        <h4>Specialist agents ({info.agents.length})</h4>
        {info.agents.map((a) => (
          <Row key={a.name} label={a.name}>
            {a.model ?? "session model"}
          </Row>
        ))}
      </section>
      <div className="muted small">Read live from Claude Code and OpenCode, so edits there show up in new sessions here.</div>
    </div>
  );
}

function KeysDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [keys, setKeys] = useState<KeyInfo[]>([]);
  const [provider, setProvider] = useState("deepseek");
  const [key, setKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const reload = () => api.listKeys().then(setKeys);
  useEffect(() => {
    reload();
  }, []);
  const custom = provider === "__custom";
  const save = async () => {
    setBusy(true);
    setResult(null);
    try {
      const id = custom ? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom" : provider;
      const r = await api.saveKey({ id, key, baseURL: custom ? baseURL : undefined, name: custom ? name : undefined });
      setResult({ ok: true, text: r.warning || `Key works.${r.models.length ? ` ${r.models.length} models available.` : ""}` });
      setKey("");
      reload();
      onChanged();
    } catch (err: any) {
      setResult({ ok: false, text: String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
    }
    setBusy(false);
  };
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Keys & models</h3>
          <button className="x" onClick={onClose}>
            ✕
          </button>
        </div>
        <table className="keys">
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>
                  <b>{k.name}</b>
                  <div className="muted small mono">{k.baseURL}</div>
                </td>
                <td className="small">{k.local ? <span className="ok">local, no key needed</span> : k.keySource ? <span className="ok">key from {k.keySource}</span> : <span className="muted">no key</span>}</td>
                <td className="small muted">{k.models} models</td>
                <td>
                  {k.keySource === "perch auth.json" && (
                    <button
                      className="small-btn"
                      onClick={async () => {
                        await api.removeKey(k.id);
                        reload();
                        onChanged();
                      }}
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h4>Import a key</h4>
        <div className="form">
          <label>
            Provider
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {keys
                .filter((k) => !k.local)
                .map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              <option value="__custom">Other (OpenAI-compatible)…</option>
            </select>
          </label>
          {custom && (
            <>
              <label>
                Name
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Moonshot" />
              </label>
              <label>
                Base URL
                <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="https://api.example.com/v1" />
              </label>
            </>
          )}
          <label>
            API key
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste the key here" onKeyDown={(e) => e.key === "Enter" && key && save()} />
          </label>
          <button className="primary" disabled={!key.trim() || busy || (custom && !baseURL)} onClick={save}>
            {busy ? "Checking…" : "Check and save"}
          </button>
          {result && <div className={result.ok ? "ok" : "bad"}>{result.text}</div>}
          <div className="muted small">Saved to ~/.perch/auth.json on this computer, the same way OpenCode keeps its keys. An imported key takes priority over environment variables.</div>
        </div>
        <LocalModels onChanged={onChanged} />
      </div>
    </div>
  );
}

// ---------- app ----------

export function App() {
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [showKeys, setShowKeys] = useState(false);
  const [showMascots, setShowMascots] = useState(false);
  // Verbose: thinking and tool calls open, arguments shown, status messages kept. Remembered.
  const [verbose, setVerboseState] = useState(() => {
    try {
      return localStorage.getItem("perch.verbose") === "1";
    } catch {
      return false;
    }
  });
  const setVerbose = (v: boolean) => {
    setVerboseState(v);
    try {
      localStorage.setItem("perch.verbose", v ? "1" : "0");
    } catch {}
  };
  // Phone mode: one column, full screen and zoomed, for driving Perch from a phone over Steam
  // Link or Remote Desktop. The sidebar and side panel become sheets. Remembered; Ctrl+Shift+P.
  const [phone, setPhoneState] = useState(() => {
    try {
      return localStorage.getItem("perch.phone") === "1";
    } catch {
      return false;
    }
  });
  const [drawer, setDrawer] = useState(false);
  const [panel, setPanel] = useState(false);
  const setPhone = (on: boolean) => {
    setPhoneState(on);
    setDrawer(false);
    setPanel(false);
    try {
      localStorage.setItem("perch.phone", on ? "1" : "0");
    } catch {}
  };
  useEffect(() => void api.setPhone(phone), [phone]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPhone(!phone);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phone]);
  const [plays, setPlays] = useState<Record<string, PlayResult | undefined>>({});
  const [navTab, setNavTab] = useState<"sessions" | "projects">("sessions");
  const [projects, setProjects] = useState<{ path: string; name: string; sources: string[]; lastUsed?: string }[]>([]);
  const [projectFilter, setProjectFilter] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [lives, setLives] = useState<Record<string, Live>>({});
  const [active, setActive] = useState<string | null>(null);
  const [auto, setAuto] = useState<Record<string, boolean>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  const update = (id: string, f: (l: Live) => Live) => setLives((ls) => (ls[id] ? { ...ls, [id]: f(ls[id]) } : ls));

  useEffect(() => {
    api.init().then((r: any) => {
      setModels(r.models);
      setDefaultModel(r.defaultModel);
      setSessions(r.sessions);
    });
    api.listProjects().then(setProjects);
    return api.onEvent((e: any) => {
      const id = e.sessionId;
      if (e.type === "sessions") return setSessions(e.sessions);
      if (e.type === "models") return setModels(e.models);
      if (e.type === "unsent") return bus.emit("unsent", { sessionId: id, text: e.text });
      update(id, (l) => {
        const snap = l.snap;
        switch (e.type) {
          case "stream":
            return { ...l, stream: l.stream + (e.text ?? ""), thinking: e.reasoning ? (l.thinking + e.reasoning).slice(-40_000) : l.thinking };
          case "message":
            return { ...l, stream: "", thinking: "", snap: { ...snap, history: [...snap.history, e.message] } };
          case "toolStart":
            return { ...l, status: "", meta: { ...l.meta, [e.call.id]: { running: true } } };
          case "toolEnd":
            return { ...l, shotsKey: (l.shotsKey ?? 0) + (e.result.images?.length ? 1 : 0), meta: { ...l.meta, [e.call.id]: { title: e.result.title, diff: e.result.diff, error: e.result.error, images: e.result.images } } };
          case "todos":
            return { ...l, snap: { ...snap, todos: e.todos } };
          case "status":
            return { ...l, status: e.text, statusLog: e.text ? [...(l.statusLog ?? []), `${new Date().toLocaleTimeString()}  ${e.text}`].slice(-50) : l.statusLog };
          case "error":
            return { ...l, error: e.text };
          case "ask":
            return { ...l, ask: { reqId: e.reqId, tool: e.tool, summary: e.summary, args: e.args } };
          case "busy":
            return { ...l, snap: { ...snap, busy: e.busy }, startedAt: e.busy ? Date.now() : l.startedAt, error: e.busy ? "" : l.error, status: e.busy ? "" : l.status, stream: "", thinking: "" };
          case "snapshot":
            return { ...l, snap: e.snapshot };
          default:
            return l;
        }
      });
    });
  }, []);

  const live = active ? lives[active] : undefined;

  // Follow new output unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  const adopt = (snap: Snapshot) => {
    setLives((ls) => ({ ...ls, [snap.id]: ls[snap.id] ?? { snap, stream: "", thinking: "", status: "", error: "", ask: null, meta: {}, startedAt: Date.now() } }));
    setActive(snap.id);
    stick.current = true;
  };

  const open = async (id: string) => {
    setDrawer(false);
    adopt(await api.openSession(id));
  };
  const startIn = async (cwd: string | null) => {
    const snap = await api.newSession(cwd, live?.snap.model ?? defaultModel);
    setDrawer(false);
    adopt(snap);
    setNavTab("sessions");
    setSessions(await api.listSessions());
  };
  const create = async (withFolder: boolean) => {
    if (!withFolder) return startIn(null);
    const cwd = await api.pickFolder();
    if (cwd) await startIn(cwd);
  };

  const submit = (text: string, images: string[] = []) => {
    if (!text || !live) return;
    stick.current = true;
    // While working, the message waits for the current step; main shows it when Perch reads it.
    if (live.snap.busy) return void api.send(live.snap.id, text, images);
    update(live.snap.id, (l) => ({ ...l, snap: { ...l.snap, busy: true } }));
    api.send(live.snap.id, text, images).catch((err: any) => update(live.snap.id, (l) => ({ ...l, error: String(err?.message ?? err) })));
  };

  const answer = (d: { allow: boolean; always?: boolean; feedback?: string }) => {
    if (!live?.ask) return;
    api.answer(live.ask.reqId, d);
    update(live.snap.id, (l) => ({ ...l, ask: null }));
  };

  const grouped = useMemo(() => {
    const g = new Map<string, SessionSummary[]>();
    for (const s of sessions) {
      const key = /[\\/]\.perch[\\/]scratch[\\/]/.test(s.cwd) ? "No folder" : base(s.cwd);
      g.set(key, [...(g.get(key) ?? []), s]);
    }
    return [...g.entries()];
  }, [sessions]);

  const snap = live?.snap;
  const ctxPct = snap && snap.contextWindow ? Math.round((snap.contextTokens / snap.contextWindow) * 100) : 0;
  const cachePct = snap && snap.usage.input ? Math.round((snap.usage.cacheHit / snap.usage.input) * 100) : 0;

  return (
    <div className={`app${phone ? " phone" : ""}${drawer ? " drawer" : ""}${panel ? " panel" : ""}`}>
      {phone && (drawer || panel) && <div className="scrim" onClick={() => (setDrawer(false), setPanel(false))} />}
      <nav className="sidebar">
        <div className="brand">
          <button className="brand-bird" onClick={() => setShowMascots(true)} title="Choose your bird">
            <Parrot size={48} />
          </button>
          <span>Perch</span>
        </div>
        {showMascots && <MascotPicker onClose={() => setShowMascots(false)} />}
        <button className="new" onClick={() => create(true)}>
          + New session in a folder…
        </button>
        <button className="new ghost" onClick={() => create(false)}>
          + New session, no folder
        </button>
        <div className="navtabs">
          <button className={navTab === "sessions" ? "on" : ""} onClick={() => setNavTab("sessions")}>
            Sessions
          </button>
          <button
            className={navTab === "projects" ? "on" : ""}
            onClick={() => {
              setNavTab("projects");
              api.listProjects().then(setProjects);
            }}
          >
            Projects {projects.length > 0 && <span>{projects.length}</span>}
          </button>
        </div>
        {navTab === "projects" ? (
          <div className="list">
            <input className="filter" placeholder="Filter projects…" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} />
            {projects
              .filter((p) => !projectFilter || (p.name + " " + p.path).toLowerCase().includes(projectFilter.toLowerCase()))
              .map((p) => (
                <div key={p.path} className="sess project" onClick={() => startIn(p.path)} title={`Start a session in ${p.path}`}>
                  <div className="sess-title">{p.name}</div>
                  <div className="sess-meta">
                    <span className="ppath">{p.path}</span>
                  </div>
                  <div className="sources">
                    {p.sources.map((s) => (
                      <span key={s} className={`src ${s.replace(/\s/g, "").toLowerCase()}`}>
                        {s}
                      </span>
                    ))}
                    {p.lastUsed && <span className="when">{ago(p.lastUsed)}</span>}
                  </div>
                </div>
              ))}
          </div>
        ) : (
        <div className="list">
          {grouped.map(([group, items]) => (
            <div key={group} className="group">
              <div className="group-name">{group}</div>
              {items.map((s) => {
                const l = lives[s.id];
                return (
                  <div key={s.id} className={`sess ${active === s.id ? "on" : ""}`} onClick={() => open(s.id)} title={s.cwd}>
                    <div className="sess-title">
                      {l?.ask ? <span className="badge ask">!</span> : l?.snap.busy ? <span className="badge busy" /> : null}
                      {s.title}
                    </div>
                    <div className="sess-meta">
                      {ago(s.updated)}
                      <button
                        className="del"
                        title="Delete session"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!confirm(`Delete "${s.title}"? This cannot be undone.`)) return;
                          setSessions(await api.deleteSession(s.id));
                          if (active === s.id) setActive(null);
                        }}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        )}
        <div className="side-foot">
          <button className="ghost" onClick={() => setShowKeys(true)}>
            Keys & models
          </button>
          <button className="ghost" onClick={() => setPhone(!phone)} title="Ctrl+Shift+P">
            {phone ? "Leave phone mode" : "Phone mode"}
          </button>
        </div>
      </nav>

      {!snap ? (
        <main className="empty">
          <div className="drag-strip" />
          {phone && (
            <div className="phone-home">
              <button className="phone-btn" onClick={() => setDrawer(true)} title="Sessions">
                ☰
              </button>
              <button className="phone-btn" onClick={() => setPhone(false)} title="Leave phone mode (Ctrl+Shift+P)">
                ⤢
              </button>
            </div>
          )}
          <CheekyParrot size={210} />
          <h1>Perch</h1>
          <p>A coding agent for DeepSeek and friends.</p>
          <p className="credit">© Feisty Parrot Studios · MIT licence</p>
          <div className="empty-actions">
            <button className="primary" onClick={() => create(true)}>
              Open a folder
            </button>
            <button onClick={() => create(false)}>Start without a folder</button>
          </div>
        </main>
      ) : (
        <main className="chat">
          <header>
            {phone && (
              <button className="phone-btn" onClick={() => setDrawer(true)} title="Sessions">
                ☰
              </button>
            )}
            <div className="title">
              <div className="t">{snap.title}</div>
              <button className="folder" onClick={() => api.openFolder(snap.cwd)} title="Open in Explorer">
                {snap.scratch ? "No folder" : snap.cwd}
              </button>
              {snap.scratch && (
                <button
                  className="link"
                  onClick={async () => {
                    const dir = await api.pickFolder();
                    if (!dir) return;
                    const s2 = await api.setCwd(snap.id, dir);
                    update(snap.id, (l) => ({ ...l, snap: { ...l.snap, cwd: s2.cwd, scratch: false } }));
                  }}
                >
                  Move to a folder…
                </button>
              )}
            </div>
            <div className="controls">
              <button className={`chip ${verbose ? "chip-on" : ""}`} onClick={() => setVerbose(!verbose)} title="Verbose: show thinking and tool calls in full, with their arguments, and keep status messages">
                verbose
              </button>
              <PlayButton
                sessionId={snap.id}
                cwd={snap.cwd}
                busy={snap.busy}
                onResult={(res) => {
                  setPlays((p) => ({ ...p, [snap.id]: res }));
                  update(snap.id, (l) => ({ ...l, shotsKey: (l.shotsKey ?? 0) + 1 }));
                }}
              />
              <span className="chip desk" title={`${snap.usage.cacheHit} of ${snap.usage.input} input tokens came from the cache`}>
                cache {cachePct}%
              </span>
              <span className="chip desk" title="Cost of this session">
                {money(snap.usage.cost ?? 0)}
              </span>
              <button className="chip" disabled={snap.busy} onClick={() => api.compact(snap.id)} title="Summarise the conversation now">
                compact
              </button>
              {!!snap.undo && (
                <button
                  className="chip"
                  disabled={snap.busy}
                  title={`Undo your last message, "${snap.undo.slice(0, 80)}": put the files back as they were before it, and take it and Perch's reply out of the conversation. ${snap.undos} message${snap.undos === 1 ? "" : "s"} can be undone.`}
                  onClick={async () => {
                    if (!confirm(`Undo "${snap.undo!.slice(0, 120)}"?\n\nFiles Perch changed since then go back to how they were, and files it created are deleted.`)) return;
                    try {
                      const r = await api.undo(snap.id);
                      bus.emit("unsent", { sessionId: snap.id, text: r.text });
                      update(snap.id, (l) => ({ ...l, status: r.files.length ? `Undone: ${r.files.length} file${r.files.length === 1 ? "" : "s"} put back (${r.files.slice(0, 4).join(", ")}${r.files.length > 4 ? "…" : ""}).` : "Undone. No files had changed." }));
                    } catch (e: any) {
                      update(snap.id, (l) => ({ ...l, error: String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }));
                    }
                  }}
                >
                  undo
                </button>
              )}
              {phone ? (
                <>
                  <button className="phone-btn" onClick={() => setPanel(true)} title="Plan, usage, shots and setup">
                    ▤
                  </button>
                  <button className="phone-btn" onClick={() => setPhone(false)} title="Leave phone mode (Ctrl+Shift+P)">
                    ⤢
                  </button>
                </>
              ) : (
                <button className="chip" onClick={() => setPhone(true)} title="Phone mode: one column, full screen and zoomed, for Steam Link or Remote Desktop (Ctrl+Shift+P)">
                  phone
                </button>
              )}
            </div>
          </header>

          <div className="body">
            <div className="col">
            <div
              className="scroll"
              ref={scroller}
              onScroll={(e) => {
                const el = e.currentTarget;
                stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              <div className="transcript">
                {snap.history.length === 0 && (
                  <div className="hello">
                    <CheekyParrot size={110} />
                    <p>What shall we work on?</p>
                  </div>
                )}
                <Transcript history={snap.history} meta={live!.meta} verbose={verbose} />
                <LiveTail live={live!} verbose={verbose} />
                {live!.error && <div className="error">{live!.error}</div>}
              </div>
            </div>

          <footer>
            {plays[snap.id] && !snap.busy && (
              <PlayCard sessionId={snap.id} result={plays[snap.id]!} onAsk={(text, images) => submit(text, images)} onClose={() => setPlays((p) => ({ ...p, [snap.id]: undefined }))} />
            )}
            {live!.ask && <PermissionCard ask={live!.ask} onAnswer={answer} />}
            {live!.status && <div className="status">{live!.status}</div>}
            {snap.busy && !live!.ask && (
              <WorkingParrot startedAt={live!.startedAt} activity={live!.stream ? "writing" : live!.thinking ? "thinking" : "tools"} />
            )}
            <Composer
              sessionId={snap.id}
              busy={snap.busy}
              models={models}
              model={snap.model}
              onModel={async (ref) => {
                const s2 = await api.setModel(snap.id, ref);
                update(snap.id, (l) => ({ ...l, snap: { ...l.snap, model: s2.model } }));
              }}
              auto={auto[snap.id] ?? !!snap.keepGoing}
              onAuto={(on) => {
                setAuto((a) => ({ ...a, [snap.id]: on }));
                api.setAuto(snap.id, on);
              }}
              thinking={snap.thinking ?? "high"}
              onThinking={(level) => {
                update(snap.id, (l) => ({ ...l, snap: { ...l.snap, thinking: level } }));
                api.setThinking(snap.id, level);
              }}
              mode={snap.permissionMode ?? "ask"}
              onMode={(mode) => {
                update(snap.id, (l) => ({ ...l, snap: { ...l.snap, permissionMode: mode } }));
                api.setMode(snap.id, mode);
              }}
              contextTokens={snap.contextTokens}
              contextWindow={snap.contextWindow}
              compactAt={snap.compactAt}
              onSend={submit}
              onStop={() => api.abort(snap.id)}
            />
          </footer>
            </div>
            <SidePanel snap={snap} models={models} shotsKey={live!.shotsKey ?? 0} onClose={phone ? () => setPanel(false) : undefined} />
          </div>
        </main>
      )}
      <Lightbox />
      {showKeys && <KeysDialog onClose={() => setShowKeys(false)} onChanged={() => api.listModels().then(setModels)} />}
    </div>
  );
}
