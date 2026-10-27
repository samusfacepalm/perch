// Dev helper: CPU time each startup import costs, which a busy machine barely skews.
// Run after `npm run build`: node scripts/bench-imports.mjs
const mods = ["react", "ink", "../dist/config.js", "../dist/session.js", "../dist/provider.js", "../dist/agent.js", "../dist/ui/App.js", "../dist/builtin.js"];
const all = process.cpuUsage();
for (const m of mods) {
  const c = process.cpuUsage();
  await import(m);
  const u = process.cpuUsage(c);
  console.log(m.padEnd(22), "cpu", String(Math.round((u.user + u.system) / 1000)).padStart(4), "ms");
}
const u = process.cpuUsage(all);
console.log("total".padEnd(22), "cpu", Math.round((u.user + u.system) / 1000), "ms");
