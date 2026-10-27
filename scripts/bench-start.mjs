// Dev helper: CPU time to load the terminal app, file by file against the bundle.
// Run after building both: node scripts/bench-start.mjs
import { execFileSync } from "node:child_process";
const probe = (entry) => `const c=process.cpuUsage();process.argv.push("--help");const w=process.stdout.write.bind(process.stdout);process.stdout.write=()=>true;await import(${JSON.stringify(entry)});const u=process.cpuUsage(c);w(String(Math.round((u.user+u.system)/1000)))`;
for (const [name, entry] of [["file by file", "./dist/cli.js"], ["bundled", "./dist/perch.mjs"]]) {
  const runs = Array.from({ length: 5 }, () => Number(execFileSync(process.execPath, ["--input-type=module", "-e", probe(entry)], { encoding: "utf8" })));
  console.log(name.padEnd(14), "cpu ms:", runs.join(" "), " median", runs.sort((a, b) => a - b)[2]);
}
