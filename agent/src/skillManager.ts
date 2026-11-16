// Creating, customising, enabling and removing skills. Only the user's own folder
// (~/.drift-agent/skills) is ever written: a bundled skill is customised by copying it there,
// where it takes priority over the original, and "removing" moves a folder into .trash rather
// than deleting it.

import { cpSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig } from "./config.js";
import { findSkill, listSkills, userSkillsDir, type SkillEntry, type SourceKind } from "./skills.js";

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,47}$/;

export function isEnabled(name: string): boolean {
  return !(loadConfig().disabledSkills ?? []).includes(name);
}

export function setEnabled(name: string, enabled: boolean): void {
  if (!findSkill(name)) throw new Error(`No skill named "${name}".`);
  const disabled = new Set(loadConfig().disabledSkills ?? []);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  saveConfig({ disabledSkills: [...disabled].sort() });
}

function template(name: string, description: string, sources: SourceKind[]): string {
  const title = name.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return `---
name: ${name}
description: ${description.replace(/\r?\n/g, " ").trim() || "What this skill makes, in one sentence."}
${sources.length ? `sources: [${sources.join(", ")}]\n` : ""}---

# ${title}

What the finished video should do for the viewer, in a sentence or two.

## Defaults (the user's note overrides any of these)
- Length and format, e.g. 45-60 seconds, 1920x1080 at 30 fps.
- Voiceover: local (free, on this machine), none, or cloud.
- Music, if any.

## Reading the source
- What to read first, what to skim, what matters.
- What to record for each scene's sourceRefs.

## Story shape
1. **Hook** (3-5 s): ...
2. ...
3. **Close**: ...

## Look
- Palette (hex colours), text presets, how things move, transitions.
- Point to reference files in this folder if you add any, e.g. \`references/style.md\`.

## Building notes
- Anything specific about building this kind of video in Drift.
`;
}

export function createSkill(name: string, description: string, sources: SourceKind[]): SkillEntry {
  if (!SKILL_NAME.test(name)) {
    throw new Error("Skill names use lowercase letters, digits and dashes (2-48 characters), e.g. product-demo.");
  }
  if (findSkill(name)) throw new Error(`A skill named "${name}" already exists. Customize it instead.`);
  const dir = join(userSkillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), template(name, description, sources));
  return findSkill(name)!;
}

// Copies a skill (usually a bundled one) into the user's folder under the same name, so the copy
// is what runs from now on and can be edited freely.
export function customizeSkill(name: string): SkillEntry {
  const skill = findSkill(name);
  if (!skill) throw new Error(`No skill named "${name}".`);
  if (skill.origin === "user") return skill;
  const dest = join(userSkillsDir, name);
  if (existsSync(dest)) throw new Error(`${dest} already exists but doesn't hold a valid skill; fix or move it first.`);
  mkdirSync(userSkillsDir, { recursive: true });
  cpSync(skill.dir, dest, { recursive: true });
  return findSkill(name)!;
}

// Moves the user's copy into ~/.drift-agent/skills/.trash/<name>-<time>. A bundled skill of the
// same name, if any, takes over again.
export function removeSkill(name: string): { trashedTo: string; restored?: SkillEntry } {
  const skill = listSkills().find((s) => s.name === name && s.origin === "user");
  if (!skill) throw new Error(`"${name}" isn't one of your skills; built-in skills can only be disabled.`);
  const trash = join(userSkillsDir, ".trash");
  mkdirSync(trash, { recursive: true });
  const dest = join(trash, `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  renameSync(skill.dir, dest);
  return { trashedTo: dest, restored: findSkill(name) };
}
