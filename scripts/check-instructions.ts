import { loadInstructions, loadSkills, loadAgents } from "../src/instructions.js";
const cwd = process.argv[2] ?? process.cwd();
for (const f of loadInstructions(cwd)) console.log(`${f.kind.padEnd(8)} ${String(f.text.length).padStart(6)} chars  ${f.path}`);
const skills = loadSkills(cwd);
console.log(`${skills.length} skills, e.g.`, skills.slice(0, 4).map((s) => `${s.name} (${s.source})`).join(", "));
console.log("skill list size:", skills.map((s) => s.name + ": " + s.description.slice(0, 160)).join("\n").length, "chars");
console.log("agents:", loadAgents(cwd).map((a) => `${a.name} [${a.model ?? "default"}]`).join(", "));
