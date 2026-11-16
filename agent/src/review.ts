// Storyboard review. In the terminal the user approves, edits the JSON in their editor, asks for
// a revision in plain words, or switches the model for the rest of the run. In --json mode (the
// Drift panel, phase 2) the same answers arrive as JSON lines on stdin.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Interface } from "node:readline";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import type { Model } from "./claude.js";
import { EFFORTS } from "./config.js";
import { bold, dim, green, red } from "./events.js";
import { ask, pickEffort, pickModel } from "./pick.js";
import type { FollowUp, Review, Reviewer, RunControl } from "./run.js";
import { parseStoryboard, renderStoryboard, type Storyboard } from "./storyboard.js";

export class TerminalReviewer implements Reviewer {
  constructor(
    private readonly rl: Interface,
    private readonly control: RunControl,
    private readonly loadModels: () => Promise<Model[]>,
  ) {}

  async review(proposal: Storyboard, file: string): Promise<Review> {
    let current = proposal;
    let redraw = true;
    for (;;) {
      if (redraw) {
        console.log("\n" + "─".repeat(72));
        console.log(renderStoryboard(current));
        console.log("─".repeat(72));
        console.log(dim(`storyboard file: ${file}`));
      }
      redraw = true;
      console.log(dim(`build model: ${this.control.model} · effort: ${this.control.effort}`));
      const answer = (
        await ask(
          this.rl,
          `${bold("[a]")}pprove & build  ${bold("[e]")}dit  ${bold("[r]")}evise with a note  ${bold("[m]")}odel  ${bold("[q]")}uit  › `,
        )
      )
        .trim()
        .toLowerCase();

      if (answer === "a" || answer === "approve") return { action: "approve", storyboard: current };
      if (answer === "q" || answer === "quit") return { action: "cancel" };
      if (answer === "r" || answer === "revise") {
        const note = (await ask(this.rl, "What should change? › ")).trim();
        if (note) return { action: "revise", note };
        continue;
      }
      if (answer === "m" || answer === "model") {
        const models = await this.loadModels();
        this.control.model = await pickModel(this.rl, models, this.control.model);
        this.control.effort = await pickEffort(
          this.rl,
          models.find((m) => m.id === this.control.model),
          this.control.effort,
        );
        console.log(green(`The rest of this run uses ${this.control.model} at ${this.control.effort} effort.`));
        redraw = false;
        continue;
      }
      if (answer === "e" || answer === "edit") {
        openEditor(file);
        const parsed = parseStoryboard(readFileSync(file, "utf8"));
        if (parsed.ok) current = parsed.value;
        else console.log(red(`The edited file has problems; fix them and choose [e] again:\n${parsed.error}`));
      }
    }
  }

  async followUp(): Promise<FollowUp> {
    console.log(dim("\nThe video is on the timeline. Keep editing it in Drift, and ask Claude for changes here."));
    const note = (await ask(this.rl, `${bold("Changes?")} Describe them, or press Enter to finish › `)).trim();
    return note ? { action: "change", note } : { action: "finish" };
  }
}

// Blocks until the editor closes. $VISUAL / $EDITOR win; otherwise the platform's plain editor.
function openEditor(file: string): void {
  const configured = process.env.VISUAL || process.env.EDITOR;
  let cmd: string;
  let args: string[];
  if (configured) {
    // Allow "code --wait" style values.
    const parts = configured.split(" ").filter(Boolean);
    cmd = parts[0];
    args = [...parts.slice(1), file];
  } else if (process.platform === "win32") {
    cmd = "notepad.exe";
    args = [file];
  } else if (process.platform === "darwin") {
    cmd = "open";
    args = ["-W", "-t", file];
  } else {
    cmd = "nano";
    args = [file];
  }
  console.log(dim(`Opening ${cmd}… save and close it to continue.`));
  const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" && !!configured });
  if (res.error) console.log(red(`Could not start ${cmd}: ${res.error.message}. Edit ${file} yourself, then choose [e] again.`));
}

// --- JSON lines --------------------------------------------------------------------------------

type ModelFields = { model?: string; effort?: string };
type Command =
  | ({ type: "approve"; storyboard?: unknown } & ModelFields)
  | { type: "revise"; note: string }
  | { type: "change"; note: string }
  | { type: "finish" }
  | ({ type: "set_model" } & ModelFields)
  | { type: "cancel" };

export class JsonReviewer implements Reviewer {
  private queue: Command[] = [];
  private waiting?: (c: Command) => void;

  constructor(
    rl: Interface,
    private readonly control: RunControl,
    onCancel: () => void,
  ) {
    rl.on("line", (line) => {
      let cmd: Command;
      try {
        cmd = JSON.parse(line);
      } catch {
        return;
      }
      // set_model applies at once, whenever it arrives; it takes effect from the next turn.
      if (cmd.type === "set_model") {
        this.applyModel(cmd);
        return;
      }
      // A cancel aborts whatever is running, not just a pending review.
      if (cmd.type === "cancel" && !this.waiting) onCancel();
      if (this.waiting) {
        const w = this.waiting;
        this.waiting = undefined;
        w(cmd);
      } else this.queue.push(cmd);
    });
  }

  private applyModel(fields: ModelFields): void {
    if (fields.model) this.control.model = fields.model;
    if (fields.effort && EFFORTS.includes(fields.effort as EffortLevel)) this.control.effort = fields.effort as EffortLevel;
  }

  private next(): Promise<Command> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => (this.waiting = resolve));
  }

  async review(proposal: Storyboard): Promise<Review> {
    for (;;) {
      const cmd = await this.next();
      if (cmd.type === "cancel") return { action: "cancel" };
      if (cmd.type === "revise" && cmd.note) return { action: "revise", note: cmd.note };
      if (cmd.type === "approve") {
        this.applyModel(cmd);
        if (cmd.storyboard === undefined) return { action: "approve", storyboard: proposal };
        const parsed = parseStoryboard(JSON.stringify(cmd.storyboard));
        if (parsed.ok) return { action: "approve", storyboard: parsed.value };
        process.stdout.write(JSON.stringify({ type: "error", phase: "plan", message: parsed.error }) + "\n");
      }
    }
  }

  // After the build: {"type":"change","note":…} for another round, {"type":"finish"} (or
  // cancel) to end the run.
  async followUp(): Promise<FollowUp> {
    for (;;) {
      const cmd = await this.next();
      if (cmd.type === "finish" || cmd.type === "cancel") return { action: "finish" };
      if ((cmd.type === "change" || cmd.type === "revise") && cmd.note?.trim()) return { action: "change", note: cmd.note.trim() };
    }
  }
}
