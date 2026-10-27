import { ggufInfo } from "../src/local.js";
for (const f of process.argv.slice(2)) console.log(JSON.stringify(await ggufInfo(f)), f);
