// The user's remembered defaults, in ~/.drift-agent/config.json. Written by `drift-agent model`
// and by the guided mode; read by every run. A missing or unreadable file just means "no
// defaults yet".

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";

export const BUILTIN_MODEL = "claude-opus-5-5";
export const BUILTIN_EFFORT: EffortLevel = "high";
export const EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

export interface Config {
  model?: string;
  effort?: EffortLevel;
}

export const configFile = join(homedir(), ".drift-agent", "config.json");

export function loadConfig(): Config {
  try {
    const raw = JSON.parse(readFileSync(configFile, "utf8")) as Config;
    return {
      model: typeof raw.model === "string" ? raw.model : undefined,
      effort: EFFORTS.includes(raw.effort as EffortLevel) ? raw.effort : undefined,
    };
  } catch {
    return {};
  }
}

export function saveConfig(update: Config): Config {
  const next = { ...loadConfig(), ...update };
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export type ChoiceSource = "flag" | "skill" | "default" | "built-in";

// Which model and effort a run uses, and why. An explicit flag wins; then the skill's own
// recommendation; then the user's saved default; then the built-in default. The source is
// printed with every run so a skill's override is never a surprise.
export function chooseModel(
  flag: { model?: string; effort?: EffortLevel },
  skill: { model?: string; effort?: string },
  config: Config = loadConfig(),
): { model: string; modelFrom: ChoiceSource; effort: EffortLevel; effortFrom: ChoiceSource } {
  const skillEffort = EFFORTS.includes(skill.effort as EffortLevel) ? (skill.effort as EffortLevel) : undefined;
  const [model, modelFrom]: [string, ChoiceSource] = flag.model
    ? [flag.model, "flag"]
    : skill.model
      ? [skill.model, "skill"]
      : config.model
        ? [config.model, "default"]
        : [BUILTIN_MODEL, "built-in"];
  const [effort, effortFrom]: [EffortLevel, ChoiceSource] = flag.effort
    ? [flag.effort, "flag"]
    : skillEffort
      ? [skillEffort, "skill"]
      : config.effort
        ? [config.effort, "default"]
        : [BUILTIN_EFFORT, "built-in"];
  return { model, modelFrom, effort, effortFrom };
}
