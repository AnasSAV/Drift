#!/usr/bin/env node
// drift-agent: pick a skill, point it at a document, video, folder, repo or URL, approve a
// storyboard, and Claude builds the video on the open Drift timeline.
//
//   drift-agent                      guided mode: asks for everything
//   drift-agent run --skill repo-walkthrough --source D:/code/myrepo [--note "60s, vertical"]
//   drift-agent model                change the default model
//   drift-agent login                sign in to Claude

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { parseArgs } from "node:util";
import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { matchModel, probe, runAuth, type Model } from "./claude.js";
import { chooseModel, configFile, EFFORTS, loadConfig, saveConfig } from "./config.js";
import {
  connect,
  describeInstance,
  discoverInstances,
  driftProcessRunning,
  findDrift,
  launchDrift,
  waitForDrift,
  type DriftClient,
  type ProjectSummary,
} from "./drift.js";
import { bold, cyan, dim, green, JsonReporter, red, TerminalReporter, yellow, type Reporter } from "./events.js";
import { ask, pickEffort, pickModel } from "./pick.js";
import { JsonReviewer, TerminalReviewer } from "./review.js";
import { RunControl, runSkill, slug } from "./run.js";
import { findSkill, listSkills, skillRoots, type Skill } from "./skills.js";
import { resolveSource } from "./sources.js";
import { DRIFT } from "./policy.js";

const USAGE = `${bold("drift-agent")} — build a video in Drift from a document, video, folder, repo or URL

${bold("Usage")}
  drift-agent                             guided mode: pick a skill, source and model
  drift-agent run --skill <name> --source <path|url> [options]
  drift-agent skills                      list the skills you can use
  drift-agent model [id] [--effort <lvl>] show or change your default model
  drift-agent models [--json]             models your Claude account offers
  drift-agent login [--console]           sign in to Claude (--console: API billing)
  drift-agent logout                      sign out
  drift-agent doctor                      check Drift, Claude login and the MCP link (free)
  drift-agent status                      show running Drift instances

${bold("Run options")}
  -s, --skill <name>      skill to use (see: drift-agent skills)
  -i, --source <path|url> document, media file, folder, git URL or web page
  -n, --note <text>       extra direction, e.g. "45 seconds, vertical, playful"
  -m, --model <id>        Claude model for this run (e.g. claude-sonnet-5-5, or just "sonnet")
      --effort <level>    low | medium | high | xhigh | max
      --budget <usd>      stop a phase when it has cost this much (default 10)
      --pid <pid>         which Drift instance, when several are running
      --out <dir>         where to keep the run (storyboard, project, log)
  -y, --yes               don't ask before replacing the open timeline
      --json              speak JSON lines on stdout/stdin (for the Drift panel)

Drift must be running with Settings → Agent access turned on.
Claude uses ANTHROPIC_API_KEY if set, otherwise your Claude login (drift-agent login).`;

type Values = Record<string, string | boolean | undefined>;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      skill: { type: "string", short: "s" },
      source: { type: "string", short: "i" },
      note: { type: "string", short: "n" },
      model: { type: "string", short: "m" },
      effort: { type: "string" },
      budget: { type: "string" },
      pid: { type: "string" },
      out: { type: "string" },
      yes: { type: "boolean", short: "y" },
      json: { type: "boolean" },
      console: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help || command === "help") {
    console.log(USAGE);
    return 0;
  }
  if (!command) {
    if (process.stdin.isTTY && process.stdout.isTTY) return cmdGuided();
    console.log(USAGE);
    return 1;
  }

  switch (command) {
    case "run":
      return cmdRun(values);
    case "skills":
      return cmdSkills();
    case "model":
      return cmdModel(positionals[1], values.effort as string | undefined);
    case "models":
      return cmdModels(!!values.json);
    case "login":
      return cmdLogin(!!values.console);
    case "logout":
      return runAuth(["logout"]);
    case "doctor":
      return cmdDoctor(values.pid !== undefined ? Number(values.pid) : undefined);
    case "status":
      return cmdStatus();
  }
  console.error(red(`Unknown command "${command}".`) + "\n\n" + USAGE);
  return 1;
}

// --- skills, status, doctor ----------------------------------------------------------------------

function cmdSkills(): number {
  const skills = listSkills();
  if (skills.length === 0) {
    console.log(`No skills found. Looked in:\n  ${skillRoots().join("\n  ")}`);
    return 1;
  }
  for (const s of skills) {
    console.log(`${bold(s.name)}${s.sources.length ? dim(`  [${s.sources.join(", ")}]`) : ""}`);
    console.log(`  ${s.description}`);
    console.log(dim(`  ${s.dir}`));
  }
  console.log(dim(`\nAdd your own: a folder with a SKILL.md in ${skillRoots()[skillRoots().length - 2]}`));
  return 0;
}

