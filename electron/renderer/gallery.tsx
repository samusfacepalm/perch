// Screenshots, assets and the viewer. Thumbnails load lazily and decode off the main thread, so
// grids of hundreds of images scroll smoothly. The viewer has four modes: plain view, image info
// (palette and warnings), compare (before/after slider or difference map), and sprite sheet.

import React, { useEffect, useMemo, useRef, useState } from "react";

const api = (window as any).perch;

export const imgUrl = (p: string) => `perch-file://img/?p=${encodeURIComponent(p)}`;
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const folderOf = (p: string) => p.replace(/[\\/][^\\/]*$/, "");
const isPng = (p: string) => /\.png$/i.test(p);

// A tiny event bus, so the viewer can attach an image to the message box, and anything can open the viewer.
type Listener = (detail: any) => void;
const listeners = new Map<string, Set<Listener>>();
export const bus = {
  on(name: string, fn: Listener) {
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name)!.add(fn);
    return () => {
      listeners.get(name)!.delete(fn);
    };
  },
  emit(name: string, detail?: any) {
    for (const fn of listeners.get(name) ?? []) fn(detail);
  },
};

export interface Shot {
  path: string;
  mtime?: number;
  bytes?: number;
  source?: "play" | "tool" | "attached" | "project";
}

const SOURCE_LABEL: Record<string, string> = { play: "From a play run", tool: "From a tool", attached: "Attached", project: "In the project" };

function when(ms: number) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

