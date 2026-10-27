// The Play button and the card that shows a run's screenshots, errors, log, and how the
// screenshots compare with the project's golden (known-good) ones.

import React, { useEffect, useState } from "react";
import { bus, Thumbs } from "./gallery.js";

const api = (window as any).perch;
const base = (p: string) => p.split(/[\\/]/).pop() ?? p;

export interface PlayResult {
  plan: { kind: string; label: string; engine?: string; note?: string };
  screenshots: string[];
  log: string;
  errors: string[];
  exitCode: number | null;
  stopped: boolean;
  seconds: number;
  golden?: { shot: string; golden: string; changedPercent: number }[];
}

export function PlayButton({ sessionId, cwd, busy, onResult }: { sessionId: string; cwd: string; busy: boolean; onResult: (r: PlayResult) => void }) {
  const [plan, setPlan] = useState<{ kind: string; label: string; engine?: string; note?: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    api.playDetect(sessionId).then(setPlan);
  }, [sessionId, cwd]);
  if (!plan || (plan.kind === "none" && !plan.engine)) return null;
  const runnable = plan.kind !== "none" && plan.kind !== "unity";
  return (
    <span className="play-wrap">
      <button
        className={`chip play-btn ${running ? "running" : ""}`}
        disabled={!runnable || running || busy}
        title={runnable ? `Run ${plan.label} for 8 seconds and capture it` : plan.note}
        onClick={async () => {
          setRunning(true);
          setError("");
          try {
            onResult(await api.playRun(sessionId, { seconds: 8 }));
          } catch (e: any) {
            setError(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
          }
          setRunning(false);
        }}
      >
        <svg width="10" height="10" viewBox="0 0 10 10">
          <path d="M2 1.2v7.6L8.6 5z" fill="currentColor" />
        </svg>
        {running ? "Playing…" : "Play"}
        <span className="play-engine">{plan.engine ?? plan.label}</span>
      </button>
      {error && (
        <span className="play-error" title={error}>
          {error.slice(0, 80)}
        </span>
      )}
    </span>
  );
}

export function PlayCard({ sessionId, result, onAsk, onClose }: { sessionId: string; result: PlayResult; onAsk: (text: string, images: string[]) => void; onClose: () => void }) {
  const [showLog, setShowLog] = useState(result.errors.length > 0 && result.screenshots.length === 0);
  const [savedGolden, setSavedGolden] = useState(false);
  const golden = result.golden ?? [];
  const changed = golden.filter((g) => g.changedPercent >= 2);
  const badges = Object.fromEntries(
    golden.map((g) => [g.shot, { text: g.changedPercent < 0.5 ? "matches golden" : `${g.changedPercent}% changed`, bad: g.changedPercent >= 2, compare: g.golden }]),
  );
  const ok = result.errors.length === 0 && (result.stopped || result.exitCode === 0);

  const ask = () => {
    const parts = [
      `I played the game (${result.plan.label}) for ${result.seconds}s. ${result.stopped ? "It was still running when it was closed." : `It exited by itself with code ${result.exitCode}.`}`,
      result.errors.length ? `Errors in the log:\n${result.errors.join("\n")}` : "No error lines in the log.",
      changed.length ? `Compared with the golden screenshots, these changed: ${changed.map((g) => `${base(g.shot)} (${g.changedPercent}%)`).join(", ")}.` : "",
      `Log (last part):\n${result.log.slice(-3000)}`,
      result.errors.length || (!result.stopped && result.exitCode !== 0)
        ? "Fix the cause of these errors, then use the play tool once to check the fix. If you see other problems in the screenshots, mention them but don't change them unless I ask."
        : changed.length
          ? "Look at the screenshots that changed from the golden ones and tell me whether the change looks intended or like a regression. Don't change anything unless I ask."
          : "Look at the screenshots and tell me what you see. Don't change anything unless I ask.",
    ];
    onAsk(parts.filter(Boolean).join("\n\n"), result.screenshots.slice(-4));
    onClose();
  };

  return (
    <div className={`play-card ${ok && !changed.length ? "ok" : "bad"}`}>
      <div className="play-head">
        <span className="play-dot" />
        <b>{result.plan.label}</b>
        <span className="muted small">
          {result.seconds}s · {result.screenshots.length} screenshot{result.screenshots.length === 1 ? "" : "s"} ·{" "}
          {result.errors.length ? <span className="bad">{result.errors.length} error line{result.errors.length === 1 ? "" : "s"}</span> : "no errors"}
          {!result.stopped && result.exitCode !== 0 && <span className="bad"> · exited with code {result.exitCode}</span>}
          {golden.length > 0 && (changed.length ? <span className="bad"> · {changed.length} differ from golden</span> : <span className="ok"> · matches golden</span>)}
        </span>
        <span className="spacer" />
        <button className="pill" onClick={() => setShowLog((s) => !s)}>
          {showLog ? "Hide log" : "Log"}
        </button>
        <button className="pill" onClick={() => result.screenshots.forEach((s) => bus.emit("attach", s))} disabled={!result.screenshots.length}>
          Attach shots
        </button>
        <button
          className="pill"
          disabled={!result.screenshots.length || savedGolden}
          title="Save these screenshots as the known-good reference; later runs are compared with them"
          onClick={async () => {
            await api.saveGolden(sessionId, result.screenshots);
            setSavedGolden(true);
          }}
        >
          {savedGolden ? "Saved as golden" : "Set as golden"}
        </button>
        <button className="pill accent" onClick={ask}>
          {result.errors.length ? "Ask Perch to fix" : "Show Perch"}
        </button>
        <button className="pill" onClick={onClose} aria-label="Dismiss">
          ✕
        </button>
      </div>
      {result.screenshots.length > 0 && <Thumbs paths={result.screenshots} badges={badges} />}
      {result.errors.length > 0 && <pre className="play-errors">{result.errors.slice(-8).join("\n")}</pre>}
      {showLog && <pre className="play-log">{result.log.slice(-8000) || "(the game printed nothing)"}</pre>}
    </div>
  );
}
