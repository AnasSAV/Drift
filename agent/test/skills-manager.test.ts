import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Point the agent's home at a temp folder before the modules read it.
const home = mkdtempSync(join(tmpdir(), "drift-agent-home-"));
process.env.DRIFT_AGENT_HOME = home;
const { createSkill, customizeSkill, isEnabled, removeSkill, setEnabled } = await import("../src/skillManager.js");
const { findSkill, listSkills, skillProblems } = await import("../src/skills.js");
const { estimateCost, addUsage, zeroTokens, priceFor } = await import("../src/pricing.js");

test("new skill: from the template, parsed, listed as the user's", () => {
  const s = createSkill("product-demo", "A demo of a product.", ["url", "repo"]);
  assert.equal(s.origin, "user");
  assert.deepEqual(s.sources, ["url", "repo"]);
  assert.match(readFileSync(s.file, "utf8"), /^---\nname: product-demo\n/);
  assert.equal(findSkill("product-demo")?.description, "A demo of a product.");
});

test("new skill: bad or taken names are refused", () => {
  assert.throws(() => createSkill("Bad Name", "", []), /lowercase/);
  assert.throws(() => createSkill("doc-explainer", "", []), /already exists/);
});

test("customize: copies a built-in skill, which the copy then replaces", () => {
  assert.equal(findSkill("repo-walkthrough")?.origin, "bundled");
  const s = customizeSkill("repo-walkthrough");
  assert.equal(s.origin, "user");
  assert.equal(s.overridesBundled, true);
  // Reference files come along.
  assert.ok(existsSync(join(s.dir, "references", "svg-templates.md")));
  assert.equal(listSkills().filter((x) => x.name === "repo-walkthrough").length, 1);
});

test("remove: goes to .trash and the built-in comes back", () => {
  const r = removeSkill("repo-walkthrough");
  assert.ok(existsSync(r.trashedTo));
  assert.equal(r.restored?.origin, "bundled");
  assert.throws(() => removeSkill("doc-explainer"), /only be disabled/);
});

test("enable/disable is remembered in the config", () => {
  assert.equal(isEnabled("doc-explainer"), true);
  setEnabled("doc-explainer", false);
  assert.equal(isEnabled("doc-explainer"), false);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).disabledSkills, ["doc-explainer"]);
  setEnabled("doc-explainer", true);
  assert.equal(isEnabled("doc-explainer"), true);
  assert.throws(() => setEnabled("nope", false), /No skill/);
});

test("broken skill folders are reported, not silently dropped", () => {
  mkdirSync(join(home, "skills", "half-done"), { recursive: true });
  writeFileSync(join(home, "skills", "half-done", "SKILL.md"), "# no frontmatter");
  mkdirSync(join(home, "skills", "empty"), { recursive: true });
  const problems = skillProblems().map((p) => p.problem);
  assert.ok(problems.some((p) => /must start with ---/.test(p)));
  assert.ok(problems.some((p) => /no SKILL.md/.test(p)));
  // The trash folder is not a skill and not a problem.
  assert.ok(!skillProblems().some((p) => p.dir.includes(".trash")));
});

test("live cost estimate: longest model prefix wins; unknown models give no figure", () => {
  assert.equal(priceFor("claude-opus-5-5")?.input, 4);
  assert.equal(priceFor("claude-opus-5")?.input, 5);
  const t = addUsage(zeroTokens(), { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 1_000_000 });
  // 1M in × $4 + 0.1M out × $20 + 1M cache reads × $0.20
  assert.equal(estimateCost("claude-opus-5-5", t)?.toFixed(2), "6.20");
  assert.equal(estimateCost("some-other-model", t), undefined);
});
