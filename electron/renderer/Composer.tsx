// The message box. It keeps its own state, so typing re-renders only this component, never the
// conversation, and each session keeps its own unsent draft.

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { bus, imgUrl } from "./gallery.js";

const api = (window as any).perch;
const IMAGE = /\.(png|jpe?g|webp|gif|bmp)$/i;

export interface ModelChoice {
  ref: string;
  name: string;
  provider: string;
  hasKey: boolean;
  vision?: boolean;
  thinkingLevels?: boolean;
}

export type Thinking = "off" | "low" | "high" | "max";
const THINKING: Thinking[] = ["off", "low", "high", "max"];
const THINKING_HELP = "Thinking: how long the model reasons before answering. Off is fastest and cheapest; Max takes longest and suits hard problems.";

export type Mode = "ask" | "edits" | "all";
const MODES: Mode[] = ["ask", "edits", "all"];
const MODE_LABEL: Record<Mode, string> = { ask: "Ask", edits: "Auto-edit", all: "Full auto" };
const MODE_HELP: Record<Mode, string> = {
  ask: "Ask: Perch asks before editing files, running commands or using MCP tools.",
  edits: "Auto-edit: file edits and writes go ahead; commands and MCP tools still ask.",
  all: "Full auto: everything goes ahead, except commands that delete in bulk, rewrite git history or publish, which still ask.",
};

const drafts = new Map<string, string>();
const draftImages = new Map<string, string[]>();

interface Props {
  sessionId: string;
  busy: boolean;
  models: ModelChoice[];
  model: string;
  onModel: (ref: string) => void;
  auto: boolean;
  onAuto: (on: boolean) => void;
  mode: Mode;
  onMode: (mode: Mode) => void;
  thinking: Thinking;
  onThinking: (level: Thinking) => void;
  contextTokens: number;
  contextWindow: number;
  compactAt: number;
  onSend: (text: string, images: string[]) => void;
  onStop: () => void;
}

function ContextRing({ used, max, mark }: { used: number; max: number; mark: number }) {
  const pct = max ? Math.min(1, used / max) : 0;
  const warn = used >= mark * 0.9;
  const r = 7;
  const c = 2 * Math.PI * r;
  return (
    <span className="ring" title={`Context: ${used.toLocaleString()} of ${max.toLocaleString()} tokens (${Math.round(pct * 100)}%). Summarises at ${mark.toLocaleString()}.`}>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={r} className="ring-bg" />
        <circle cx="9" cy="9" r={r} className={`ring-fg ${warn ? "warn" : ""}`} strokeDasharray={`${c * pct} ${c}`} transform="rotate(-90 9 9)" />
      </svg>
      <span>{Math.round(pct * 100)}%</span>
    </span>
  );
}

