// The model's view of MCP servers: browse with mcp_tools, run with mcp_call.

import { callTool, connect, type ServerConfig } from "../mcpClient.js";
import { ToolError, type Tool } from "./types.js";

export function makeMcpTools(servers: ServerConfig[]): Tool[] {
  if (!servers.length) return [];
  const byName = (name: string) => {
    const s = servers.find((x) => x.name === name) ?? servers.find((x) => x.name.toLowerCase() === String(name).toLowerCase());
    if (!s) throw new ToolError(`No MCP server named "${name}". Configured: ${servers.map((x) => x.name).join(", ")}`);
    return s;
  };
  const list = servers.map((s) => `- ${s.name} (${s.type === "http" ? s.url : s.command}; from ${s.source})`).join("\n");

  const mcpTools: Tool = {
    name: "mcp_tools",
    description: `Browse the MCP servers the user has set up (for apps such as game engines, 3D tools and art generators). Servers start on first use.
Whenever the user mentions one of these servers or its app, use this tool to find out what it can do. Never search the disk or package caches for a server's code instead.
- No arguments: list the servers.
- server: list that server's tools with one-line descriptions.
- server and tool: show that tool's full argument schema. Always check the schema before calling a tool for the first time.

Configured servers:
${list}`,
    parameters: {
      type: "object",
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
      },
    },
    summarize: (a) => [a.server, a.tool].filter(Boolean).join(" / ") || "servers",
    async run(a) {
      if (!a.server) return { output: `MCP servers:\n${list}\n\nCall mcp_tools with a server name to see its tools.`, title: `${servers.length} servers` };
      const cfg = byName(a.server);
      let conn;
      try {
        conn = await connect(cfg);
      } catch (e: any) {
        throw new ToolError(`Could not start or reach "${cfg.name}": ${e.message}. If it is an app's plugin (Blender, Godot, Unity, Blockbench), the app may need to be open with its MCP plugin running.`);
      }
      const tools = conn.tools ?? [];
      if (!a.tool) {
        const lines = tools.map((t) => `- ${t.name}: ${(t.description ?? "").replace(/\s+/g, " ").slice(0, 140)}`);
        const notes = conn.instructions ? `\n\nServer notes:\n${conn.instructions.slice(0, 3000)}` : "";
        return { output: `${cfg.name} has ${tools.length} tools:\n${lines.join("\n")}${notes}`, title: `${tools.length} tools` };
      }
      const t = tools.find((x) => x.name === a.tool);
      if (!t) throw new ToolError(`"${cfg.name}" has no tool "${a.tool}".`);
      return { output: `${t.name}\n\n${t.description ?? ""}\n\nArguments (JSON schema):\n${JSON.stringify(t.inputSchema ?? {}, null, 1)}`, title: t.name };
    },
  };

  const mcpCall: Tool = {
    name: "mcp_call",
    description: `Run a tool on one of the user's MCP servers. Check the tool's schema with mcp_tools first. Images the tool returns are saved to files and their paths are listed in the result.`,
    parameters: {
      type: "object",
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object", description: "The tool's arguments, matching its schema" },
      },
      required: ["server", "tool"],
    },
    summarize: (a) => `${a.server} / ${a.tool}`,
    async run(a) {
      const cfg = byName(a.server);
      let r;
      try {
        r = await callTool(cfg, a.tool, a.arguments ?? {});
      } catch (e: any) {
        throw new ToolError(`${cfg.name}/${a.tool} failed: ${e.message}`);
      }
      const imgs = r.images.length ? `\n\nImages saved:\n${r.images.join("\n")}` : "";
      const output = (r.isError ? "The tool reported an error:\n" : "") + (r.text || "(no text output)") + imgs;
      return { output, title: `${cfg.name} / ${a.tool}`, images: r.images };
    },
  };

  return [mcpTools, mcpCall];
}
