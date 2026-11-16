import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { summarizeInput, slug } from "../src/run.js";
import { bundledSkillsDir, listSkills, parseSkill } from "../src/skills.js";
import { resolveSource } from "../src/sources.js";
import { parseStoryboard, totalDuration } from "../src/storyboard.js";

test("skill frontmatter: scalars, inline lists, block lists, quotes", () => {
  const s = parseSkill(
    `---\nname: demo\ndescription: "A demo: with colon"\nsources:\n  - repo\n  - video\n  - bogus\neffort: low # trailing comment\n---\n\n# Body\nDo things.\n`,
    "/x",
  );
  assert.ok(s);
  assert.equal(s.name, "demo");
  assert.equal(s.description, "A demo: with colon");
  assert.deepEqual(s.sources, ["repo", "video"]);
  assert.equal(s.effort, "low");
  assert.equal(s.body, "# Body\nDo things.");
});

test("skill without frontmatter or name is ignored", () => {
  assert.equal(parseSkill("# just markdown", "/x"), undefined);
  assert.equal(parseSkill("---\ndescription: no name\n---\nbody", "/x"), undefined);
});

test("bundled skills all parse", () => {
  const names = listSkills()
    .filter((s) => s.dir.startsWith(bundledSkillsDir))
    .map((s) => s.name);
  assert.deepEqual(names.sort(), ["doc-explainer", "footage-highlight-reel", "repo-walkthrough"]);
});

const validStoryboard = {
  title: "T",
  summary: "S",
  format: { width: 1920, height: 1080, fps: 30 },
  targetDurationSec: 20,
  style: "dark",
  voiceover: "local",
  scenes: [
    { id: "s1", title: "Hook", durationSec: 5, narration: "Hi.", onScreenText: ["Hi"], visuals: "title" },
    { id: "s2", title: "End", durationSec: 7.5, narration: "", onScreenText: [], visuals: "logo" },
  ],
};

test("storyboard: valid JSON parses and durations add up", () => {
  const r = parseStoryboard(JSON.stringify(validStoryboard));
  assert.ok(r.ok);
  assert.equal(totalDuration(r.value), 12.5);
});

test("storyboard: hand-edit mistakes come back as readable errors", () => {
  const bad = parseStoryboard(JSON.stringify({ ...validStoryboard, voiceover: "robot", scenes: [] }));
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /voiceover/);
  assert.match((bad as { error: string }).error, /scenes/);
  const broken = parseStoryboard("{ not json");
  assert.equal(broken.ok, false);
  assert.match((broken as { error: string }).error, /Not valid JSON/);
});

test("sources: file kinds, folders and URLs", () => {
  const dir = mkdtempSync(join(tmpdir(), "drift-agent-"));
  writeFileSync(join(dir, "talk.MP4"), "");
  writeFileSync(join(dir, "spec.pdf"), "");
  mkdirSync(join(dir, "repo"));
  const noop = () => {};
  assert.equal(resolveSource(join(dir, "talk.MP4"), dir, noop).kind, "video");
  const doc = resolveSource(join(dir, "spec.pdf"), dir, noop);
  assert.equal(doc.kind, "document");
  assert.equal(doc.root, dir);
  assert.equal(resolveSource(join(dir, "repo"), dir, noop).kind, "repo");
  assert.equal(resolveSource("https://example.com/post", dir, noop).kind, "url");
  assert.throws(() => resolveSource(join(dir, "missing.txt"), dir, noop), /not found/);
});

test("tool summaries are short and useful", () => {
  assert.equal(
    summarizeInput("mcp__drift__apply", { ops: [{ tool: "add_text" }, { tool: "set_duration" }] }),
    "[add_text, set_duration]",
  );
  assert.equal(summarizeInput("Read", { file_path: "/a/b.md" }), "/a/b.md");
  assert.equal(slug("Drift: A Repo Tour!"), "drift-a-repo-tour");
});