const kb = (n: number) => (n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

// ---------- side panel: screenshots and assets ----------

export function ShotsPanel({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }) {
  const [mode, setMode] = useState<"shots" | "assets">("shots");
  return (
    <div className="shots">
      <div className="shots-bar">
        <button className={`seg ${mode === "shots" ? "on" : ""}`} onClick={() => setMode("shots")}>
          Screenshots
        </button>
        <button className={`seg ${mode === "assets" ? "on" : ""}`} onClick={() => setMode("assets")}>
          Assets
        </button>
      </div>
      {mode === "shots" ? <Screenshots sessionId={sessionId} refreshKey={refreshKey} /> : <Assets sessionId={sessionId} />}
    </div>
  );
}

function Screenshots({ sessionId, refreshKey }: { sessionId: string; refreshKey: number }) {
  const [shots, setShots] = useState<Shot[] | null>(null);
  const [filter, setFilter] = useState<"all" | "play" | "tool" | "project" | "attached">("all");
  const [pixel, setPixel] = useState(true);
  const load = () => api.listShots(sessionId).then(setShots);
  useEffect(() => {
    load();
  }, [sessionId, refreshKey]);
  const shown = useMemo(() => (shots ?? []).filter((s) => filter === "all" || s.source === filter), [shots, filter]);
  if (!shots) return <div className="muted small">Looking for screenshots…</div>;
  return (
    <>
      <div className="shots-bar">
        {(["all", "play", "tool", "project", "attached"] as const).map((f) => (
          <button key={f} className={`seg small-seg ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f === "all" ? `All ${shots.length}` : f === "play" ? "Play" : f === "tool" ? "Tools" : f === "project" ? "Project" : "Attached"}
          </button>
        ))}
        <button className="seg small-seg icon" title="Refresh" onClick={load}>
          ↻
        </button>
      </div>
      {shown.length === 0 ? (
        <div className="muted small shots-empty">No screenshots yet. Press Play, or use your MCP tools (Godot, Blender, PixelLab…). Images you attach, and new images in this project, appear here too.</div>
      ) : (
        <div className={`shot-grid ${pixel ? "pixel" : ""}`}>
          {shown.map((s, i) => (
            <button key={s.path} className="shot" title={`${fileName(s.path)}\n${SOURCE_LABEL[s.source ?? ""] ?? ""} · ${s.mtime ? when(s.mtime) : ""}`} onClick={() => bus.emit("lightbox", { shots: shown, index: i })}>
              <img src={imgUrl(s.path)} loading="lazy" decoding="async" alt="" draggable={false} />
              {s.mtime && <span className="shot-when">{when(s.mtime)}</span>}
            </button>
          ))}
        </div>
      )}
      <label className="pixel-toggle small muted">
        <input type="checkbox" checked={pixel} onChange={(e) => setPixel(e.target.checked)} /> Sharp pixels
      </label>
    </>
  );
}

interface Asset {
  path: string;
  rel: string;
  kind: "image" | "audio";
  bytes: number;
}

function Assets({ sessionId }: { sessionId: string }) {
  const [data, setData] = useState<{ assets: Asset[]; truncated: boolean } | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "image" | "audio">("all");
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    setData(null);
    api.listAssets(sessionId).then(setData);
    return () => audio.current?.pause();
  }, [sessionId]);
  const groups = useMemo(() => {
    const g = new Map<string, Asset[]>();
    for (const a of data?.assets ?? []) {
      if (kind !== "all" && a.kind !== kind) continue;
      if (q && !a.rel.toLowerCase().includes(q.toLowerCase())) continue;
      const folder = a.rel.includes("/") ? a.rel.replace(/\/[^/]*$/, "") : ".";
      g.set(folder, [...(g.get(folder) ?? []), a]);
    }
    return [...g.entries()];
  }, [data, q, kind]);
  const play = (p: string) => {
    audio.current?.pause();
    if (playing === p) return setPlaying(null);
    audio.current = new Audio(imgUrl(p));
    audio.current.onended = () => setPlaying(null);
    audio.current.play().catch(() => setPlaying(null));
    setPlaying(p);
  };
  if (!data) return <div className="muted small">Listing the project's art and sounds…</div>;
  const total = data.assets.length;
  return (
    <>
      <input className="filter" placeholder={`Filter ${total} files…`} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="shots-bar">
        {(["all", "image", "audio"] as const).map((k) => (
          <button key={k} className={`seg small-seg ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
            {k === "all" ? "All" : k === "image" ? "Images" : "Sounds"}
          </button>
        ))}
      </div>
      {data.truncated && <div className="muted small">Showing the first {total}; filter to narrow it down.</div>}
      {groups.length === 0 && <div className="muted small">No matching files.</div>}
      {groups.map(([folder, items]) => {
        const images = items.filter((i) => i.kind === "image");
        return (
          <div key={folder} className="asset-group">
            <div className="asset-folder" title={folder}>
              {folder} <span className="muted">{items.length}</span>
            </div>
            {images.length > 0 && (
              <div className="asset-grid">
                {images.slice(0, 120).map((a, i) => (
                  <button key={a.path} className="asset" title={`${a.rel} · ${kb(a.bytes)}`} onClick={() => bus.emit("lightbox", { shots: images.map((x) => ({ path: x.path, bytes: x.bytes })), index: i })}>
                    <img src={imgUrl(a.path)} loading="lazy" decoding="async" alt="" />
                  </button>
                ))}
                {images.length > 120 && <span className="muted small">+{images.length - 120}</span>}
              </div>
            )}
            {items
              .filter((i) => i.kind === "audio")
              .map((a) => (
                <button key={a.path} className={`sound ${playing === a.path ? "on" : ""}`} onClick={() => play(a.path)} title={a.rel}>
                  <span className="sound-icon">{playing === a.path ? "■" : "▶"}</span>
                  <span className="sound-name">{fileName(a.path)}</span>
                  <span className="muted small">{kb(a.bytes)}</span>
                </button>
              ))}
          </div>
        );
      })}
    </>
  );
}

// ---------- viewer ----------

interface Info {
  width: number;
  height: number;
  palette: { colours: number; top: { hex: string; share: number }[]; transparentPixels: number; partialAlphaPixels: number };
  frame: { w: number; h: number };
  grid: { columns: number; rows: number; fits: boolean; emptyFrames: number[]; baselines: number[] } | null;
  error?: string;
}

function InfoPanel({ path }: { path: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    setInfo(null);
    if (isPng(path)) api.imageInfo(path).then(setInfo);
  }, [path]);
  if (!isPng(path)) return <div className="lb-info muted small">Palette details are available for PNG files.</div>;
  if (!info) return <div className="lb-info muted small">Reading…</div>;
  if (info.error) return <div className="lb-info bad small">{info.error}</div>;
  const p = info.palette;
  return (
    <div className="lb-info" onClick={(e) => e.stopPropagation()}>
      <div>
        <b>
          {info.width}×{info.height}
        </b>{" "}
        · {p.colours} colours
      </div>
      <div className="swatches">
        {p.top.map((c) => (
          <span key={c.hex} className="swatch" style={{ background: c.hex }} title={`${c.hex} · ${c.share}%`} />
        ))}
      </div>
      {p.colours > 64 && <div className="warn small">Many colours for pixel art: it may be scaled, blurred or anti-aliased.</div>}
      {p.partialAlphaPixels > 0 && <div className="warn small">{p.partialAlphaPixels} semi-transparent pixels (soft edges).</div>}
      {p.colours <= 64 && p.partialAlphaPixels === 0 && <div className="ok small">Clean pixel art: hard edges, compact palette.</div>}
    </div>
  );
}

function CompareView({ a, b, pixel }: { a: string; b: string; pixel: boolean }) {
  const [pos, setPos] = useState(50);
  const [mode, setMode] = useState<"slider" | "diff">("slider");
  const [diff, setDiff] = useState<{ dataUrl?: string; changedPercent?: number; error?: string } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setDiff(null);
    if (isPng(a) && isPng(b)) api.imageDiff(a, b).then(setDiff);
  }, [a, b]);
  const drag = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    setPos(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
  };
  return (
    <div className="compare" onClick={(e) => e.stopPropagation()}>
      <div className="compare-bar">
        <span className="muted small">
          Before: <b>{/[\\/]\.perch[\\/]golden[\\/]/.test(b) ? `Golden (${fileName(b)})` : fileName(b)}</b> · After: <b>{fileName(a)}</b>
          {diff?.changedPercent !== undefined && ` · ${diff.changedPercent}% of pixels changed`}
          {diff?.error && ` · ${diff.error}`}
        </span>
        <button className={`pill ${mode === "slider" ? "on" : ""}`} onClick={() => setMode("slider")}>
          Slider
        </button>
        <button className={`pill ${mode === "diff" ? "on" : ""}`} onClick={() => setMode("diff")} disabled={!diff?.dataUrl}>
          Difference
        </button>
      </div>
      {mode === "diff" && diff?.dataUrl ? (
        <img className={`compare-single ${pixel ? "pixel" : ""}`} src={diff.dataUrl} alt="" />
      ) : (
        <div
          className={`compare-stage ${pixel ? "pixel" : ""}`}
          ref={box}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            drag(e);
          }}
          onPointerMove={(e) => e.buttons && drag(e)}
        >
          <img src={imgUrl(b)} alt="" draggable={false} />
          <img src={imgUrl(a)} alt="" draggable={false} className="after" style={{ clipPath: `inset(0 0 0 ${pos}%)` }} />
          <div className="divider" style={{ left: `${pos}%` }}>
            <span>◀ ▶</span>
          </div>
        </div>
      )}
    </div>
  );
}

