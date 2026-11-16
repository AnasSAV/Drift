// The Claude side of setup: who is logged in, which models the account offers, and logging in or
// out. Runs use the same credentials Claude Code does (~/.claude), or ANTHROPIC_API_KEY when it
// is set, so logging in here and in Claude Code are the same thing.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { query, type EffortLevel, type McpServerConfig, type ModelInfo } from "@anthropic-ai/claude-agent-sdk";

export interface Account {
  // How requests are authenticated, in words: "Claude Pro login", "API key (ANTHROPIC_API_KEY)", …
  method?: string;
  loggedIn: boolean;
  provider?: string;
}

export interface Model {
  id: string;
  name: string;
  description: string;
  efforts: EffortLevel[];
}

export interface Probe {
  account: Account;
  models: Model[];
  mcp: { name: string; status: string; error?: string; version?: string }[];
}

// Starts a Claude session without sending a prompt (streaming input that never yields), reads
// the account, the model list and MCP status, and closes it. Nothing reaches the model, so
// nothing is billed or counted against a subscription.
export async function probe(mcpServers: Record<string, McpServerConfig> = {}): Promise<Probe> {
  const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
  const q = query({
    prompt: idle,
    options: { tools: [], settingSources: [], strictMcpConfig: true, mcpServers },
  });
  try {
    const init = await q.initializationResult();
    let mcp = await q.mcpServerStatus();
    // HTTP servers connect in the background; give them a moment.
    for (let i = 0; i < 20 && mcp.some((s) => s.status === "pending"); i++) {
      await new Promise((r) => setTimeout(r, 250));
      mcp = await q.mcpServerStatus();
    }
    return {
      account: describeAccount(init.account),
      models: toModels(init.models),
      mcp: mcp.map((s) => ({ name: s.name, status: s.status, error: s.error, version: s.serverInfo?.version })),
    };
  } finally {
    q.close();
  }
}

function describeAccount(a: {
  apiKeySource?: string;
  tokenSource?: string;
  subscriptionType?: string;
  apiProvider?: string;
}): Account {
  const key = a.apiKeySource && a.apiKeySource !== "none" ? a.apiKeySource : undefined;
  const token = a.tokenSource && a.tokenSource !== "none" ? a.tokenSource : undefined;
  const method = key
    ? `API key (${key})`
    : a.subscriptionType
      ? `${a.subscriptionType} login`
      : token
        ? `token (${token})`
        : undefined;
  return { method, loggedIn: !!method, provider: a.apiProvider };
}

// The account's list leads with aliases ("default", "opus", …) that resolve to concrete models;
// collapse them so each model appears once, under its real id, in the account's order.
export function toModels(list: ModelInfo[]): Model[] {
  const seen = new Set<string>();
  const out: Model[] = [];
  for (const m of list) {
    const id = m.resolvedModel ?? m.value;
    if (m.value === "default" || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: m.displayName,
      description: m.description,
      efforts: m.supportedEffortLevels ?? [],
    });
  }
  return out;
}

// Accepts a full id or a short alias ("sonnet", "opus-5-5") and returns the account's model.
export function matchModel(input: string, models: Model[]): Model | undefined {
  const want = input.trim().toLowerCase();
  return (
    models.find((m) => m.id.toLowerCase() === want) ??
    models.find((m) => m.name.toLowerCase() === want) ??
    models.find((m) => m.id.toLowerCase().includes(want) || m.name.toLowerCase().startsWith(want))
  );
}

// The Claude binary that ships with the Agent SDK for this platform, else `claude` on PATH. Both
// read and write the same credential store.
function claudeBinary(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const exe = join(dirname(pkg), process.platform === "win32" ? "claude.exe" : "claude");
    if (existsSync(exe)) return exe;
  } catch {
    // platform package not installed; fall back to PATH
  }
  return "claude";
}

// Hands the terminal to Claude's own sign-in flow (it opens the browser). Returns its exit code.
export function runAuth(args: string[]): number {
  const res = spawnSync(claudeBinary(), ["auth", ...args], { stdio: "inherit" });
  if (res.error) {
    console.error(`Could not start Claude's sign-in (${res.error.message}). Install Claude Code, or set ANTHROPIC_API_KEY.`);
    return 1;
  }
  return res.status ?? 1;
}
