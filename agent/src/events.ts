// Everything a run reports goes through one Reporter, so the same run can print to a terminal
// now and speak JSON lines to the Drift UI later (phase 2) without the run knowing which.

import type { Storyboard } from "./storyboard.js";

export type Phase = "setup" | "plan" | "build";

export type AgentEvent =
  | { type: "status"; phase: Phase; message: string }
  | {
      type: "session";
      sessionId: string;
      model: string;
      apiKeySource: string;
      tools: string[];
      mcp: { name: string; status: string }[];
    }
  | { type: "model"; phase: Phase; model: string; effort: string }
  | { type: "text"; phase: Phase; text: string }
  | { type: "tool"; phase: Phase; id: string; name: string; summary: string }
  | { type: "tool_result"; phase: Phase; id: string; ok: boolean; summary: string }
  | { type: "denied"; phase: Phase; name: string; reason: string }
  | { type: "storyboard"; storyboard: Storyboard; file: string }
  | { type: "done"; phase: Phase; costUsd: number; turns: number; result: string }
  | { type: "error"; phase: Phase; message: string };

export interface Reporter {
  emit(event: AgentEvent): void;
}

// --- terminal --------------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = paint("2");
export const bold = paint("1");
export const cyan = paint("36");
export const green = paint("32");
export const yellow = paint("33");
export const red = paint("31");

export class TerminalReporter implements Reporter {
  // Running cost across phases; each phase's result reports only its own query.
  private totalCost = 0;

  emit(e: AgentEvent): void {
    switch (e.type) {
      case "status":
        console.log(cyan(`▸ ${e.message}`));
        break;
      case "session":
        console.log(
          dim(
            `  session ${e.sessionId.slice(0, 8)} · ${e.model} · auth: ${e.apiKeySource} · mcp: ` +
              e.mcp.map((m) => `${m.name}=${m.status}`).join(", "),
          ),
        );
        break;
      case "model":
        console.log(dim(`  model: ${e.model} · effort: ${e.effort}`));
        break;
      case "text":
        if (e.text.trim()) console.log(`\n${e.text.trim()}\n`);
        break;
      case "tool":
        console.log(dim(`  → ${e.name} ${e.summary}`));
        break;
      case "tool_result":
        if (!e.ok) console.log(yellow(`  ✗ ${e.summary}`));
        break;
      case "denied":
        console.log(yellow(`  ⊘ ${e.name}: ${e.reason}`));
        break;
      case "storyboard":
        // The reviewer prints the storyboard itself, with the approval prompt.
        break;
      case "done":
        this.totalCost += e.costUsd;
        console.log(
          green(`✔ ${e.phase} finished`) +
            dim(` · ${e.turns} turns · $${e.costUsd.toFixed(2)} (run total $${this.totalCost.toFixed(2)})`),
        );
        break;
      case "error":
        console.error(red(`✖ ${e.message}`));
        break;
    }
  }
}

// --- JSON lines (for the Drift panel) --------------------------------------------------------

export class JsonReporter implements Reporter {
  emit(e: AgentEvent): void {
    process.stdout.write(JSON.stringify(e) + "\n");
  }
}