function SpriteView({ path }: { path: string }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [fw, setFw] = useState(0);
  const [fh, setFh] = useState(0);
  const [row, setRow] = useState(0);
  const [fps, setFps] = useState(8);
  const [frame, setFrame] = useState(0);
  const [zoom, setZoom] = useState(4);
  const img = useRef<HTMLImageElement>(null);
  const sheet = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    api.imageInfo(path).then((i: Info) => {
      setInfo(i);
      if (!i.error) {
        setFw(i.frame.w);
        setFh(i.frame.h);
        setZoom(Math.max(1, Math.min(8, Math.floor(700 / Math.max(i.width, 1)))));
      }
    });
  }, [path]);
  const cols = fw ? Math.floor((info?.width ?? 0) / fw) : 0;
  const rows = fh ? Math.floor((info?.height ?? 0) / fh) : 0;

  // Draw the sheet with its grid, and highlight the row being previewed.
  useEffect(() => {
    const c = sheet.current, im = img.current;
    if (!c || !im || !info || !fw || !fh) return;
    const draw = () => {
      c.width = info.width * zoom;
      c.height = info.height * zoom;
      const g = c.getContext("2d")!;
      g.imageSmoothingEnabled = false;
      g.clearRect(0, 0, c.width, c.height);
      g.drawImage(im, 0, 0, c.width, c.height);
      g.strokeStyle = "rgba(63,185,80,.7)";
      g.lineWidth = 1;
      for (let x = 0; x <= cols; x++) (g.beginPath(), g.moveTo(x * fw * zoom + 0.5, 0), g.lineTo(x * fw * zoom + 0.5, rows * fh * zoom), g.stroke());
      for (let y = 0; y <= rows; y++) (g.beginPath(), g.moveTo(0, y * fh * zoom + 0.5), g.lineTo(cols * fw * zoom, y * fh * zoom + 0.5), g.stroke());
      g.strokeStyle = "#f2c12e";
      g.lineWidth = 2;
      g.strokeRect(1, row * fh * zoom + 1, cols * fw * zoom - 2, fh * zoom - 2);
      g.fillStyle = "rgba(255,255,255,.85)";
      g.font = "10px sans-serif";
      for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) g.fillText(String(r * cols + k), k * fw * zoom + 3, r * fh * zoom + 11);
    };
    if (im.complete) draw();
    else im.onload = draw;
  }, [info, fw, fh, zoom, row, cols, rows]);

  // Animate the chosen row.
  useEffect(() => {
    if (!cols) return;
    const t = setInterval(() => setFrame((f) => (f + 1) % cols), 1000 / Math.max(1, fps));
    return () => clearInterval(t);
  }, [fps, cols]);
  useEffect(() => {
    const c = preview.current, im = img.current;
    if (!c || !im || !fw || !fh || !im.complete) return;
    const scale = Math.max(1, Math.floor(200 / Math.max(fw, fh)));
    c.width = fw * scale;
    c.height = fh * scale;
    const g = c.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(im, (frame % cols) * fw, row * fh, fw, fh, 0, 0, c.width, c.height);
  }, [frame, row, fw, fh, cols]);

  if (!info) return <div className="muted">Reading the sheet…</div>;
  if (info.error) return <div className="bad">{info.error}</div>;
  const fits = fw > 0 && fh > 0 && info.width % fw === 0 && info.height % fh === 0;
  return (
    <div className="sprite" onClick={(e) => e.stopPropagation()}>
      <img ref={img} src={imgUrl(path)} alt="" style={{ display: "none" }} />
      <div className="sprite-side">
        <div className="sprite-preview">
          <canvas ref={preview} />
        </div>
        <label>
          Frame size
          <span className="sprite-size">
            <input type="number" min={1} value={fw} onChange={(e) => setFw(Math.max(1, Number(e.target.value)))} />×
            <input type="number" min={1} value={fh} onChange={(e) => setFh(Math.max(1, Number(e.target.value)))} />
          </span>
        </label>
        <label>
          Speed {fps} fps
          <input type="range" min={1} max={24} value={fps} onChange={(e) => setFps(Number(e.target.value))} />
        </label>
        <label>
          Zoom {zoom}×
          <input type="range" min={1} max={12} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
        </label>
        <div className="small">
          {cols} × {rows} frames · row {row + 1} · frame {frame + 1}
        </div>
        {!fits && <div className="warn small">The sheet isn't a whole number of {fw}×{fh} frames.</div>}
        {info.grid && info.grid.emptyFrames.length > 0 && fw === info.frame.w && <div className="warn small">Empty frames: {info.grid.emptyFrames.join(", ")}</div>}
        <InfoPanel path={path} />
        <div className="muted small">Click a row of the sheet to preview it.</div>
      </div>
      <div className="sprite-sheet">
        <canvas
          ref={sheet}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const y = ((e.clientY - r.top) / r.height) * (info.height ?? 1);
            setRow(Math.max(0, Math.min(rows - 1, Math.floor(y / fh))));
            setFrame(0);
          }}
        />
      </div>
    </div>
  );
}

