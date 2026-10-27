import { configuredServers, connect, stopAllMcp } from "../src/mcpClient.js";
const servers = configuredServers(process.argv[2] ?? process.cwd());
for (const s of servers) console.log(`${s.name.padEnd(16)} ${s.type.padEnd(5)} ${s.source.padEnd(22)} ${s.url ?? [s.command, ...(s.args ?? [])].join(" ")}`);
for (const name of (process.argv[3] ?? "").split(",").filter(Boolean)) {
  const t = Date.now();
  try {
    const c = await connect(servers.find((s) => s.name === name)!);
    console.log(`${name}: ${c.tools?.length} tools in ${Date.now() - t} ms, e.g. ${c.tools?.slice(0, 4).map((x) => x.name).join(", ")}`);
  } catch (e: any) {
    console.log(`${name}: FAILED after ${Date.now() - t} ms: ${e.message.slice(0, 200)}`);
  }
}
stopAllMcp();
setTimeout(() => process.exit(0), 300);
