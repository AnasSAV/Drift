// What Claude may do, decided per phase. Built-in tools are limited to reading; everything that
// changes Drift goes through the drift server's `apply`, which this policy inspects op by op.
//
// The plan phase may only research: import the source media, transcribe it, list presets and
// voices, search stock. The build phase may edit the timeline but never touches the user's
// project lifecycle, preferences or installs. Billable cloud ops (ElevenLabs/Fish) are allowed
// only when the approved storyboard asked for cloud voiceover.

import { isAbsolute, relative, resolve } from "node:path";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Phase } from "./events.js";
import type { Storyboard } from "./storyboard.js";

export const DRIFT = "drift";
export const STUDIO = "studio";

// Read-only Drift tools served directly. Safe in every phase.
export const DRIFT_READ_TOOLS = ["catalog", "search", "toolbox", "inspect", "activity", "frames", "capture"].map(
  (t) => `mcp__${DRIFT}__${t}`,
);
export const SUBMIT_TOOL = `mcp__${STUDIO}__submit_storyboard`;

// Ops the plan phase may run through apply.
export const RESEARCH_OPS = [
  // footage and documents
  "import_media", "list_assets", "inspect_pdf", "list_folders",
  "transcribe", "get_transcript", "diarize", "get_job",
  "detect_scenes", "list_scenes", "find_scenes", "describe_clip",
  "audio_summary", "audio_events", "audio_tag", "audio_find", "detect_silence", "detect_beats",
  "get_waveform", "analyze_loudness", "list_whisper_languages",
  // what Drift can make
  "list_text_presets", "list_text_looks", "list_text_animations", "list_text_effects", "list_fonts",
  "list_gradient_presets", "list_effects", "list_audio_effects", "list_transitions",
  "list_effect_templates", "list_easing_presets", "list_shapes", "list_stickers", "list_emoji",
  "list_voices", "list_local_voices", "local_tts_status", "cloud_provider_status",
  "market_status", "market_search", "market_item", "market_preview",
  "ai_capabilities", "list_addons", "list_procedurals", "list_export_presets",
];

// Never, in any phase.
const BLOCKED_OPS = new Set([
  "new_project", "load_project", "close_project", "quit_instance", "package_project",
  "export_video", "export_with_preset", "flatten_composite",
  "set_theme", "import_theme", "export_theme", "select_theme", "set_shortcut", "reset_shortcuts",
  "set_ui_preferences", "set_acceleration",
  "install_addon", "install_addons", "market_open",
  "restore_snapshot", "clear_history", "set_history_limit",
]);

// Spend money on the user's cloud accounts.
function isBillable(tool: string, args: Record<string, unknown>): boolean {
  if (tool === "sfx_generate" || tool === "add_voice") return true;
  if (tool === "tts_generate" || tool === "voiceover_from_subtitles") return args.provider !== "local";
  if (tool === "transcribe") return args.engine === "elevenlabs";
  return false;
}

export interface PolicyState {
  phase: Phase;
  storyboard?: Storyboard;
  readRoots: string[];
  onDenied(name: string, reason: string): void;
}

function within(path: string, roots: string[]): boolean {
  const p = resolve(path);
  return roots.some((root) => {
    const rel = relative(resolve(root), p);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

const deny = (message: string): PermissionResult => ({ behavior: "deny", message });
const allow = (input: Record<string, unknown>): PermissionResult => ({ behavior: "allow", updatedInput: input });

export function makeCanUseTool(state: PolicyState): CanUseTool {
  return async (toolName, input) => {
    const verdict = decide(state, toolName, input);
    if (verdict.behavior === "deny") state.onDenied(toolName, verdict.message);
    return verdict;
  };
}

export function decide(state: PolicyState, toolName: string, input: Record<string, unknown>): PermissionResult {
  // Every call comes through here: nothing is listed in allowedTools, because a bare entry there
  // approves the tool before this callback is consulted and would bypass the folder check below.
  if (DRIFT_READ_TOOLS.includes(toolName) || toolName === SUBMIT_TOOL || toolName === "WebFetch") {
    return allow(input);
  }

  // Reads are confined to the source and skill folders.
  if (toolName === "Read" || toolName === "Glob" || toolName === "Grep") {
    const path = (input.file_path ?? input.path) as string | undefined;
    // No path means the working folder, which is the source folder.
    if (!path || within(path, state.readRoots)) return allow(input);
    return deny(`Only the source and skill folders are readable (${state.readRoots.join(", ")}).`);
  }

  if (toolName === `mcp__${DRIFT}__apply`) {
    const ops = Array.isArray(input.ops) ? (input.ops as { tool?: string; args?: Record<string, unknown> }[]) : [];
    for (const op of ops) {
      const tool = op.tool ?? "";
      const args = op.args ?? {};
      if (BLOCKED_OPS.has(tool)) return deny(`${tool} is not allowed: the user manages the project, settings and exports.`);
      if (state.phase === "plan" && !RESEARCH_OPS.includes(tool)) {
        return deny(`${tool} edits the timeline; building waits until the storyboard is approved. Call submit_storyboard.`);
      }
      if (isBillable(tool, args) && state.storyboard?.voiceover !== "cloud") {
        return deny(`${tool} would bill the user's cloud account; the approved storyboard did not ask for cloud voice. Use provider "local".`);
      }
    }
    return allow(input);
  }

  return deny(`${toolName} is not available in this run.`);
}
