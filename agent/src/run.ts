// One run: plan → review (→ revise …) → build, as a single resumable Claude session.
//
// The plan and build phases are separate query() calls on the same session (resume), so Claude
// keeps everything it read while planning, and the user's review happens between them with no
// model running and nothing billed.

import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createSdkMcpServer,
  query,
  tool,
  type EffortLevel,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { DriftInstance } from "./drift.js";
import type { AgentEvent, Phase, Reporter } from "./events.js";
import { DRIFT, makeCanUseTool, RESEARCH_OPS, STUDIO, SUBMIT_TOOL, type PolicyState } from "./policy.js";
import { addUsage, estimateCost, totalTokens, zeroTokens, type Usage } from "./pricing.js";
import { buildPrompt, changePrompt, planPrompt, revisePrompt, systemPrompt } from "./prompts.js";
import type { Skill } from "./skills.js";
import type { Source } from "./sources.js";
import { storyboardShape, type Storyboard } from "./storyboard.js";

export type Review =
  | { action: "approve"; storyboard: Storyboard }
  | { action: "revise"; note: string }
  | { action: "cancel" };

export type FollowUp = { action: "change"; note: string } | { action: "finish" };

export interface Reviewer {
  review(storyboard: Storyboard, file: string): Promise<Review>;
  // After the build: more changes to make on the timeline, or done. Without it the run ends
  // after the first build.
  followUp?(): Promise<FollowUp>;
}

// The model and effort for the next turn. Reviewers (the terminal's [m], the panel's set_model)
// change it between turns, e.g. plan on a fast model and build on a stronger one.
export class RunControl {
  constructor(
    public model: string,
    public effort: EffortLevel,
  ) {}
}

export interface RunOptions {
  skill: Skill;
  source: Source;
  note?: string;
  control: RunControl;
  budgetUsd?: number;
  drift: DriftInstance;
  runDir: string;
  reporter: Reporter;
  reviewer: Reviewer;
  abort: AbortController;
}

export interface RunResult {
  ok: boolean;
  phase: Phase;
  costUsd: number;
  projectPath?: string;
  storyboardFile?: string;
  report?: string;
}

const MAX_REVISIONS = 10;

