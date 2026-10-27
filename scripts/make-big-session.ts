// Dev helper: writes a large fake session to measure UI speed.
import { newSession, saveSession } from "../src/session.js";
const s = newSession(process.cwd(), "deepseek/deepseek-flash");
s.title = "[benchmark] 3000-message session";
for (let i = 0; i < 600; i++) {
  s.history.push({ role: "user", content: `Step ${i}: please refactor module ${i} and run the tests.` });
  s.history.push({
    role: "assistant",
    content: `Working on **module ${i}**. Here's the plan:\n\n- read the file\n- edit \`fn${i}\`\n- run tests\n\n\`\`\`ts\nexport function fn${i}(x: number) {\n  return x * ${i};\n}\n\`\`\``,
    tool_calls: [{ id: `c${i}`, type: "function", function: { name: "edit", arguments: JSON.stringify({ path: `src/m${i}.ts`, old_string: "a", new_string: "b" }) } }],
  });
  s.history.push({ role: "tool", tool_call_id: `c${i}`, content: `Edited src/m${i}.ts.` });
  s.history.push({ role: "assistant", content: `Tests pass for module ${i}. | a | b |\n|---|---|\n| 1 | 2 |` });
  s.history.push({ role: "user", content: "next" });
}
s.messages = [{ role: "system", content: "x" }];
saveSession(s);
console.log(s.id, s.history.length, "messages");
