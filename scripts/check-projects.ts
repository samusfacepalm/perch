import { knownProjects } from "../src/projects.js";
const ps = await knownProjects();
console.log(ps.length, "projects");
for (const p of ps) console.log(`${p.name.padEnd(28)} ${p.sources.join("+").padEnd(22)} ${(p.lastUsed ?? "").slice(0, 10)}  ${p.path}`);