export async function runSkill(opts: RunOptions): Promise<RunResult> {
  const { skill, source, runDir, abort } = opts;
  const logFile = join(runDir, "events.jsonl");
  const emit = (e: AgentEvent) => {
    opts.reporter.emit(e);
    appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...e }) + "\n");
  };

  const readRoots = [source.root, skill.dir].filter((p): p is string => !!p);
  const state: PolicyState = {
    phase: "plan",
    readRoots,
    onDenied: (name, reason) => emit({ type: "denied", phase: state.phase, name, reason }),
  };

  // submit_storyboard only records what Claude proposed; the review happens after the turn ends.
  let submitted: Storyboard | undefined;
  const studio = createSdkMcpServer({
    name: STUDIO,
    version: "0.1.0",
    alwaysLoad: true,
    tools: [
      tool(
        "submit_storyboard",
        "Propose the storyboard for this video. The user reviews, edits or approves it before anything " +
          "is built. Call it once per plan (again after a revision request), then end your turn.",
        storyboardShape,
        async (args) => {
          submitted = args as Storyboard;
          return {
            content: [
              {
                type: "text",
                text: "Storyboard received and shown to the user. End your turn now with one short line; do not build.",
              },
            ],
          };
        },
      ),
    ],
  });

  // model and effort are filled in per turn from opts.control.
  const options: Options = {
    systemPrompt: systemPrompt(skill, []),
    // Built-ins are read-only; no shell, no writes, no subagents.
    tools: ["Read", "Glob", "Grep", "WebFetch"],
    // Deliberately empty: every call goes through the policy callback (see policy.ts).
    allowedTools: [],
    canUseTool: makeCanUseTool(state),
    permissionMode: "default",
    // Ignore the user's own Claude Code settings, CLAUDE.md files and MCP servers: a run sees
    // only what this file configures.
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {
      [DRIFT]: {
        type: "http",
        url: opts.drift.url,
        headers: { Authorization: `Bearer ${opts.drift.token}` },
        alwaysLoad: true,
        // Transcription, TTS and contact sheets can take a while on a slow machine.
        timeout: 10 * 60_000,
      },
      [STUDIO]: studio,
    },
    cwd: source.root ?? runDir,
    additionalDirectories: [skill.dir],
    maxBudgetUsd: opts.budgetUsd,
    abortController: abort,
    env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "drift-agent/0.1.0" },
    stderr: (data) => appendFileSync(join(runDir, "claude-stderr.log"), data),
  };

  let sessionId: string | undefined;
  let totalCost = 0;
  let announced = false;
  let lastModel = "";
  // Tokens of finished turns; their cost is the exact figure in totalCost.
  let doneTokens = zeroTokens();
  let lastUsageKey = "";

  // Runs one turn and reports what happens in it. Returns the turn's final text, or undefined
  // when it failed (already reported).
  async function turn(prompt: string): Promise<string | undefined> {
    const toolNames = new Map<string, string>();
    // Usage per API message: the SDK delivers one frame per content block, each repeating its
    // message's usage, so keep the latest per message id rather than adding every frame.
    const usageById = new Map<string, Usage>();
    const turnTokens = () => [...usageById.values()].reduce(addUsage, zeroTokens());
    const reportUsage = (exactTurnCost?: number) => {
      const t = turnTokens();
      const all = addUsage(doneTokens, {
        input_tokens: t.input,
        output_tokens: t.output,
        cache_read_input_tokens: t.cacheRead,
        cache_creation_input_tokens: t.cacheWrite,
      });
      const estimate = exactTurnCost ?? estimateCost(model, t);
      const costUsd = estimate === undefined ? null : totalCost + estimate;
      const key = `${totalTokens(all)}/${costUsd?.toFixed(4)}`;
      if (key === lastUsageKey) return;
      lastUsageKey = key;
      emit({
        type: "usage",
        phase: state.phase,
        tokens: totalTokens(all),
        outputTokens: all.output,
        costUsd,
        estimated: exactTurnCost === undefined,
      });
    };
    const { model, effort } = opts.control;
    if (`${model}/${effort}` !== lastModel) {
      lastModel = `${model}/${effort}`;
      emit({ type: "model", phase: state.phase, model, effort });
    }
    const q = query({ prompt, options: { ...options, model, effort, resume: sessionId } });
    let final: string | undefined;
    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type === "system" && msg.subtype === "init") {
          sessionId = msg.session_id;
          if (!announced) {
            announced = true;
            emit({
              type: "session",
              sessionId: msg.session_id,
              model: msg.model,
              apiKeySource: msg.apiKeySource,
              tools: msg.tools,
              mcp: msg.mcp_servers.map((m) => ({ name: m.name, status: m.status })),
            });
            const drift = msg.mcp_servers.find((m) => m.name === DRIFT);
            if (drift && drift.status !== "connected") {
              emit({ type: "error", phase: state.phase, message: `Drift MCP server is ${drift.status}.` });
            }
          }
        } else if (msg.type === "assistant") {
          if (msg.parent_tool_use_id) continue;
          if (msg.message.id && msg.message.usage) {
            usageById.set(msg.message.id, msg.message.usage as Usage);
            reportUsage();
          }
          for (const block of msg.message.content) {
            if (block.type === "text") emit({ type: "text", phase: state.phase, text: block.text });
            else if (block.type === "tool_use") {
              toolNames.set(block.id, block.name);
              emit({
                type: "tool",
                phase: state.phase,
                id: block.id,
                name: shortName(block.name),
                summary: summarizeInput(block.name, block.input as Record<string, unknown>),
              });
            }
          }
        } else if (msg.type === "user") {
          const content = msg.message.content;
          if (!Array.isArray(content)) continue;
          for (const block of content) {
            if (block.type !== "tool_result") continue;
            const ok = !block.is_error && !resultSaysFailed(block.content);
            emit({
              type: "tool_result",
              phase: state.phase,
              id: block.tool_use_id,
              ok,
              summary: `${shortName(toolNames.get(block.tool_use_id) ?? "tool")}: ${resultText(block.content).slice(0, 300)}`,
            });
          }
        } else if (msg.type === "result") {
          sessionId = msg.session_id;
          // From here on this turn is priced exactly.
          const t = turnTokens();
          lastUsageKey = "";
          reportUsage(msg.total_cost_usd);
          doneTokens = addUsage(doneTokens, {
            input_tokens: t.input,
            output_tokens: t.output,
            cache_read_input_tokens: t.cacheRead,
            cache_creation_input_tokens: t.cacheWrite,
          });
          totalCost += msg.total_cost_usd;
          if (msg.subtype === "success" && !msg.is_error) {
            final = msg.result;
            emit({ type: "done", phase: state.phase, costUsd: msg.total_cost_usd, turns: msg.num_turns, result: msg.result });
          } else {
            const why =
              msg.subtype === "success"
                ? msg.result
                : msg.subtype === "error_max_budget_usd"
                  ? `Budget of $${opts.budgetUsd} reached. Raise it with --budget.`
                  : `${msg.subtype}${msg.errors.length ? `: ${msg.errors.join("; ")}` : ""}`;
            emit({ type: "error", phase: state.phase, message: why });
          }
        }
      }
    } catch (err) {
      if (abort.signal.aborted) emit({ type: "error", phase: state.phase, message: "Cancelled." });
      else emit({ type: "error", phase: state.phase, message: (err as Error).message });
      return undefined;
    }
    return final;
  }

  // --- plan ------------------------------------------------------------------------------------
  emit({ type: "status", phase: "plan", message: `Planning with skill "${skill.name}"…` });
  let reply = await turn(planPrompt(source, opts.note, RESEARCH_OPS));
  if (reply === undefined) return { ok: false, phase: "plan", costUsd: totalCost };
  if (!submitted) {
    // Occasionally the model answers in prose instead of calling the tool; one nudge fixes it.
    reply = await turn("Call submit_storyboard now with the full storyboard.");
    if (reply === undefined || !submitted) {
      emit({ type: "error", phase: "plan", message: "Claude finished without proposing a storyboard." });
      return { ok: false, phase: "plan", costUsd: totalCost };
    }
  }

  // --- review ----------------------------------------------------------------------------------
  const storyboardFile = join(runDir, "storyboard.json");
  let approved: Storyboard | undefined;
  let edited = false;
  for (let round = 0; round <= MAX_REVISIONS && !approved; round++) {
    const proposal: Storyboard = submitted!;
    writeFileSync(storyboardFile, JSON.stringify(proposal, null, 2));
    emit({ type: "storyboard", storyboard: proposal, file: storyboardFile });
    const review = await opts.reviewer.review(proposal, storyboardFile);
    if (review.action === "cancel") {
      emit({ type: "status", phase: "plan", message: "Cancelled before building. Nothing was added to the timeline." });
      return { ok: false, phase: "plan", costUsd: totalCost, storyboardFile };
    }
    if (review.action === "approve") {
      approved = review.storyboard;
      edited = JSON.stringify(approved) !== JSON.stringify(proposal);
      break;
    }
    submitted = undefined;
    emit({ type: "status", phase: "plan", message: "Revising the storyboard…" });
    if ((await turn(revisePrompt(review.note))) === undefined) return { ok: false, phase: "plan", costUsd: totalCost, storyboardFile };
    if (!submitted) {
      emit({ type: "error", phase: "plan", message: "Claude did not submit a revised storyboard." });
      return { ok: false, phase: "plan", costUsd: totalCost, storyboardFile };
    }
  }
  if (!approved) return { ok: false, phase: "plan", costUsd: totalCost, storyboardFile };
  writeFileSync(storyboardFile, JSON.stringify(approved, null, 2));

  // --- build -----------------------------------------------------------------------------------
  state.phase = "build";
  state.storyboard = approved;
  const projectPath = join(runDir, `${slug(approved.title) || "video"}.drift`);
  emit({ type: "status", phase: "build", message: `Building "${approved.title}" in Drift…` });
  let report = await turn(buildPrompt(approved, edited, projectPath));

  // --- changes after the build -----------------------------------------------------------------
  // The session stays open: Claude still knows the source and the storyboard, so "make the
  // title bigger" or "swap scenes 2 and 3" is one more turn, not a new run.
  if (report !== undefined && opts.reviewer.followUp) {
    for (;;) {
      emit({ type: "ready_for_changes", projectPath });
      const next = await opts.reviewer.followUp();
      if (next.action === "finish" || abort.signal.aborted) break;
      emit({ type: "status", phase: "build", message: "Making your changes…" });
      const reply = await turn(changePrompt(next.note, projectPath));
      if (reply !== undefined) report = reply;
      if (abort.signal.aborted) break;
    }
  }

  return {
    ok: report !== undefined,
    phase: "build",
    costUsd: totalCost,
    projectPath,
    storyboardFile,
    report,
  };
}

// --- helpers -----------------------------------------------------------------------------------

export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function shortName(name: string): string {
  return name.replace(/^mcp__drift__/, "drift.").replace(/^mcp__studio__/, "");
}

export function summarizeInput(name: string, input: Record<string, unknown>): string {
  if (name === `mcp__${DRIFT}__apply` && Array.isArray(input.ops)) {
    const ops = input.ops as { tool?: string }[];
    return `[${ops.map((o) => o.tool).join(", ")}]`;
  }
  if (name === SUBMIT_TOOL) {
    const scenes = Array.isArray(input.scenes) ? input.scenes.length : 0;
    return `"${String(input.title ?? "")}" (${scenes} scenes)`;
  }
  const file = input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.q ?? input.name;
  if (typeof file === "string") return file;
  const json = JSON.stringify(input);
  return json.length > 120 ? json.slice(0, 117) + "…" : json;
}

type ResultContent = string | { type: string; text?: string }[] | undefined;

function resultText(content: ResultContent): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`))
    .join(" ");
}

// Drift reports op failures as {ok:false, error, detail} inside a successful MCP result.
function resultSaysFailed(content: ResultContent): boolean {
  return /"ok"\s*:\s*false/.test(resultText(content).slice(0, 200));
}
