# perch

A small terminal coding agent for DeepSeek, OpenCode Go and other OpenAI-compatible models.
The interface follows Claude Code and the old OpenCode. The parts that decide result quality
come from reading the source of OpenCode (v1.19.4) and DeepSeek Harness (deepseek-ai/deepseek-harness).

## Install

```
npm install
npm run build
npm link        # puts `perch` on your PATH
```

## Use

```
perch                     start in the current folder
perch -n                  no folder: a fresh scratch folder under ~/.perch/scratch
perch -c                  continue the last session in this folder
perch -r <id>             resume a session
perch -p "task"           run without the UI and print the result (auto-continue on)
perch -m deepseek/deepseek-flash
perch models              list models and where each key comes from
perch sessions [--all]
```

In the UI: `/help`, `/model`, `/status` (context use and cache hit rate), `/todos`, `/compact`,
`/auto` (keep going while todos are open), `/cd <folder>` (move a scratch session into a project),
`/sessions`, `/exit`. Esc interrupts. Ctrl+J adds a new line.

## Keys

Nothing is copied. Keys are read at start-up from environment variables (`DEEPSEEK_API_KEY`,
`OPENCODE_GO_API_KEY`), then OpenCode's `auth.json`, then OpenCode's `opencode.json`.
Providers and models in `opencode.json` are imported too, except Anthropic-format endpoints.

## Config: `~/.perch/config.json` (optional)

```json
{
  "model": "deepseek/deepseek-v4-pro",
  "smallModel": "deepseek/deepseek-flash",
  "permissions": { "edit": "allow", "write": "ask", "bash": "ask" },
  "bashAllow": ["npm test", "npm run", "git status", "git diff"],
  "maxSteps": 400,
  "compactTokens": 200000,
  "providers": {
    "deepseek": { "extraBody": { "reasoning_effort": "max" } }
  }
}
```

Project instructions come from `AGENTS.md`, `CLAUDE.md` or `PERCH.md` in the folder and its
parents, plus `~/.perch/AGENTS.md`.

## What it does for long tasks, and where each idea came from

- **Prefix-cache discipline** (DeepSeek Harness): the system prompt and tool list never change
  within a session, and history is append-only between compactions. Cached input costs about 2%
  of uncached on DeepSeek. `/status` shows the hit rate.
- **Compaction** (both): triggers at the lowest of 80% of the window, window minus output minus
  64K, or 200K tokens. The summary request reuses the cached conversation (DeepSeek Harness).
  The newest messages are kept verbatim, the previous summary is merged rather than copied
  forward, and the todo list is carried outside the summary. The section layout follows OpenCode,
  with an added "Dead Ends" section.
- **Todo list** that survives compaction, with optional auto-continue while items are open.
- **Subagents** (`task`) with fresh context; several run in parallel.
- **Long tool output** goes to `~/.perch/tool-output`; the model gets the head, the tail and the path.
- **Edit matching** (OpenCode): exact first, then line-trimmed, block-anchor, whitespace,
  indentation, escape and boundary matchers. A loose match is accepted only when it is unique and
  not much larger than what the model wrote. Read-before-edit is enforced, and so is the check
  that the file hasn't changed since.
- **Argument order** (DeepSeek Harness measurements): `description` comes before `command`, and
  `path` before the strings.
- **Repairs:** `reasoning_content` is echoed on every assistant turn (DeepSeek returns 400
  without it). Unanswered tool calls get filler results after an interrupt. Repeated identical
  calls trigger a warning. Retries use backoff. At the step limit, tools are withdrawn and the
  model writes a hand-over.

## Desktop app

`perch app`, or the Perch shortcut. Sessions and projects (imported from Claude Code and
OpenCode) in the sidebar; Plan, Usage (context, cache, cost), Shots and Setup tabs on the right;
**Keys & models** to import API keys and start local GGUF models with llama.cpp. Images can be
pasted or dropped into the message box; DeepSeek V4.1 Flash can see them.

## Game development

- **Play** (header button, and the agent's `play` tool): runs the game, takes screenshots while it
  runs, and collects its log. Godot (`project.godot`, using Godot's console build for logs), web
  games and RPG Maker MZ/MV (served locally, run in a play window; the console is the log), Vite
  dev servers, and built `.exe` files, including Unity builds in `Build/`. Anything else: add
  `.perch/play.json` with `command` (and `url` for web games). Native windows are captured with a
  small helper compiled on first use, so it works even when the game window is covered.
- **Run card**: screenshots, error lines, the log, and **Ask Perch to fix**, which sends the lot.
- **Golden screenshots**: **Set as golden** saves a run as the known-good reference in
  `.perch/golden/`; later runs, the agent's included, report how much each shot changed.
- **Viewer**: Compare (before/after slider, or a difference map), Sprite (frame grid, animation
  preview, palette), Info (size, colour count, soft-edge warnings). Keys: ← → F A I C S Esc.
- **Shots tab**: screenshots from play runs, MCP tools and attachments; **Assets** browses every
  image and sound in the project.
- **inspect_image** tool: palette, transparency, sprite grid problems, and image comparison.
- **Engine notes**: Godot, Unity, RPG Maker and Phaser projects get engine-specific guidance in
  the system prompt.

## Instructions, skills, agents, MCP

- Reads your `~/.claude/CLAUDE.md` and OpenCode `AGENTS.md` (duplicate paragraphs dropped), project
  `AGENTS.md`/`CLAUDE.md`, and Claude Code's memory notes for the project.
- Skills from `~/.claude/skills`, OpenCode and `~/.perch/skills` load on demand. Perch installs
  `godot-gdscript`, `rpgmaker-mz-plugins`, `pixel-art-pipeline` and `playtest-loop` there once.
- Specialist subagents in `~/.perch/agents` (`explorer`, `reviewer`, `playtester`,
  `asset-artist`), each limited to the tools it needs, plus any from Claude Code and OpenCode.
- MCP servers configured for Claude Code or OpenCode are available through `mcp_tools` and
  `mcp_call`, started only when first used.
- `perch mcp` runs Perch as an MCP server, so Claude Code can delegate work to DeepSeek.

## Not done yet

Git-snapshot undo (OpenCode's `/undo`), web fetch/search tools, key presses for native games,
and Claude Code plugin MCP servers.

## Licence

MIT. © 2026 Feisty Parrot Studios. See [LICENSE](LICENSE).
