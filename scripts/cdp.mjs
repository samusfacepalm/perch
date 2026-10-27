// Dev helper: drive the running app over Chrome DevTools Protocol.
// Start the app with `npx electron . --remote-debugging-port=9334`, then:
//   node scripts/cdp.mjs eval "<js expression>"
//   node scripts/cdp.mjs shot <out.png>
//   node scripts/cdp.mjs reload

const [cmd, arg] = process.argv.slice(2);
const targets = await (await fetch("http://127.0.0.1:9334/json")).json();
const page = targets.find((t) => t.type === "page");
if (!page) throw new Error("No page target; is the app running with --remote-debugging-port=9334?");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let n = 0;
const call = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++n;
    const onMsg = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMsg);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });

if (cmd === "eval") {
  const r = await call("Runtime.evaluate", { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result.value ?? r.exceptionDetails ?? r.result, null, 2));
} else if (cmd === "reload") {
  await call("Page.reload", { ignoreCache: true });
  console.log("reloaded");
} else if (cmd === "shot") {
  const { writeFileSync } = await import("node:fs");
  // Optional close-up: shot <out.png> x,y,width,height (rendered at 2x)
  const clip = process.argv[4]?.split(",").map(Number);
  const r = await call("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3], scale: 2 } } : {}) });
  writeFileSync(arg, Buffer.from(r.data, "base64"));
  console.log("saved", arg);
}
ws.close();