function cmdStatus(): number {
  const cfg = loadConfig();
  console.log(dim(`default model: ${cfg.model ?? "(built-in)"} · effort: ${cfg.effort ?? "(built-in)"}`));
  const instances = discoverInstances();
  if (instances.length === 0) {
    console.log(yellow("No Drift instance with Agent access found.") + " Open Drift → Settings → Agent access.");
    return 1;
  }
  for (const i of instances) console.log(`• ${describeInstance(i)}`);
  return 0;
}

async function cmdDoctor(pid?: number): Promise<number> {
  let ok = true;
  const line = (good: boolean, label: string, detail: string) => {
    ok &&= good;
    console.log(`${good ? green("✔") : red("✖")} ${label}${detail ? dim(`  ${detail}`) : ""}`);
  };

  line(listSkills().length > 0, "Skills", listSkills().map((s) => s.name).join(", ") || `none in ${skillRoots().join(", ")}`);
  const cfg = loadConfig();
  line(true, "Default model", `${cfg.model ?? chooseModel({}, {}).model} · effort ${cfg.effort ?? chooseModel({}, {}).effort}`);

  const conn = await connect(pid);
  if ("error" in conn) {
    const hint = driftProcessRunning()
      ? "Drift is open but Agent access is off: Settings → Agent access"
      : findDrift()
        ? "Drift isn't running (guided mode and `run` can start it for you)"
        : "Drift isn't running, and isn't installed where I looked (set DRIFT_EXE)";
    line(false, "Drift", hint);
  } else {
    const s = conn.summary;
    line(true, "Drift", `${describeInstance(conn.client.instance)} · ${s.w}x${s.h}@${s.fps} · ${s.clips ?? 0} clips`);
  }

  try {
    const inst = "error" in conn ? undefined : conn.client.instance;
    const report = await probe(
      inst ? { [DRIFT]: { type: "http", url: inst.url, headers: { Authorization: `Bearer ${inst.token}` }, alwaysLoad: true } } : {},
    );
    const a = report.account;
    line(a.loggedIn, "Claude login", a.loggedIn ? [a.method, a.provider].filter(Boolean).join(" · ") : "not logged in: run `drift-agent login`");
    if (inst) {
      const d = report.mcp.find((m) => m.name === DRIFT);
      line(
        d?.status === "connected",
        "Claude → Drift MCP",
        `${d?.status ?? "missing"}${d?.version ? ` (Drift ${d.version})` : ""}${d?.error ? `: ${d.error}` : ""}`,
      );
    }
  } catch (err) {
    line(false, "Claude", (err as Error).message);
  }
  console.log(ok ? green("\nReady.") : yellow("\nFix the items above, then run doctor again."));
  return ok ? 0 : 1;
}

// --- login, models -------------------------------------------------------------------------------

async function cmdLogin(useConsole: boolean): Promise<number> {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(
      yellow("ANTHROPIC_API_KEY is set, so runs use that key whatever you log in with here.") +
        dim(" Remove it from your environment to use your Claude login instead."),
    );
  }
  console.log(dim(useConsole ? "Signing in with an Anthropic Console account (API billing)…" : "Signing in with your Claude subscription… (use --console for API billing)"));
  const code = runAuth(useConsole ? ["login", "--console"] : ["login"]);
  if (code !== 0) return code;
  try {
    const { account } = await probe();
    console.log(account.loggedIn ? green(`✔ Logged in: ${account.method}`) : red("✖ Still not logged in."));
    return account.loggedIn ? 0 : 1;
  } catch {
    return 0;
  }
}

let modelCache: Promise<Model[]> | undefined;
// The account's models, read once per process. Empty when Claude can't be reached; the pickers
// then accept typed ids.
function accountModels(): Promise<Model[]> {
  modelCache ??= probe()
    .then((p) => p.models)
    .catch(() => []);
  return modelCache;
}

async function cmdModels(json: boolean): Promise<number> {
  const models = await accountModels();
  const cfg = loadConfig();
  if (json) {
    process.stdout.write(JSON.stringify({ default: chooseModel({}, {}, cfg), models }) + "\n");
    return models.length ? 0 : 1;
  }
  if (!models.length) {
    console.log(red("Couldn't read your models. Are you logged in? Try `drift-agent login`."));
    return 1;
  }
  const current = chooseModel({}, {}, cfg).model;
  for (const m of models) {
    console.log(`${m.id === current ? cyan("●") : " "} ${m.name.padEnd(12)} ${dim(`${m.id} · ${m.description}`)}`);
  }
  return 0;
}