export function Composer(p: Props) {
  const [text, setText] = useState(() => drafts.get(p.sessionId) ?? "");
  const [images, setImagesState] = useState<string[]>(() => draftImages.get(p.sessionId) ?? []);
  const [dragging, setDragging] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const setImages = (f: (xs: string[]) => string[]) =>
    setImagesState((xs) => {
      const next = f(xs);
      draftImages.set(p.sessionId, next);
      return next;
    });

  // The lightbox's "Attach to message" lands here.
  useEffect(() => bus.on("attach", (path: string) => {
    setImages((xs) => (xs.includes(path) ? xs : [...xs, path]));
    ta.current?.focus();
  }), [p.sessionId]);

  const addFiles = async (files: File[]) => {
    for (const f of files) {
      const path: string = api.pathForFile(f);
      if (path && IMAGE.test(path)) setImages((xs) => [...xs, path]);
      else if (f.type.startsWith("image/")) {
        // A pasted screenshot has no file on disk yet; save it first.
        const saved: string = await api.saveAttachment(new Uint8Array(await f.arrayBuffer()), f.type);
        setImages((xs) => [...xs, saved]);
      } else if (path) {
        // Other files: put the path in the message, where the agent can read it.
        setText((t) => {
          const v = (t && !t.endsWith(" ") ? t + " " : t) + path;
          drafts.set(p.sessionId, v);
          return v;
        });
      }
    }
  };

  // Switching sessions swaps in that session's draft and puts the cursor in the box.
  useEffect(() => {
    setText(drafts.get(p.sessionId) ?? "");
    setImagesState(draftImages.get(p.sessionId) ?? []);
    requestAnimationFrame(() => ta.current?.focus());
  }, [p.sessionId]);

  // Grow with the content, up to 40% of the window, then scroll inside.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + "px";
  }, [text]);

  const change = (v: string) => {
    setText(v);
    drafts.set(p.sessionId, v);
  };

  const send = () => {
    const t = text.trim();
    if ((!t && !images.length) || p.busy) return;
    p.onSend(t || "Look at this image.", images);
    change("");
    setImages(() => []);
  };

  const groups = new Map<string, ModelChoice[]>();
  for (const m of p.models) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
  const current = p.models.find((m) => m.ref === p.model);

  return (
    <div className="composer-wrap">
      <div
        className={`composer-card ${p.busy ? "busy" : ""} ${dragging ? "dragging" : ""}`}
        onClick={(e) => e.target === e.currentTarget && ta.current?.focus()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          addFiles([...e.dataTransfer.files]);
        }}
      >
        {images.length > 0 && (
          <div className="attach-row">
            {images.map((img) => (
              <div key={img} className="attach" title={img}>
                <img src={imgUrl(img)} alt="" onClick={() => bus.emit("lightbox", { shots: images.map((x) => ({ path: x })), index: images.indexOf(img) })} />
                <button className="attach-x" onClick={() => setImages((xs) => xs.filter((x) => x !== img))} aria-label="Remove">
                  ×
                </button>
              </div>
            ))}
            {current && !current.vision && <span className="attach-note">{current.name} can't see images; it will get the file paths. DeepSeek V4.1 Flash can see them.</span>}
          </div>
        )}
        <textarea
          ref={ta}
          value={text}
          rows={1}
          spellCheck
          placeholder={p.busy ? "Perch is working. Type your next message…" : "Ask Perch to build, fix or explain something…"}
          onChange={(e) => change(e.target.value)}
          onPaste={(e) => {
            const files = [...e.clipboardData.files];
            if (files.length) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape" && p.busy) {
              e.preventDefault();
              p.onStop();
            }
          }}
        />
        <div className="toolbar">
          <label className="pill model-pill" title={p.model}>
            <span className="dot-live" />
            <select value={p.model} disabled={p.busy} onChange={(e) => p.onModel(e.target.value)}>
              {!current && <option value={p.model}>{p.model}</option>}
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
            <span className="pill-label">{current?.name ?? p.model}</span>
            <svg className="chev" width="10" height="10" viewBox="0 0 10 10">
              <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </label>
          {current?.thinkingLevels && (
            <button className={`pill think-pill think-${p.thinking}`} onClick={() => p.onThinking(THINKING[(THINKING.indexOf(p.thinking) + 1) % THINKING.length])} title={THINKING_HELP + "\nClick to change."}>
              <svg width="12" height="12" viewBox="0 0 12 12">
                <path d="M6 1.2a3.6 3.6 0 0 0-2.1 6.5v1.4h4.2V7.7A3.6 3.6 0 0 0 6 1.2zM4.6 10.6h2.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Thinking: {p.thinking === "off" ? "off" : p.thinking}
            </button>
          )}
          <button
            className={`pill mode-pill mode-${p.mode}`}
            onClick={() => p.onMode(MODES[(MODES.indexOf(p.mode) + 1) % MODES.length])}
            title={MODE_HELP[p.mode] + "\nClick to change."}
          >
            <svg width="12" height="12" viewBox="0 0 12 12">
              {p.mode === "ask" ? (
                <path d="M6 1.5l4 1.6v2.8c0 2.4-1.7 4-4 4.6-2.3-.6-4-2.2-4-4.6V3.1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              ) : p.mode === "edits" ? (
                <path d="M2 10l.6-2.4L8 2.2l1.8 1.8-5.4 5.4zM7 3.2l1.8 1.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              ) : (
                <path d="M6.6 1L2.5 7h3l-.6 4L9.5 5h-3z" fill="currentColor" />
              )}
            </svg>
            {MODE_LABEL[p.mode]}
          </button>
          <button className={`pill toggle-pill ${p.auto ? "on" : ""}`} onClick={() => p.onAuto(!p.auto)} title="Keep going: when Perch stops with items still open in its plan, nudge it to carry on">
            <svg width="12" height="12" viewBox="0 0 12 12">
              <path d="M2 6a4 4 0 0 1 7-2.6M10 6a4 4 0 0 1-7 2.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              <path d="M9.4 1.6v2.2H7.2M2.6 10.4V8.2h2.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Keep going
          </button>
          <span className="spacer" />
          <ContextRing used={p.contextTokens} max={p.contextWindow} mark={p.compactAt} />
          {p.busy ? (
            <button className="round stop-btn" onClick={p.onStop} title="Stop (Esc)">
              <svg width="12" height="12" viewBox="0 0 12 12">
                <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button className="round send-btn" onClick={send} disabled={!text.trim() && !images.length} title="Send (Enter)">
              <svg width="14" height="14" viewBox="0 0 14 14">
                <path d="M7 12V2.5M2.8 6.5L7 2.3l4.2 4.2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="hints">
        <span>
          <kbd>Enter</kbd> send
        </span>
        <span>
          <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
        </span>
        <span>
          <kbd>Ctrl</kbd>+<kbd>V</kbd> or drop to attach images
        </span>
        {p.busy && (
          <span>
            <kbd>Esc</kbd> stop
          </span>
        )}
      </div>
    </div>
  );
}
