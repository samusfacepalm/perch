import { detectPlay, runNative, formatResult } from "../src/play.js";
const cwd = process.argv[2];
const plan = detectPlay(cwd);
console.log("plan:", JSON.stringify(plan));
if (plan.command) {
  const r = await runNative(plan, cwd, { seconds: Number(process.argv[3] ?? 6) });
  console.log(formatResult(r));
}
