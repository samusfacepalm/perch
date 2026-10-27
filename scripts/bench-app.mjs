// Dev helper: times the desktop app in the 3000-message benchmark session (make-big-session.ts).
// Start the app with --remote-debugging-port=9334, then: node scripts/bench-app.mjs
import { execFileSync } from "node:child_process";

const evalPage = (js) => JSON.parse(execFileSync(process.execPath, ["scripts/cdp.mjs", "eval", js], { encoding: "utf8" }));

const frame = `() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;

const open = evalPage(`(async () => {
  const frame = ${frame};
  const row = [...document.querySelectorAll(".sess")].find((s) => s.textContent.includes("[benchmark]"));
  if (!row) return "no benchmark session in the sidebar";
  const other = [...document.querySelectorAll(".sess")].find((s) => s !== row);
  other.click();
  await new Promise((r) => setTimeout(r, 1500));
  const t0 = performance.now();
  row.click();
  while (document.querySelectorAll(".msg").length < 100 || !document.querySelector("header .t")?.textContent.includes("[benchmark]")) await new Promise((r) => requestAnimationFrame(r));
  await frame();
  return { openMs: Math.round(performance.now() - t0), msgs: document.querySelectorAll(".msg").length, domNodes: document.getElementsByTagName("*").length };
})()`);
console.log("open session:", open);

const typing = evalPage(`(async () => {
  const frame = ${frame};
  const box = document.querySelector("textarea");
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  const times = [];
  for (const ch of "the parrot bites things to check they are real metal") {
    const t0 = performance.now();
    set.call(box, box.value + ch);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await frame();
    times.push(performance.now() - t0);
  }
  set.call(box, "");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  times.sort((a, b) => a - b);
  return { keys: times.length, medianMs: +times[times.length >> 1].toFixed(1), worstMs: +times.at(-1).toFixed(1) };
})()`);
console.log("typing (key to painted frame):", typing);

const scroll = evalPage(`(async () => {
  const frame = ${frame};
  const el = [...document.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 1000 && getComputedStyle(e).overflowY !== "visible");
  if (!el) return "no scroller";
  const times = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    el.scrollTop = Math.max(0, el.scrollTop - 600);
    await frame();
    times.push(performance.now() - t0);
  }
  el.scrollTop = el.scrollHeight;
  times.sort((a, b) => a - b);
  return { medianMs: +times[15].toFixed(1), worstMs: +times.at(-1).toFixed(1) };
})()`);
console.log("scrolling up 600px a step:", scroll);