async function cmdModel(id: string | undefined, effortArg: string | undefined): Promise<number> {
  const cfg = loadConfig();
  const current = chooseModel({}, {}, cfg);
  if (effortArg && !EFFORTS.includes(effortArg as EffortLevel)) {
    console.error(red(`--effort must be one of: ${EFFORTS.join(", ")}.`));
    return 1;
  }

  if (id) {
    const models = await accountModels();
    const match = matchModel(id, models);
    const model = match?.id ?? (/^claude-[a-z0-9-]+$/.test(id) ? id : undefined);
    if (!model) {
      console.error(red(`No model matches "${id}".`) + dim(" See: drift-agent models"));
      return 1;
    }
    const saved = saveConfig({ model, ...(effortArg ? { effort: effortArg as EffortLevel } : {}) });
    console.log(green(`Default model: ${saved.model}`) + (saved.effort ? dim(` · effort ${saved.effort}`) : ""));
    return 0;
  }

  if (!process.stdin.isTTY) {
    console.log(`${current.model} · effort ${current.effort}`);
    return 0;
  }
  console.log(dim(`Current default: ${current.model} · effort ${current.effort}  (${configFile})`));
  console.log(dim("Reading your account's models…"));
  const models = await accountModels();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const model = await pickModel(rl, models, current.model);
    const effort = effortArg
      ? (effortArg as EffortLevel)
      : await pickEffort(rl, models.find((m) => m.id === model), current.effort);
    saveConfig({ model, effort });
    console.log(green(`\nDefault model: ${model} · effort ${effort}`) + dim("  (a --model flag or a skill can still override it per run)"));
    return 0;
  } finally {
    rl.close();
  }
}

// --- guided mode ---------------------------------------------------------------------------------

