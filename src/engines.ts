// Engine-specific guidance, added to the system prompt when Perch recognises the project.

import { detectPlay } from "./play.js";

const NOTES: Record<string, string> = {
  Godot: `This is a Godot 4 project (project.godot).
- Scripts are GDScript (.gd). Use static typing (var speed: float = 200.0, func _ready() -> void), tabs for indentation, snake_case names, and @export / @onready where the project does.
- Scenes are text .tscn files. Small edits to them are fine; for larger structural changes, prefer creating nodes in code or via the godot MCP server, because hand-written .tscn edits break easily (ids, load_steps, ext_resource paths).
- Resource paths start with res://. Never hard-code absolute file paths.
- Godot 4 renamed many Godot 3 APIs (KinematicBody2D → CharacterBody2D, yield → await, export → @export, connect("signal", obj, "method") → signal.connect(callable)). Write Godot 4 code.
- After changes, use the play tool: errors appear in its log as "ERROR:" or "SCRIPT ERROR:" lines with res:// file and line numbers.`,
  Unity: `This is a Unity project (Assets/, ProjectSettings/).
- Scripts are C# MonoBehaviours under Assets/. Match the project's namespaces and folder layout.
- Never edit .meta files, Library/, or Temp/; never rename or move assets outside the editor, or their .meta GUIDs and references break.
- Scenes and prefabs are YAML; avoid hand-editing them.
- Play mode needs the editor. The play tool runs the newest build in Build/ if there is one; otherwise use the unity MCP server, or ask the user to test in the editor.`,
  "RPG Maker MZ": `This is an RPG Maker MZ game (js/rmmz_core.js).
- Custom behaviour goes in plugins: js/plugins/*.js, registered in js/plugins.js. Follow the plugin header conventions (/*: @target MZ @plugindesc @param …*/) and wrap code in an IIFE.
- Don't edit the engine's own files in js/ (rmmz_*.js); alias methods in a plugin instead (const _Scene_Map_start = Scene_Map.prototype.start; …).
- data/*.json holds the database and maps. They are large and the editor rewrites them; change them only when asked, keep their exact structure, and never reformat them.
- The play tool runs the game in a play window from index.html; the browser console is the log.`,
  "RPG Maker MV": `This is an RPG Maker MV game (js/rpg_core.js). Same rules as MZ: write plugins in js/plugins/ and register them in js/plugins.js, alias engine methods instead of editing rpg_*.js, and treat data/*.json with care.`,
  Phaser: `This is a Phaser game. Use the Phaser 3 scene lifecycle (preload, create, update) and the project's existing structure. Load assets in preload with keys, and reuse the project's config for size and physics.`,
};

export function engineNotes(cwd: string): string {
  let plan;
  try {
    plan = detectPlay(cwd);
  } catch {
    return "";
  }
  const note = plan.engine ? NOTES[plan.engine] : undefined;
  if (note) return note;
  if (plan.kind === "web") return "This looks like a web game (index.html). The play tool runs it in a play window; the browser console is the log.";
  return "";
}
