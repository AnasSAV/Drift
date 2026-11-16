// Small terminal pickers shared by the guided mode, `drift-agent model` and the storyboard review.

import type { Interface } from "node:readline";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { matchModel, type Model } from "./claude.js";
import { EFFORTS } from "./config.js";
import { bold, cyan, dim, yellow } from "./events.js";

export function ask(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

// How many of the account's models to show before "more". The account lists its current
// models first.
const HEADLINE = 5;

// Returns the chosen model id, or `current` when the user just presses Enter.
export async function pickModel(rl: Interface, models: Model[], current: string): Promise<string> {
  let showAll = false;
  for (;;) {
    const shown = showAll ? models : models.slice(0, HEADLINE);
    console.log(bold("\nModel"));
    shown.forEach((m, i) => {
      const mark = m.id === current ? cyan("●") : " ";
      console.log(` ${mark} ${bold(String(i + 1).padStart(2))}  ${m.name.padEnd(12)} ${dim(`${m.id} · ${m.description}`)}`);
    });
    if (!models.some((m) => m.id === current)) console.log(dim(`    current: ${current}`));
    const more = !showAll && models.length > HEADLINE ? `, ${bold("m")} for ${models.length - HEADLINE} more` : "";
    const answer = (await ask(rl, `Number or model id (Enter keeps ${current}${more}) › `)).trim();
    if (!answer) return current;
    if (answer.toLowerCase() === "m" && !showAll) {
      showAll = true;
      continue;
    }
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= shown.length) return shown[n - 1].id;
    const match = matchModel(answer, models);
    if (match) return match.id;
    // Not in the account's list: allow it anyway (a model released after this list was read),
    // but say so.
    if (/^claude-[a-z0-9-]+$/.test(answer)) {
      console.log(yellow(`${answer} isn't in your account's list; using it anyway.`));
      return answer;
    }
    console.log(yellow(`No model matches "${answer}".`));
  }
}

export async function pickEffort(rl: Interface, model: Model | undefined, current: EffortLevel): Promise<EffortLevel> {
  const levels = model?.efforts.length ? model.efforts : EFFORTS;
  const fallback = levels.includes(current) ? current : levels.includes("high") ? "high" : levels[levels.length - 1];
  const hint = dim("  low/medium: faster and cheaper · high: recommended · xhigh/max: most thorough");
  console.log(bold("\nEffort") + hint);
  for (;;) {
    const answer = (await ask(rl, `${levels.join(" / ")} (Enter keeps ${fallback}) › `)).trim().toLowerCase();
    if (!answer) return fallback;
    if (levels.includes(answer as EffortLevel)) return answer as EffortLevel;
    console.log(yellow(`Pick one of: ${levels.join(", ")}.`));
  }
}
