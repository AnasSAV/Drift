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
export const userSkillsDir = join(homedir(), ".drift-agent", "skills");

export function skillRoots(): string[] {
  const extra = (process.env.DRIFT_AGENT_SKILLS ?? "").split(delimiter).filter(Boolean);
  // Earlier roots win on a name clash, so a user's copy overrides the bundled one.
  return [...extra, userSkillsDir, bundledSkillsDir];
}

export function listSkills(): Skill[] {
  const seen = new Map<string, Skill>();
  for (const root of skillRoots()) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry);
      const file = join(dir, "SKILL.md");
      if (!statSync(dir).isDirectory() || !existsSync(file)) continue;
      const skill = parseSkill(readFileSync(file, "utf8"), dir);
      if (skill && !seen.has(skill.name)) seen.set(skill.name, skill);
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findSkill(name: string): Skill | undefined {
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
