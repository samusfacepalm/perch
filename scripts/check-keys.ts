import { detectPlay, runNative, formatResult } from "../src/play.js";
const cwd = process.argv[2];
const r = await runNative(detectPlay(cwd), cwd, {
  seconds: 7,
  shots: [1.5, 3.4, 5.5],
  keys: [{ at: 3, key: "Space" }, { at: 5, key: "ArrowRight" }, { at: 5.2, key: "KeyA" }],
});
console.log(formatResult(r));
