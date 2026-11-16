// The storyboard is the contract between the plan phase and the build phase: Claude proposes it
// through the submit_storyboard tool, the user edits or approves it, and the build phase is told
// to follow the approved version exactly. Keeping it a plain JSON document means the user can edit
// it in any text editor now, and the Drift panel can render and edit the same shape later.

import { z } from "zod";
import { bold, dim } from "./events.js";

export const sceneShape = {
  id: z.string().describe("Short stable id, e.g. s1, s2"),
  title: z.string().describe("What this scene is about, a few words"),
  durationSec: z.number().positive().describe("Planned length in seconds"),
  narration: z
    .string()
    .describe("Exact voiceover script for this scene; empty string when the scene has no voice"),
  onScreenText: z
    .array(z.string())
    .describe("Titles, captions or callouts shown on screen, in order"),
  visuals: z
    .string()
    .describe(
      "What the viewer sees and how it moves: footage ranges, SVG diagram, shapes, stock search, text style, animation",
    ),
  sourceRefs: z
    .array(z.string())
    .optional()
    .describe("Where the content comes from: file paths with line ranges, page numbers, or source timecodes"),
  transition: z.string().optional().describe("Transition into the next scene, or empty for a hard cut"),
};

export const storyboardShape = {
  title: z.string().describe("Working title of the video"),
  summary: z.string().describe("One or two sentences: what the video says and who it is for"),
  format: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      fps: z.number().int().positive(),
    })
    .describe("Canvas, e.g. 1920x1080@30 for landscape, 1080x1920@30 for vertical"),
  targetDurationSec: z.number().positive(),
  style: z
    .string()
    .describe("Visual direction: palette (hex colours), fonts or text preset ids, pacing, overall look"),
  voiceover: z
    .enum(["none", "local", "cloud"])
    .describe("none, local (Drift's on-device Chatterbox TTS, free) or cloud (ElevenLabs/Fish, billable)"),
  music: z.string().optional().describe("Music idea and how it should sit under the voice, or empty"),
  scenes: z.array(z.object(sceneShape)).min(1),
  notes: z.string().optional().describe("Anything the user should decide or know before the build"),
};

export const storyboardSchema = z.object(storyboardShape);
export type Storyboard = z.infer<typeof storyboardSchema>;
export type Scene = Storyboard["scenes"][number];

export function totalDuration(sb: Storyboard): number {
  return sb.scenes.reduce((sum, s) => sum + s.durationSec, 0);
}

export function renderStoryboard(sb: Storyboard): string {
  const lines: string[] = [];
  lines.push(bold(sb.title));
  lines.push(sb.summary);
  lines.push(
    dim(
      `${sb.format.width}x${sb.format.height}@${sb.format.fps} · target ${sb.targetDurationSec}s · ` +
        `planned ${totalDuration(sb).toFixed(1)}s · voiceover: ${sb.voiceover}` +
        (sb.music ? ` · music: ${sb.music}` : ""),
    ),
  );
  lines.push(dim(`style: ${sb.style}`));
  lines.push("");
  let t = 0;
  for (const s of sb.scenes) {
    lines.push(bold(`[${s.id}] ${fmtTime(t)}–${fmtTime(t + s.durationSec)}  ${s.title}`));
    if (s.narration) lines.push(`  🎙 ${s.narration}`);
    for (const text of s.onScreenText) lines.push(`  ▭ ${text}`);
    lines.push(dim(`  👁 ${s.visuals}`));
    if (s.sourceRefs?.length) lines.push(dim(`  ↳ ${s.sourceRefs.join(", ")}`));
    if (s.transition) lines.push(dim(`  ⇢ ${s.transition}`));
    t += s.durationSec;
  }
  if (sb.notes) {
    lines.push("");
    lines.push(`Notes: ${sb.notes}`);
  }
  return lines.join("\n");
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}

// Parse a storyboard the user edited by hand. Returns a readable error instead of throwing so the
// reviewer can show it and let them fix the file.
export function parseStoryboard(text: string): { ok: true; value: Storyboard } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: `Not valid JSON: ${(err as Error).message}` };
  }
  const parsed = storyboardSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n"),
    };
  }
  return { ok: true, value: parsed.data };
}
