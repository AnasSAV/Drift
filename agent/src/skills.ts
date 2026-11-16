// Skills are folders holding a SKILL.md (Anthropic's skill format: YAML frontmatter with name and
// description, then markdown instructions) plus any reference files or templates the skill wants
// Claude to read. The user picks one explicitly, so the chosen skill's body goes straight into the
// system prompt rather than relying on Claude to discover it; its folder is made readable so the
// body can point at bundled files ("read references/pacing.md").
//
// Drift-specific frontmatter fields, all optional:
//   sources: [document, repo, video, url]   what the skill expects to be pointed at
//   model:   claude-opus-5-5                 overrides --model
//   effort:  high                            overrides --effort

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SourceKind = "document" | "repo" | "video" | "url";

export interface Skill {
  name: string;
  description: string;
  sources: SourceKind[];
  model?: string;
  effort?: string;
  dir: string;
  body: string;
}

const here = dirname(fileURLToPath(import.meta.url));
// src/ when run through tsx, dist/ when built: the bundled skills sit beside either.
export const bundledSkillsDir = resolve(here, "..", "skills");
export const userSkillsDir = join(process.env.DRIFT_AGENT_HOME || join(homedir(), ".drift-agent"), "skills");

export function skillRoots(): string[] {
  const extra = (process.env.DRIFT_AGENT_SKILLS ?? "").split(delimiter).filter(Boolean);
  // Earlier roots win on a name clash, so a user's copy overrides the bundled one.
  return [...extra, userSkillsDir, bundledSkillsDir];
}

// Where a skill came from: shipped in agent/skills, the user's own folder, or a DRIFT_AGENT_SKILLS
// root.
export type SkillOrigin = "bundled" | "user" | "extra";

export interface SkillEntry extends Skill {
  origin: SkillOrigin;
  file: string;
  // A user or extra skill with the same name as a bundled one, which it hides.
  overridesBundled: boolean;
}

export interface SkillProblem {
  dir: string;
  problem: string;
}

function originOf(root: string): SkillOrigin {
  if (resolve(root) === resolve(userSkillsDir)) return "user";
  if (resolve(root) === resolve(bundledSkillsDir)) return "bundled";
  return "extra";
}

// Every skill folder in every root, in priority order, with what is wrong with the ones that
// don't parse. Folders starting with "." (the trash) are skipped.
function scan(): { entries: SkillEntry[]; problems: SkillProblem[] } {
  const entries: SkillEntry[] = [];
  const problems: SkillProblem[] = [];
  for (const root of skillRoots()) {
    if (!existsSync(root)) continue;
    for (const name of readdirSync(root)) {
      if (name.startsWith(".")) continue;
      const dir = join(root, name);
      const file = join(dir, "SKILL.md");
      try {
        if (!statSync(dir).isDirectory()) continue;
      } catch {
        continue;
      }
      if (!existsSync(file)) {
        problems.push({ dir, problem: "no SKILL.md in this folder" });
        continue;
      }
      const text = readFileSync(file, "utf8");
      const skill = parseSkill(text, dir);
      if (!skill) {
        problems.push({
          dir,
          problem: /^---\r?\n[\s\S]*?\r?\n---/.test(text)
            ? "the frontmatter has no name:"
            : "SKILL.md must start with --- frontmatter (name:, description:) ---",
        });
        continue;
      }
      entries.push({ ...skill, origin: originOf(root), file, overridesBundled: false });
    }
  }
  return { entries, problems };
}

export function listSkills(): SkillEntry[] {
  const { entries } = scan();
  const seen = new Map<string, SkillEntry>();
  for (const e of entries) {
    const first = seen.get(e.name);
    if (!first) seen.set(e.name, e);
    else if (e.origin === "bundled") first.overridesBundled = true;
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function skillProblems(): SkillProblem[] {
  return scan().problems;
}

export function findSkill(name: string): SkillEntry | undefined {
  return listSkills().find((s) => s.name === name);
}

export function parseSkill(text: string, dir: string): Skill | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return undefined;
  const meta = parseFrontmatter(match[1]);
  const name = typeof meta.name === "string" ? meta.name : undefined;
  if (!name) return undefined;
  const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []);
  return {
    name,
    description: typeof meta.description === "string" ? meta.description : "",
    sources: list(meta.sources).filter((s): s is SourceKind =>
      ["document", "repo", "video", "url"].includes(s),
    ),
    model: typeof meta.model === "string" ? meta.model : undefined,
    effort: typeof meta.effort === "string" ? meta.effort : undefined,
    dir,
    body: match[2].trim(),
  };
}

// Enough YAML for skill frontmatter: `key: value`, `key: [a, b]`, and `key:` followed by `- item`
// lines. Quotes around scalars are stripped. Anything fancier belongs in the body.
function parseFrontmatter(src: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const raw of src.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (out[listKey] as string[]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === "") {
      out[key] = [];
      listKey = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      out[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
      listKey = undefined;
    } else {
      out[key] = unquote(value);
      listKey = undefined;
    }
  }
  return out;
}

function unquote(s: string): string {
  return s.replace(/^(['"])(.*)\1$/, "$2");
}
