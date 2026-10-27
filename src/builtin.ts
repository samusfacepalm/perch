// Agents and skills that ship with Perch. They are written to ~/.perch/agents and ~/.perch/skills
// the first time Perch runs, and never overwritten after that, so they are the user's to edit.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "./config.js";

const AGENTS: Record<string, string> = {
  explorer: `---
name: explorer
description: Read-only codebase investigator. Use it to answer "where is X / how does Y work" questions that need many reads, so the main conversation stays small.
tools: read, glob, grep, list, bash, skill, mcp_tools
---
You investigate a codebase and report what you find. You never change files.
- Search broadly first (glob, grep), then read the files that matter.
- Report concrete facts with path:line references: where things are defined, how data flows, what calls what.
- Say what you could not find or confirm. Keep the report under 400 words unless asked for more.`,

  reviewer: `---
name: reviewer
description: Reviews recent changes for bugs, regressions and missed cases, with fresh eyes. Read-only. Give it the files or the diff command to look at and what the change was meant to do.
tools: read, glob, grep, list, bash
---
You review a change made by another agent. You never change files.
- Look at the actual diff (git diff, or the files named in your brief) and the code around it.
- Look for: logic errors, broken edge cases, things the change forgot to update elsewhere, and behaviour that differs from what the brief says was intended.
- Ignore style and naming unless they cause bugs.
- Report each problem as: path:line, what is wrong, and a concrete failure (input or situation → wrong result). If you find nothing, say so plainly; don't invent problems.`,

  playtester: `---
name: playtester
description: Plays the game and reports what it sees: visual glitches, errors in the log, things that look broken or unfinished. Use it after visual or gameplay changes. Give it what changed and what to look for.
tools: play, read, glob, grep, list, mcp_tools, mcp_call, skill
---
You playtest a game and report what you observe. You don't fix anything.
- Use the play tool. Choose screenshot times that cover what the brief asks about; for web games, send key presses to reach the right state.
- Look carefully at every screenshot. Describe what is actually visible: layout, sprites, text, colours, anything cut off, overlapping, missing or misplaced.
- Read the log for errors and warnings, with file and line where given.
- Report: what works, what's wrong (most serious first, with the screenshot it shows in), and anything you couldn't check.`,

  "asset-artist": `---
name: asset-artist
description: Makes or edits game art (sprites, tiles, icons, UI pieces, simple 3D) with the user's art tools (PixelLab, picoCAD, Blockbench, Blender via MCP), matching the project's existing style and palette.
tools: read, glob, grep, list, bash, write, mcp_tools, mcp_call, skill
---
You make game assets that fit the project.
- First look at the project's existing art: sizes, palette, outline style, naming, and where files live.
- Use the user's MCP art tools (check mcp_tools); load the pixel-art-pipeline skill for sprite work.
- Save new assets beside similar ones, named like them. Report every file you created, its size, and anything you couldn't match.`,
};

