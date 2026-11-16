import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { decide, type PolicyState } from "../src/policy.js";
import type { Storyboard } from "../src/storyboard.js";

const root = resolve("fixtures-root");
const state = (over: Partial<PolicyState> = {}): PolicyState => ({
  phase: "plan",
  readRoots: [root],
  onDenied: () => {},
  ...over,
});
const apply = (...ops: [string, Record<string, unknown>?][]) => ({
  ops: ops.map(([tool, args]) => ({ tool, args: args ?? {} })),
});
const APPLY = "mcp__drift__apply";
const sb = (voiceover: Storyboard["voiceover"]) => ({ voiceover }) as Storyboard;

test("plan phase allows research ops", () => {
  const r = decide(state(), APPLY, apply(["import_media", { paths: ["/a.mp4"] }], ["transcribe", { clip: "x" }]));
  assert.equal(r.behavior, "allow");
});

test("plan phase refuses timeline edits", () => {
  const r = decide(state(), APPLY, apply(["list_text_presets"], ["add_text", { text: "hi" }]));
  assert.equal(r.behavior, "deny");
  assert.match((r as { message: string }).message, /add_text/);
});

test("build phase allows edits", () => {
  const r = decide(state({ phase: "build", storyboard: sb("local") }), APPLY, apply(["add_text"], ["add_svg"]));
  assert.equal(r.behavior, "allow");
});

test("project lifecycle and exports are blocked in every phase", () => {
  for (const tool of ["new_project", "load_project", "export_video", "install_addon", "set_theme"]) {
    assert.equal(decide(state({ phase: "build", storyboard: sb("local") }), APPLY, apply([tool])).behavior, "deny", tool);
  }
});

test("cloud TTS needs a storyboard that asked for cloud voice", () => {
  const build = (v: Storyboard["voiceover"]) => state({ phase: "build", storyboard: sb(v) });
  assert.equal(decide(build("local"), APPLY, apply(["tts_generate", { text: "a", provider: "local" }])).behavior, "allow");
  assert.equal(decide(build("local"), APPLY, apply(["tts_generate", { text: "a" }])).behavior, "deny");
  assert.equal(decide(build("cloud"), APPLY, apply(["tts_generate", { text: "a" }])).behavior, "allow");
  assert.equal(decide(build("none"), APPLY, apply(["sfx_generate", { prompt: "boom" }])).behavior, "deny");
});

test("billable transcription is refused while planning", () => {
  assert.equal(decide(state(), APPLY, apply(["transcribe", { clip: "x", engine: "elevenlabs" }])).behavior, "deny");
  assert.equal(decide(state(), APPLY, apply(["transcribe", { clip: "x", engine: "local" }])).behavior, "allow");
});

test("reads are confined to the allowed roots", () => {
  assert.equal(decide(state(), "Read", { file_path: join(root, "README.md") }).behavior, "allow");
  assert.equal(decide(state(), "Read", { file_path: join(root, "..", "secrets.txt") }).behavior, "deny");
  assert.equal(decide(state(), "Grep", { pattern: "x", path: resolve("/etc") }).behavior, "deny");
  // No path: searches the working folder, which is the source root.
  assert.equal(decide(state(), "Glob", { pattern: "**/*.ts" }).behavior, "allow");
});

test("drift read tools, storyboard submission and WebFetch are always allowed", () => {
  for (const t of ["mcp__drift__inspect", "mcp__drift__frames", "mcp__drift__toolbox", "mcp__studio__submit_storyboard", "WebFetch"]) {
    assert.equal(decide(state(), t, {}).behavior, "allow", t);
  }
});

test("unknown tools are refused", () => {
  assert.equal(decide(state(), "Bash", { command: "ls" }).behavior, "deny");
  assert.equal(decide(state(), "Write", { file_path: join(root, "x") }).behavior, "deny");
});
