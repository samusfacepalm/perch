// Dev helper: run a project's game natively and print the result.
import { detectPlay, runNative, formatResult } from "../src/play.js";
const [cwd, secs, shots] = process.argv.slice(2);
const r = await runNative(detectPlay(cwd), cwd, { seconds: Number(secs ?? 8), shots: shots ? shots.split(",").map(Number) : undefined });
console.log(formatResult(r).replace(/Log \(last part\):[\s\S]*/, (m) => m.split("\n").slice(0, 25).join("\n")));
