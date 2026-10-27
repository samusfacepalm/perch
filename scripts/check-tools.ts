import { toolsFor } from "../src/agent.js";
const tools = toolsFor(process.argv[2] ?? process.cwd());
console.log(tools.map((t) => `${t.name} (${t.description.length} chars)`).join("\n"));
console.log("total description chars:", tools.reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters).length, 0));