// Full-window viewer. Keys: ← → move · F fit/actual · A attach · I info · C compare · S sprite · Esc close.
export function Lightbox() {
  const [state, setState] = useState<{ shots: Shot[]; index: number; compare?: string; mode?: "view" | "compare" | "sprite" } | null>(null);
  const [fit, setFit] = useState(true);
  const [pixel, setPixel] = useState(true);
  const [info, setInfo] = useState(false);
  const [picking, setPickingState] = useState(false);
  const pickingRef = useRef(false);
  const setPicking = (v: boolean) => {
    pickingRef.current = v;
    setPickingState(v);
  };
  const [dims, setDims] = useState("");
  const strip = useRef<HTMLDivElement>(null);

  useEffect(() => bus.on("lightbox", (d) => (setState({ mode: d.compare ? "compare" : "view", ...d }), setPicking(false))), []);
  const close = () => setState(null);
  const go = (delta: number) => setState((s) => (s ? { ...s, index: (s.index + delta + s.shots.length) % s.shots.length } : s));
  const setMode = (mode: "view" | "compare" | "sprite") => setState((s) => (s ? { ...s, mode } : s));

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const k = e.key.toLowerCase();
      // Escape steps back one level: cancel picking, then leave compare/sprite, then close.
      // Functional updates, so two quick presses each see the result of the one before.
      if (e.key === "Escape") {
        if (pickingRef.current) {
          pickingRef.current = false;
          setPicking(false);
        } else setState((s) => (!s ? s : s.mode && s.mode !== "view" ? { ...s, mode: "view" } : null));
      }
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (k === "f") setFit((f) => !f);
      else if (k === "a") attach();
      else if (k === "i") setInfo((v) => !v);
      else if (k === "c") setPicking(true);
      else if (k === "s") setMode("sprite");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  useEffect(() => {
    strip.current?.querySelector(".on")?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [state?.index]);

  if (!state) return null;
  const cur = state.shots[state.index];
  const attach = () => {
    bus.emit("attach", cur.path);
    close();
  };
  const mode = state.mode ?? "view";
  return (
    <div className="lightbox" onClick={close}>
      <div className="lb-top" onClick={(e) => e.stopPropagation()}>
        <div className="lb-name">
          <b>{fileName(cur.path)}</b>
          <span className="muted small mono">{folderOf(cur.path)}</span>
        </div>
        <div className="lb-meta muted small">
          {dims}
          {cur.bytes ? ` · ${kb(cur.bytes)}` : ""}
          {cur.mtime ? ` · ${when(cur.mtime)}` : ""} · {state.index + 1} / {state.shots.length}
        </div>
        <div className="lb-actions">
          <button className={`pill ${mode === "view" ? "on" : ""}`} onClick={() => setMode("view")}>
            View
          </button>
          <button className={`pill ${mode === "compare" || picking ? "on" : ""}`} onClick={() => setPicking(true)} title="C: compare with another image" disabled={state.shots.length < 2 && !state.compare}>
            Compare
          </button>
          <button className={`pill ${mode === "sprite" ? "on" : ""}`} onClick={() => setMode("sprite")} disabled={!isPng(cur.path)} title="S: sprite sheet viewer">
            Sprite
          </button>
          <button className={`pill ${info ? "on" : ""}`} onClick={() => setInfo((v) => !v)} disabled={!isPng(cur.path)} title="I: size and palette">
            Info
          </button>
          <button className={`pill ${pixel ? "on" : ""}`} onClick={() => setPixel((p) => !p)} title="Sharp pixels">
            Pixels
          </button>
          {mode === "view" && (
            <button className="pill" onClick={() => setFit((f) => !f)} title="F">
              {fit ? "Actual size" : "Fit"}
            </button>
          )}
          <button className="pill" onClick={() => api.reveal(cur.path)}>
            Show in folder
          </button>
          <button className="pill accent" onClick={attach} title="A">
            Attach
          </button>
          <button className="pill" onClick={close} title="Esc">
            ✕
          </button>
        </div>
      </div>
      {picking && <div className="lb-hint" onClick={(e) => e.stopPropagation()}>Pick the "before" image from the strip below (Esc to cancel).</div>}
      {mode === "compare" && state.compare ? (
        <CompareView a={cur.path} b={state.compare} pixel={pixel} />
      ) : mode === "sprite" ? (
        <SpriteView path={cur.path} />
      ) : (
        <div className={`lb-stage ${fit ? "fit" : "actual"}`} onClick={(e) => e.stopPropagation()}>
          {state.shots.length > 1 && (
            <button className="lb-nav prev" onClick={() => go(-1)} aria-label="Previous">
              ‹
            </button>
          )}
          <img key={cur.path} src={imgUrl(cur.path)} className={pixel ? "pixel" : ""} alt="" onLoad={(e) => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)} onDoubleClick={() => setFit((f) => !f)} />
          {state.shots.length > 1 && (
            <button className="lb-nav next" onClick={() => go(1)} aria-label="Next">
              ›
            </button>
          )}
          {info && <InfoPanel path={cur.path} />}
        </div>
      )}
      {state.shots.length > 1 && (
        <div className={`lb-strip ${picking ? "picking" : ""}`} ref={strip} onClick={(e) => e.stopPropagation()}>
          {state.shots.map((s, i) => (
            <button
              key={s.path + i}
              className={`${i === state.index ? "on" : ""} ${state.compare === s.path && mode === "compare" ? "before" : ""}`}
              onClick={() => {
                if (picking) {
                  setPicking(false);
                  if (i !== state.index) setState({ ...state, compare: s.path, mode: "compare" });
                } else setState({ ...state, index: i });
              }}
            >
              <img src={imgUrl(s.path)} loading="lazy" decoding="async" alt="" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Small thumbnails shown in a message or tool card; clicking opens the viewer.
export function Thumbs({ paths, badges }: { paths: string[]; badges?: Record<string, { text: string; bad?: boolean; compare?: string }> }) {
  if (!paths.length) return null;
  return (
    <div className="thumbs">
      {paths.map((p, i) => {
        const b = badges?.[p];
        return (
          <span key={p} className="thumb-wrap">
            <button className="thumb" onClick={() => bus.emit("lightbox", { shots: paths.map((x) => ({ path: x })), index: i })} title={fileName(p)}>
              <img src={imgUrl(p)} loading="lazy" decoding="async" alt="" />
            </button>
            {b && (
              <button
                className={`thumb-badge ${b.bad ? "bad" : "ok"}`}
                title={b.compare ? "Compare with the golden screenshot" : ""}
                onClick={() => b.compare && bus.emit("lightbox", { shots: [{ path: p }, { path: b.compare }], index: 0, compare: b.compare })}
              >
                {b.text}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}
