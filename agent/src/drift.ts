// Finding and talking to a running Drift editor.
//
// With Settings → Agent access on, each editor writes <dir>/drift/mcp-sessions/<pid>.json holding
// its port and bearer token (src/app/mcp/protocol/McpSession.cpp). <dir> is Qt's RuntimeLocation,
// which on Windows is the user's home folder and on Linux $XDG_RUNTIME_DIR, falling back to the
// temp folder. DRIFT_MCP_URL + DRIFT_MCP_TOKEN skip discovery entirely, e.g. for a headless
// instance started with --mcp-token.
//
// Claude itself reaches Drift through the Agent SDK's HTTP MCP client; the small client here is
// only for the pre-flight check (is the editor up, is the timeline empty) before any tokens are
// spent.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export interface DriftInstance {
  url: string;
  token: string;
  pid?: number;
  projectName?: string;
  project?: string;
  headless?: boolean;
  startedAt?: number;
}

function candidateDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.DRIFT_MCP_SESSION_DIR) dirs.push(process.env.DRIFT_MCP_SESSION_DIR);
  if (process.env.XDG_RUNTIME_DIR) dirs.push(join(process.env.XDG_RUNTIME_DIR, "drift", "mcp-sessions"));
  dirs.push(join(homedir(), "drift", "mcp-sessions"));
  dirs.push(join(tmpdir(), "drift", "mcp-sessions"));
  return [...new Set(dirs)];
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return true; // no pid recorded: let the health check decide
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else, which still counts as running.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function discoverInstances(): DriftInstance[] {
  if (process.env.DRIFT_MCP_URL && process.env.DRIFT_MCP_TOKEN) {
    return [{ url: process.env.DRIFT_MCP_URL, token: process.env.DRIFT_MCP_TOKEN }];
  }
  const found: DriftInstance[] = [];
  for (const dir of candidateDirs()) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(dir, name), "utf8"));
        if (!rec.token || !(rec.url || rec.port)) continue;
        if (!pidAlive(rec.pid)) continue; // stale record left by a crashed editor
        found.push({
          url: rec.url ?? `http://127.0.0.1:${rec.port}/mcp`,
          token: rec.token,
          pid: rec.pid,
          projectName: rec.projectName,
          project: rec.project,
          headless: rec.headless,
          startedAt: rec.startedAt,
        });
      } catch {
        // half-written or foreign file; ignore
      }
    }
  }
  // Newest first, matching the order drift --mcp-stdio uses.
  return found.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

export function describeInstance(i: DriftInstance): string {
  const name = i.projectName ? `"${i.projectName}"` : "untitled";
  return `${name}${i.headless ? " (headless)" : ""}${i.pid ? `, pid ${i.pid}` : ""} at ${i.url}`;
}

export class DriftClient {
  private nextId = 1;
  constructor(readonly instance: DriftInstance) {}

  // Calls one tool and returns the JSON the tool put in its first text block.
  async call<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await fetch(this.instance.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.instance.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: this.nextId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401) throw new Error("Drift rejected the token: Agent access was turned off and on again, re-run to pick up the new one.");
    if (!res.ok) throw new Error(`Drift answered HTTP ${res.status}`);
    const body = (await res.json()) as {
      result?: { content?: { type: string; text?: string }[]; isError?: boolean };
      error?: { message: string };
    };
    if (body.error) throw new Error(`Drift: ${body.error.message}`);
    const text = body.result?.content?.find((c) => c.type === "text")?.text ?? "{}";
    const parsed = JSON.parse(text) as T & { ok?: boolean; error?: string; detail?: string };
    if (body.result?.isError || parsed.ok === false) {
      throw new Error(`Drift ${name} failed: ${parsed.error ?? "error"}${parsed.detail ? ` (${parsed.detail})` : ""}`);
    }
    return parsed;
  }
}

export interface ProjectSummary {
  name?: string;
  w?: number;
  h?: number;
  fps?: number;
  dur?: number;
  clips?: number;
  path?: string;
  dirty?: boolean;
}

// --- starting Drift --------------------------------------------------------------------------

export interface DriftLauncher {
  cmd: string;
  args: string[];
  label: string;
}

function onPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? [".exe", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (dir && existsSync(p)) return p;
    }
  }
  return undefined;
}

function quiet(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();
  } catch {
    return "";
  }
}

// Where Drift is installed: $DRIFT_EXE, then the platform's usual places (the Microsoft Store
// package, the installer's folder, Flatpak, /Applications, PATH).
export function findDrift(): DriftLauncher | undefined {
  const env = process.env.DRIFT_EXE;
  if (env && existsSync(env)) return { cmd: env, args: [], label: env };

  if (process.platform === "win32") {
    // Store packages live under WindowsApps; ask PowerShell where (stable before nightly).
    const store = quiet("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-AppxPackage -Name 'CutWireStudios.CutWireDrift*' | Sort-Object Name | Select-Object -First 1 -ExpandProperty InstallLocation",
    ]);
    if (store && existsSync(join(store, "drift.exe"))) return { cmd: join(store, "drift.exe"), args: [], label: "Drift (Microsoft Store)" };
    for (const dir of [
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Drift"),
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Drift"),
    ]) {
      if (existsSync(join(dir, "drift.exe"))) return { cmd: join(dir, "drift.exe"), args: [], label: join(dir, "drift.exe") };
    }
  } else if (process.platform === "darwin") {
    for (const app of ["/Applications/Drift.app", join(homedir(), "Applications", "Drift.app")]) {
      const macos = join(app, "Contents", "MacOS");
      const exe = existsSync(macos) ? readdirSync(macos)[0] : undefined;
      if (exe) return { cmd: join(macos, exe), args: [], label: app };
    }
  } else if (quiet("flatpak", ["info", "org.cutwire.Drift"])) {
    return { cmd: "flatpak", args: ["run", "org.cutwire.Drift"], label: "Drift (Flatpak)" };
  }

  const path = onPath("drift");
  return path ? { cmd: path, args: [], label: path } : undefined;
}

// Whether a Drift editor process is running at all, with or without Agent access.
export function driftProcessRunning(): boolean {
  if (process.platform === "win32") {
    return /drift\.exe/i.test(quiet("tasklist", ["/FI", "IMAGENAME eq drift.exe", "/FO", "CSV", "/NH"]));
  }
  return quiet("pgrep", ["-x", "drift"]) !== "" || quiet("pgrep", ["-f", "org.cutwire.Drift"]) !== "";
}

// Starts the editor with Agent access on for this session only (--agent-access leaves the
// "Start agent on startup" setting alone). Detached, so it keeps running after this helper exits.
export function launchDrift(launcher: DriftLauncher): void {
  const child = spawn(launcher.cmd, [...launcher.args, "--agent-access"], { detached: true, stdio: "ignore" });
  child.unref();
}

// Polls until a Drift instance answers, for up to `seconds`. `onTick` lets the caller show progress
// and stop early (return false).
export async function waitForDrift(
  seconds: number,
  onTick?: (elapsed: number) => boolean | void,
): Promise<{ client: DriftClient; summary: ProjectSummary } | undefined> {
  const start = Date.now();
  while (Date.now() - start < seconds * 1000) {
    if (discoverInstances().length) {
      const conn = await connect();
      if (!("error" in conn)) return conn;
    }
    if (onTick?.((Date.now() - start) / 1000) === false) return undefined;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return undefined;
}

// The first instance that answers, so a stale registry entry doesn't stop the run.
export async function connect(
  pick?: number,
): Promise<{ client: DriftClient; summary: ProjectSummary } | { error: string }> {
  const instances = discoverInstances().filter((i) => pick === undefined || i.pid === pick);
  if (instances.length === 0) {
    return {
      error:
        pick !== undefined
          ? `No Drift instance with pid ${pick} has Agent access on.`
          : "No running Drift with Agent access found. Open Drift, then Settings → Agent access → on.",
    };
  }
  const errors: string[] = [];
  for (const inst of instances) {
    const client = new DriftClient(inst);
    try {
      const summary = await client.call<ProjectSummary>("inspect", {});
      return { client, summary };
    } catch (err) {
      errors.push(`${describeInstance(inst)}: ${(err as Error).message}`);
    }
  }
  return { error: `Could not reach Drift:\n  ${errors.join("\n  ")}` };
}
