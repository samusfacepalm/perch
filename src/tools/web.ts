// Web search and page fetching.
//
// Search goes to Exa's public MCP endpoint, the same one OpenCode uses: no key, no account, and
// the results come back as page text rather than bare links. Fetch reads a page the way a
// browser would ask for it and turns the HTML into plain markdown-ish text; images are saved to
// a file so models that can see get the picture itself.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../config.js";
import { ToolError, type Tool } from "./types.js";

const EXA = "https://mcp.exa.ai/mcp";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const MAX_BYTES = 5_000_000;
const MAX_CHARS = 120_000;

export const webSearch: Tool = {
  name: "web_search",
  description: `Search the web and get the text of the best matching pages.
- Use it for anything that may have changed since your training: library versions, API changes, error messages, release notes, documentation.
- Describe the page you want rather than listing keywords ("Godot 4.6 migration guide for TileMap" beats "godot tilemap 4.6").
- Results are page excerpts with their URLs. Read a promising page in full with web_fetch.`,
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      results: { type: "number", description: "How many pages, 1 to 10 (default 5)" },
    },
    required: ["query"],
  },
  summarize: (a) => a.query,
  async run(a, ctx) {
    if (typeof a.query !== "string" || !a.query.trim()) throw new ToolError("query is required.");
    const numResults = Math.min(10, Math.max(1, Math.round(a.results ?? 5)));
    const res = await fetch(EXA, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "perch/0.1.0" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: { query: a.query, numResults } } }),
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(45_000)]),
    });
    if (!res.ok) throw new ToolError(`The search service returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const msg = parseRpc(await res.text());
    if (msg?.error) throw new ToolError(`Search failed: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    const text = (msg?.result?.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n\n").trim();
    return { output: text ? clip(text) : "No results.", title: `search: ${a.query}` };
  },
};

// The endpoint answers with JSON or with one SSE event carrying it.
function parseRpc(body: string): any {
  try {
    return JSON.parse(body);
  } catch {}
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      return JSON.parse(line.slice(5).trim());
    } catch {}
  }
  return undefined;
}

export const webFetch: Tool = {
  name: "web_fetch",
  description: `Read a web page or file from a URL. HTML comes back as text with headings, lists and links kept; JSON and plain text as they are; images as an image you can see.
- Use it for documentation, issues, release notes and pages the user links. Prefer the raw form when there is one (raw.githubusercontent.com rather than the GitHub page).
- Pages that need JavaScript to show their content may come back nearly empty; for those, say so rather than guessing.`,
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "http or https URL" } },
    required: ["url"],
  },
  summarize: (a) => a.url,
  async run(a, ctx) {
    let url: URL;
    try {
      url = new URL(String(a.url ?? "").trim());
    } catch {
      throw new ToolError("url must be a full http or https URL.");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new ToolError("Only http and https URLs can be fetched.");
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8", "accept-language": "en-AU,en;q=0.9" },
      redirect: "follow",
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
    });
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const bytes = Buffer.from(await readCapped(res));
    const where = res.url && res.url !== url.href ? ` (redirected to ${res.url})` : "";
    if (!res.ok) throw new ToolError(`${url.href}${where} returned ${res.status}. ${bytes.toString("utf8").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300)}`);

    if (type.startsWith("image/")) {
      const dir = path.join(HOME, "web");
      fs.mkdirSync(dir, { recursive: true });
      const ext = type.split("/")[1].split(/[;+]/)[0].replace("jpeg", "jpg");
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.${ext}`);
      fs.writeFileSync(file, bytes);
      return { output: `Image (${type}, ${bytes.length} bytes) saved to ${file}`, images: [file], title: url.href };
    }
    if (type.includes("pdf")) {
      const dir = path.join(HOME, "web");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`);
      fs.writeFileSync(file, bytes);
      return { output: `PDF (${bytes.length} bytes) saved to ${file}. Extract its text with a command (for example Python with PyMuPDF) to read it.`, title: url.href };
    }
    const text = bytes.toString("utf8");
    const body = /html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(text) ? htmlToText(text, res.url || url.href) : text;
    return { output: `${url.href}${where}\n\n${clip(body.trim() || "(the page has no readable text; it may need JavaScript)")}`, title: url.href };
  },
};

async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(parts);
}

function clip(text: string): string {
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) + `\n\n[cut at ${MAX_CHARS} of ${text.length} characters]` : text;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©" };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

// Enough of HTML to read documentation: the main content, headings, lists, links, code and
// tables as rows. Not a full parser; navigation and scripts are dropped.
export function htmlToText(html: string, base: string): string {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "");
  let h = html.replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const main = /<main\b[^>]*>([\s\S]*)<\/main>/i.exec(h)?.[1] ?? /<article\b[^>]*>([\s\S]*)<\/article>/i.exec(h)?.[1];
  h = main ?? (/<body\b[^>]*>([\s\S]*)<\/body>/i.exec(h)?.[1] ?? h);
  if (!main) h = h.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, "");
  const abs = (href: string) => {
    try {
      return new URL(decode(href), base).href;
    } catch {
      return href;
    }
  };
  const pres: string[] = [];
  h = h
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => `\n\u0000${pres.push(decode(code.replace(/<[^>]+>/g, ""))) - 1}\u0000\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(Number(n))} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`)
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => {
      const text = t.replace(/<[^>]+>/g, "").trim();
      return text && !href.startsWith("#") && !href.startsWith("javascript:") ? `[${text}](${abs(href)})` : text;
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, t) => "`" + t.replace(/<[^>]+>/g, "") + "`")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<\/?(p|div|section|ul|ol|table|tr|blockquote|dl|dt|dd|figure|figcaption)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  let text = decode(h)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/^-$/gm, "") // list items that held only an icon or a widget
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n\n(?=- )/g, "\n");
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => "```\n" + pres[Number(i)].replace(/\n+$/, "") + "\n```");
  return (title ? `# ${title}\n\n` : "") + text.trim();
}