async function cmdGuided(): Promise<number> {
  console.log(bold("drift-agent") + dim(" — Claude builds a video in Drift. Ctrl+C to leave.\n"));

  const skills = listSkills();
  if (!skills.length) {
    console.log(red(`No skills found in ${skillRoots().join(", ")}.`));
    return 1;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // Drift first: no point asking questions if there is nowhere to build.
    const drift = await ensureDrift(rl, new TerminalReporter(), {});
    if (!drift) return 1;
    console.log(green("✔ Drift is ready") + dim(`  ${describeInstance(drift.client.instance)}\n`));

    // Skill
    console.log(bold("Skill"));
    skills.forEach((s, i) =>
      console.log(`  ${bold(String(i + 1))}  ${s.name.padEnd(24)} ${dim(s.description.length > 80 ? s.description.slice(0, 79) + "…" : s.description)}`),
    );
    let skill: Skill | undefined;
    while (!skill) {
      const a = (await ask(rl, `Number or name › `)).trim();
      skill = skills[Number(a) - 1] ?? skills.find((s) => s.name === a);
      if (!skill) console.log(yellow("Pick one from the list."));
    }

    // Source
    const kinds = skill.sources.length ? skill.sources.join(", ") : "document, video, folder, repo or URL";
    console.log(bold("\nSource") + dim(`  (${kinds}; you can drag a file or folder into this window)`));
    let source = "";
    while (!source) {
      // Dragging into PowerShell or Terminal wraps the path in quotes, sometimes with a leading &.
      const a = (await ask(rl, `Path or URL › `)).trim().replace(/^&\s*/, "").replace(/^(['"])(.*)\1$/, "$2");
      if (/^(https?:\/\/|git@)/i.test(a) || (a && existsSync(a))) source = a;
      else if (a) console.log(yellow(`Can't find ${a}.`));
    }

    // Note
    const note = (await ask(rl, `\n${bold("Note")} ${dim("(optional: length, format, tone, audience)")} › `)).trim() || undefined;

    // Model and effort, defaulting to what a run would use anyway.
    const offered = chooseModel({}, skill);
    console.log(dim("\nReading your account's models…"));
    const probed = await probe().catch(() => undefined);
    if (probed && !probed.account.loggedIn) {
      const yes = /^y/i.test(await ask(rl, yellow("You're not logged in to Claude. Log in now? [Y/n] › ")) || "y");
      if (!yes || (await cmdLogin(false)) !== 0) return 1;
      modelCache = undefined;
    } else if (probed) {
      console.log(dim(`Claude: ${probed.account.method}`));
      modelCache = Promise.resolve(probed.models);
    }
    const models = await accountModels();
    if (offered.modelFrom === "skill") console.log(dim(`(${skill.name} recommends ${offered.model})`));
    const model = await pickModel(rl, models, offered.model);
    const effort = await pickEffort(rl, models.find((m) => m.id === model), offered.effort);
    if (model !== offered.model || effort !== offered.effort) {
      if (/^y/i.test((await ask(rl, dim(`Make ${model} · ${effort} your default for next time? [y/N] › `))).trim())) {
        saveConfig({ model, effort });
      }
    }

    // Confirm
    console.log(
      `\n${bold("Ready")}  ${skill.name} · ${source}${note ? ` · "${note}"` : ""}\n       ${model} · effort ${effort}`,
    );
    const go = (await ask(rl, `Start? [Y/n] › `)).trim();
    if (/^n/i.test(go)) return 1;

    return await startRun({ skill, source, note, model, effort, json: false, rl });
  } finally {
    rl.close();
  }
}

// --- run -----------------------------------------------------------------------------------------

async function cmdRun(values: Values): Promise<number> {
  const json = !!values.json;
  const fail = (message: string) => {
    (json ? new JsonReporter() : new TerminalReporter()).emit({ type: "error", phase: "setup", message });
    return 1;
  };

  const skillName = values.skill as string | undefined;
  const sourceInput = values.source as string | undefined;
  if (!skillName || !sourceInput) return fail("run needs --skill and --source. See drift-agent --help, or run drift-agent with no arguments for guided mode.");
  const skill = findSkill(skillName);
  if (!skill) return fail(`No skill named "${skillName}". Available: ${listSkills().map((s) => s.name).join(", ") || "none"}.`);

  const effortFlag = values.effort as EffortLevel | undefined;
  if (effortFlag && !EFFORTS.includes(effortFlag)) return fail(`--effort must be one of: ${EFFORTS.join(", ")}.`);
  let modelFlag = values.model as string | undefined;
  // Short names ("sonnet", "opus") resolve against the account; full ids pass straight through.
  if (modelFlag && !/^claude-/.test(modelFlag)) {
    const match = matchModel(modelFlag, await accountModels());
    if (!match) return fail(`No model matches "${modelFlag}". See: drift-agent models`);
    modelFlag = match.id;
  }
  const choice = chooseModel({ model: modelFlag, effort: effortFlag }, skill);
  if (!json && choice.modelFrom === "skill") console.log(dim(`  ${skill.name} sets its own model (${choice.model}); --model overrides it.`));

  const budgetUsd = values.budget !== undefined ? Number(values.budget) : 10;
  if (!(budgetUsd > 0)) return fail("--budget must be a positive number of dollars.");

  const rl = createInterface({ input: process.stdin, output: json ? undefined : process.stdout, terminal: !json && process.stdin.isTTY });
  try {
    return await startRun({
      skill,
      source: sourceInput,
      note: values.note as string | undefined,
      model: choice.model,
      effort: choice.effort,
      budgetUsd,
      pid: values.pid !== undefined ? Number(values.pid) : undefined,
      out: values.out as string | undefined,
      yes: !!values.yes,
      json,
      rl,
    });
  } finally {
    rl.close();
  }
}

interface StartParams {
  skill: Skill;
  source: string;
  note?: string;
  model: string;
  effort: EffortLevel;
  budgetUsd?: number;
  pid?: number;
  out?: string;
  yes?: boolean;
  json: boolean;
  rl: Interface;
}

async function startRun(p: StartParams): Promise<number> {
  const { skill, json, rl } = p;
  const reporter: Reporter = json ? new JsonReporter() : new TerminalReporter();
  const fail = (message: string) => {
    reporter.emit({ type: "error", phase: "setup", message });
    return 1;
  };

  reporter.emit({ type: "status", phase: "setup", message: "Connecting to Drift…" });
  const conn = await ensureDrift(rl, reporter, { pid: p.pid, assumeYes: p.yes, json });
  if (!conn) return 1;
  if (!json) console.log(dim(`  ${describeInstance(conn.client.instance)}`));

  const abort = new AbortController();
  process.on("SIGINT", () => {
    if (abort.signal.aborted) process.exit(130);
    abort.abort();
  });

  try {
    if (!(await freshProject(conn.client, conn.summary, !!p.yes || json, rl, reporter))) {
      reporter.emit({ type: "status", phase: "setup", message: "Left the open timeline alone. Nothing was done." });
      return 1;
    }

    const runDir = makeRunDir(p.out, skill.name);
    if (!json) console.log(dim(`  run folder: ${runDir}`));
    const source = resolveSource(p.source, runDir, (m) => reporter.emit({ type: "status", phase: "setup", message: m }));
    if (skill.sources.length && !skill.sources.includes(source.kind)) {
      reporter.emit({
        type: "status",
        phase: "setup",
        message: yellow(`Note: "${skill.name}" is meant for ${skill.sources.join("/")}, and this source is a ${source.kind}.`),
      });
    }

    const control = new RunControl(p.model, p.effort);
    const result = await runSkill({
      skill,
      source,
      note: p.note,
      control,
      budgetUsd: p.budgetUsd ?? 10,
      drift: conn.client.instance,
      runDir,
      reporter,
      reviewer: json ? new JsonReviewer(rl, control, () => abort.abort()) : new TerminalReviewer(rl, control, accountModels),
      abort,
    });

    if (!json) {
      console.log();
      if (result.ok && result.phase === "build") {
        console.log(green(bold("Done.")) + ` The video is on the Drift timeline — edit away.`);
        if (result.projectPath) console.log(dim(`  project: ${result.projectPath}`));
      }
      if (result.storyboardFile) console.log(dim(`  storyboard: ${result.storyboardFile}`));
      console.log(dim(`  log: ${join(runDir, "events.jsonl")} · total cost ≈ $${result.costUsd.toFixed(2)}`));
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    return fail((err as Error).message);
  }
}

// Connects to Drift, helping when it isn't reachable: if it's open with Agent access off, waits
// for the user to switch it on; if it isn't running, offers to start it with Agent access on for
// this session. JSON mode (the panel runs inside Drift) and an explicit --pid only report.
async function ensureDrift(
  rl: Interface,
  reporter: Reporter,
  opts: { pid?: number; assumeYes?: boolean; json?: boolean },
): Promise<{ client: DriftClient; summary: ProjectSummary } | undefined> {
  const fail = (message: string) => {
    reporter.emit({ type: "error", phase: "setup", message });
    return undefined;
  };
  const conn = await connect(opts.pid);
  if (!("error" in conn)) return conn;
  if (opts.json || opts.pid !== undefined || !process.stdin.isTTY) return fail(conn.error);

  if (driftProcessRunning()) {
    console.log(yellow("Drift is open, but Agent access is off.") + " In Drift, turn on Settings → Agent access.");
    console.log(dim("Waiting for it… (Ctrl+C to stop)"));
    return (await waitForDrift(10 * 60)) ?? fail("Gave up waiting for Agent access.");
  }

  const launcher = findDrift();
  if (!launcher) {
    return fail(
      "Drift isn't running and I couldn't find where it's installed. Start Drift yourself and turn on " +
        "Settings → Agent access, or set DRIFT_EXE to the Drift executable.",
    );
  }
  if (!opts.assumeYes) {
    const answer = (await ask(rl, `Drift isn't running. Start ${launcher.label} with Agent access on? [Y/n] › `)).trim();
    if (/^n/i.test(answer)) return fail("Drift isn't running. Open it and turn on Settings → Agent access, then try again.");
  }
  launchDrift(launcher);
  console.log(dim("Starting Drift… (Agent access is on for this session only; your setting is unchanged)"));
  return (
    (await waitForDrift(120)) ??
    fail("Drift didn't open Agent access within two minutes. Check that it started, then turn on Settings → Agent access.")
  );
}

// Every run starts from an empty project, so media imported while planning survives into the
// build. Replacing a timeline that has work on it needs the user's say-so.
async function freshProject(
  client: DriftClient,
  summary: ProjectSummary,
  assumeYes: boolean,
  rl: Interface,
  reporter: Reporter,
): Promise<boolean> {
  const hasWork = (summary.clips ?? 0) > 0 || !!summary.dirty;
  if (hasWork && !assumeYes) {
    const what = `"${summary.name || "Untitled"}" (${summary.clips ?? 0} clips${summary.dirty ? ", unsaved changes" : ""})`;
    const answer = await ask(
      rl,
      yellow(`Drift has ${what} open. Claude builds in a new project; `) +
        (summary.dirty ? red("unsaved changes will be lost. ") : "") +
        `Continue? [y/N] › `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) return false;
  }
  reporter.emit({ type: "status", phase: "setup", message: "Starting a new Drift project for this run…" });
  await client.call("new_project", {});
  return true;
}

function makeRunDir(out: string | undefined, skillName: string): string {
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").replace(/\..+$/, "");
  const videos = join(homedir(), "Videos");
  const base = out ?? join(existsSync(videos) ? videos : join(homedir(), ".drift-agent"), "Drift Agent");
  const dir = join(base, `${stamp}-${slug(skillName)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(red(`✖ ${(err as Error).stack ?? err}`));
    process.exit(1);
  },
);
