import { loadConfig, discoverLocal, modelChoices } from "../src/config.js";
const c = loadConfig();
console.log(await discoverLocal(c));
for (const m of modelChoices(c)) if (!m.ref.startsWith("opencode-go")) console.log(`${m.ref} | ${m.name} | ${m.provider} | key:${m.hasKey}`);
