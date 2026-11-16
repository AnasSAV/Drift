// Turning what the user pointed at into something Claude can read.
//
// Local files and folders are read in place. A git URL is shallow-cloned into the run folder by
// this process (Claude has no shell). Any other URL is left for Claude's WebFetch tool.

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { SourceKind } from "./skills.js";

export interface Source {
  kind: SourceKind;
  // What the user typed.
  input: string;
  // Absolute local path for files and folders (and clones); undefined for plain URLs.
  path?: string;
  url?: string;
  // Folder Claude may read: the folder itself, or the file's parent.
  root?: string;
}

const VIDEO = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mts", ".m2ts", ".wmv", ".flv", ".mxf"]);
const AUDIO = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac", ".opus"]);

function looksLikeGitUrl(s: string): boolean {
  return (
    /\.git$/i.test(s) ||
    /^git@/.test(s) ||
    /^https?:\/\/(www\.)?(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/[^/]+\/[^/#?]+\/?$/i.test(s)
  );
}

export function resolveSource(input: string, runDir: string, onStatus: (msg: string) => void): Source {
  if (/^(https?:\/\/|git@)/i.test(input)) {
    if (looksLikeGitUrl(input)) {
      const dest = join(runDir, "source", basename(input.replace(/\/$/, "")).replace(/\.git$/i, ""));
      onStatus(`Cloning ${input} (shallow)…`);
      try {
        execFileSync("git", ["clone", "--depth", "1", "--quiet", input, dest], { stdio: ["ignore", "ignore", "pipe"] });
      } catch (err) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
        throw new Error(`git clone failed${stderr ? `: ${stderr}` : ""}`);
      }
      return { kind: "repo", input, path: dest, root: dest, url: input };
    }
    return { kind: "url", input, url: input };
  }

  const path = resolve(input);
  if (!existsSync(path)) throw new Error(`Source not found: ${path}`);
  if (statSync(path).isDirectory()) return { kind: "repo", input, path, root: path };
  const ext = extname(path).toLowerCase();
  const kind: SourceKind = VIDEO.has(ext) || AUDIO.has(ext) ? "video" : "document";
  return { kind, input, path, root: dirname(path) };
}

export function describeSource(s: Source): string {
  switch (s.kind) {
    case "repo":
      return s.url
        ? `a code repository cloned from ${s.url} into ${s.path}`
        : `a folder / code repository at ${s.path}`;
    case "video":
      return `a media file at ${s.path} (Drift can import it with import_media; you cannot read it directly)`;
    case "document":
      return `a document at ${s.path}`;
    case "url":
      return `a web page at ${s.url} (read it with WebFetch)`;
  }
}