const SKILLS: Record<string, string> = {
  "godot-gdscript": `---
name: godot-gdscript
description: Writing and fixing Godot 4 GDScript and scenes: typed GDScript, signals, node paths, Godot 3→4 API changes, and reading Godot error output.
---
# Godot 4 GDScript

## Style
- Static types everywhere: \`var speed: float = 200.0\`, \`func move(dir: Vector2) -> void:\`. Use \`:=\` when the type is obvious.
- \`@export var\` for tunables, \`@onready var sprite: Sprite2D = $Sprite2D\` for child nodes.
- Signals: \`signal died\`, \`died.emit()\`, \`button.pressed.connect(_on_pressed)\`.
- Tabs for indentation. snake_case for functions and variables, PascalCase for classes and nodes.

## Godot 3 → 4 renames that models get wrong
KinematicBody2D→CharacterBody2D (move_and_slide() takes no arguments; set velocity first) · yield→await · export→@export · onready→@onready · instance()→instantiate() · get_tree().change_scene→change_scene_to_file · rand_range→randf_range · deg2rad→deg_to_rad · Position2D→Marker2D · Spatial→Node3D · PoolStringArray→PackedStringArray.

## Scenes (.tscn)
- Text format: [gd_scene load_steps=N format=3], [ext_resource …id="…"], [node name parent], properties.
- Adding a node by hand: add the [node] block under the right parent path and, if it uses a resource, an [ext_resource] with a unique id; bump load_steps. For anything bigger, build nodes in code or use the godot MCP server.

## Reading errors
- "SCRIPT ERROR: Invalid get index 'x' (on base: 'Nil')" → a node path or variable is null; check $Paths and @onready timing.
- "Parse Error" → syntax; the line number is exact.
- "Node not found: 'X'" → wrong $path relative to the script's node.
- Errors print as ERROR:/SCRIPT ERROR: with res://file.gd:line. Fix the first one first; later ones often follow from it.`,

  "rpgmaker-mz-plugins": `---
name: rpgmaker-mz-plugins
description: Writing RPG Maker MZ/MV plugins: header format, parameters, aliasing engine methods, plugin commands, and safe edits to data JSON.
---
# RPG Maker MZ plugins

## Skeleton
\`\`\`js
/*:
 * @target MZ
 * @plugindesc Short description.
 * @author Feisty Parrot Studios
 * @param speed
 * @type number
 * @default 4
 * @help Longer help text.
 */
(() => {
  "use strict";
  const PLUGIN = document.currentScript.src.match(/([^/]+)\\.js$/)[1];
  const params = PluginManager.parameters(PLUGIN);
  const speed = Number(params.speed || 4);
  // Alias, never replace:
  const _Game_Player_update = Game_Player.prototype.update;
  Game_Player.prototype.update = function (sceneActive) {
    _Game_Player_update.call(this, sceneActive);
    // added behaviour
  };
})();
\`\`\`
- Register it in js/plugins.js ({name, status: true, description, parameters}) in the order it should load, after the plugins it depends on.
- Plugin commands (MZ): @command / @arg in the header, and PluginManager.registerCommand(PLUGIN, "name", args => {…}).
- Never edit rmmz_*.js. Never rewrite data/*.json wholesale; when a change is needed, edit the exact entry and keep formatting.
- Test with the play tool: the console log shows plugin errors with file and line.`,

  "pixel-art-pipeline": `---
name: pixel-art-pipeline
description: Making and checking pixel art for a game: matching size, palette and outline style, generating with PixelLab, and checking results before saving into the project.
---
# Pixel art pipeline

1. **Look at existing art first.** Find similar assets (glob for *.png in the sprite folders). Note: tile/sprite size (16, 24, 32, 48…), palette (how many colours, which), outline style (black, coloured, none), shading direction, and naming.
2. **Generate or edit** with the user's tools: PixelLab via mcp_tools/mcp_call (characters, animations, tilesets), picoCAD for low-poly, Aseprite files if present. Ask for the project's exact size and a matching style description.
3. **Check before saving:**
   - Size matches exactly (no 1-pixel drift; sheets are whole multiples of the frame size).
   - Colour count and palette match the project; no stray anti-aliased colours or semi-transparent edge pixels.
   - Transparent background where the project's sprites have one.
   - Frames in a sheet line up on the grid; animation frames keep the same baseline.
4. **Save** beside similar assets with matching names, and report sizes and paths.
5. If the game can be played, play it and look at the new art in place.`,

  "playtest-loop": `---
name: playtest-loop
description: How to check game changes by playing: choosing screenshot times and key presses, reading the log, and when to stop and report instead of digging.
---
# Playtest loop

- Play after any change that affects what the player sees or does. One run per fix is usually enough.
- Pick screenshot times for what you need to see: the title screen shows at ~1s; gameplay needs a few seconds of load; a menu needs key presses first (web games: keys: [{"at": 2, "key": "Enter"}]).
- Look at the screenshots yourself. Describe what's there; compare against what the change should have done.
- Read errors before screenshots: a script error usually explains a missing sprite or a frozen scene.
- If two runs fail to start or to capture anything, stop. Report what happened and what you tried; don't investigate the machine.
- Don't "fix" things the user didn't ask about. List them in your reply.`,
};

export function installBuiltins() {
  try {
    const agentDir = path.join(HOME, "agents");
    fs.mkdirSync(agentDir, { recursive: true });
    for (const [name, text] of Object.entries(AGENTS)) {
      const f = path.join(agentDir, `${name}.md`);
      if (!fs.existsSync(f)) fs.writeFileSync(f, text + "\n");
    }
    for (const [name, text] of Object.entries(SKILLS)) {
      const dir = path.join(HOME, "skills", name);
      const f = path.join(dir, "SKILL.md");
      if (fs.existsSync(f)) continue;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(f, text + "\n");
    }
  } catch {
    // a read-only home folder shouldn't stop Perch from starting
  }
}
