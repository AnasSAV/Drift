# drift-agent

Claude builds a video in Drift from a document, a video, a folder, a git repo or a web page. You
pick a **skill**, point it at a **source**, review the **storyboard** Claude proposes, and once you
approve it Claude builds the timeline. Everything it builds is ordinary Drift clips you can keep
editing.

This is phase 1: a command-line helper that drives a running Drift through its MCP server. Phase 2
puts the same flow in a panel inside Drift (the `--json` mode below is the protocol it will use).

## Setup

```bash
cd agent
npm install
```

You need:

- **Drift with Agent access on** (Settings → Agent access). Any Drift 0.9.1+ works, including
  the Microsoft Store build.
  - If Drift isn't running, guided mode and `run` offer to start it, with Agent access on for
    that session only; your setting is left alone. Drift is found in the Microsoft Store
    package, the installer's folder, Flatpak, `/Applications` or on `PATH`, or set `DRIFT_EXE`.
  - If Drift is open with Agent access off, the helper waits while you switch it on.
  - A headless instance works too: `drift --headless --mcp-port 4741 --mcp-token <token>`.
- **A Claude login** (see below).

Check everything, without spending anything:

```bash
npm start -- doctor
```

## Logging in

Runs use the same credentials as Claude Code, so if you've logged in to Claude Code you're
already logged in here. `doctor` shows which login is in use.

```bash
npm start -- login             # sign in with your Claude subscription (Pro / Max); opens the browser
npm start -- login --console   # sign in with an Anthropic Console account instead (pay per use)
npm start -- logout
```

- With a **subscription login**, runs count against your plan's usage limits. Nothing is charged
  per run, and `--budget` doesn't apply.
- To use an **API key** instead, set `ANTHROPIC_API_KEY`. When it's set, it takes precedence
  over any login.

## Choosing the model

Your account's models (`npm start -- models`) are all available. Pick one:

- **as your default**: `npm start -- model` opens a picker for the model and effort. Or set it
  directly: `npm start -- model sonnet --effort medium`. It's saved in
  `~/.drift-agent/config.json`.
- **for one run**: `--model sonnet` (short names work), `--effort low`.
- **in guided mode**: `npm start` with no arguments asks for the model, along with the skill and
  source.
- **mid-run**: at the storyboard review, press `[m]` to switch the model for the build. For
  example, plan on a fast model and build on a stronger one.

When several are set, the order is: `--model` flag, then the skill's own `model:`, then your
default, then the built-in default (`claude-opus-5-5` at `high` effort). Each run prints the
model it's using.

| Model | Good for |
| --- | --- |
| Opus 5.5 | The default: best results for most videos. |
| Sonnet 5.5 | Cheaper and faster; fine for simple videos. Uses less of a Pro plan. |
| Fable 5.2 | The most capable, for long or demanding videos; costs the most. |
| Haiku 5.5 | Very cheap; good for testing a skill, too rough for final videos. |

## Use

```bash
npm start                           # guided mode: asks for skill, source, note and model
npm start -- skills                 # what you can make
npm start -- run --skill repo-walkthrough --source D:/code/some-repo
npm start -- run --skill doc-explainer --source ./whitepaper.pdf --note "60s, vertical, upbeat"
npm start -- run --skill footage-highlight-reel --source D:/footage/talk.mp4
npm start -- run --skill repo-walkthrough --source https://github.com/owner/project
```

A run:

1. **Connects** to Drift and starts a new project. If the open timeline has clips or unsaved
   changes, it asks first (`--yes` skips the question).
2. **Plans.** Claude reads the source: documents and repos with read-only file tools; media goes
   through Drift (import, transcribe, scene detection, contact sheets); web pages through
   WebFetch. Git URLs are shallow-cloned into the run folder first. Then Claude proposes a
   storyboard: scenes, narration, on-screen text, visuals, timing and style.
3. **You review**:
   - `a`: approve and build.
   - `e`: edit the storyboard JSON in your editor (`$EDITOR`, otherwise Notepad on Windows).
     Your version is what gets built.
   - `r`: describe what to change, and Claude revises the storyboard.
   - `m`: switch the model (and effort) used from here on.
   - `q`: stop. Nothing is built.
4. **Builds**: scene by scene (one undo step per batch), with a bookmark at each scene start.
   Claude checks its work with contact sheets, saves the project and reports anything that
   differs from the storyboard.

Each run keeps its files in `~/Videos/Drift Agent/<time>-<skill>/` (or `--out`):

| File | What |
| --- | --- |
| `storyboard.json` | What was approved |
| `<title>.drift` | The built project |
| `events.jsonl` | Every step, for debugging |
| `claude-stderr.log` | The Claude process's own log |

### Options

| Flag | Default | |
| --- | --- | --- |
| `-m`, `--model` | your default | Any model id, or a short name like `sonnet`. |
| `--effort` | your default | `low` · `medium` · `high` · `xhigh` · `max` |
| `--budget` | `10` | USD per phase; the phase stops when it is reached. |
| `--note` | | Extra direction for the skill: length, format, tone, audience. |
| `--pid` | newest | Which Drift instance, when several are running. |
| `--yes` | | Replace the open timeline without asking. |
| `--json` | | JSON lines on stdout, commands on stdin (see below). |

## What Claude may do

Claude runs with an explicit allow-list, enforced in [src/policy.ts](src/policy.ts):

- **Files**: it can read the source and the skill's folder, and nothing else. It has no shell
  and can't write files.
- **While planning**: Drift's read and research ops only (import, transcribe, list presets and
  voices, search stock). It can't edit the timeline.
- **While building**: it can edit the timeline. It can never open, close or replace projects,
  export, install add-ons, or change your themes, shortcuts or preferences.
- **Billing**: cloud voice and sound effects (ElevenLabs/Fish) bill your account, so they're
  refused unless the approved storyboard set `voiceover: "cloud"`. Local voiceover (Drift's
  on-device Chatterbox) is free.

## Skills

A skill is a folder with a `SKILL.md`: YAML frontmatter, then instructions in markdown. It can
include reference files and templates the instructions point to.

```markdown
---
name: product-demo
description: A 45-second product demo from a landing page or README.
sources: [document, url, repo]   # optional: what it expects
model: claude-opus-5-5           # optional: overrides --model
effort: high                     # optional: overrides --effort
---

# Product demo

What the video is for, how to read the source, the story shape, the look,
and anything specific about building it in Drift…
```

Skills are looked up in this order (the first one with a given name wins):

1. Each folder in `DRIFT_AGENT_SKILLS` (separated like `PATH`).
2. `~/.drift-agent/skills/`. Put your own skills here.
3. `agent/skills/`, the bundled skills:

| Skill | Source | Makes |
| --- | --- | --- |
| `doc-explainer` | document, URL | A narrated explainer with kinetic titles and vector diagrams |
| `repo-walkthrough` | repo | What the project does, an architecture diagram, real code cards, how to run it |
| `footage-highlight-reel` | video | A vertical highlight reel with a hook, captions and music |

The chosen skill's instructions go into Claude's system prompt, after a general Drift playbook
(how to batch ops, check its work, build diagrams as inline SVG, and use voiceover). See
[src/prompts.ts](src/prompts.ts). A skill only needs to say what makes *its* video good.

## JSON mode

`run --json` is the interface the Drift panel will use. Events go to stdout, one JSON object per
line (types in [src/events.ts](src/events.ts)):

```json
{"type":"status","phase":"plan","message":"Planning with skill \"doc-explainer\"…"}
{"type":"tool","phase":"plan","id":"toolu_…","name":"drift.apply","summary":"[list_text_presets]"}
{"type":"storyboard","storyboard":{…},"file":"…/storyboard.json"}
{"type":"done","phase":"build","costUsd":0.84,"turns":31,"result":"…report…"}
```

Commands go to stdin, one per line:

```json
{"type":"approve"}
{"type":"approve","storyboard":{…edited…},"model":"claude-opus-5-5","effort":"high"}
{"type":"revise","note":"Make it vertical and cut scene 3"}
{"type":"set_model","model":"claude-sonnet-5-5","effort":"medium"}
{"type":"cancel"}
```

`set_model` can be sent at any time and applies from the next turn; each turn starts with a
`{"type":"model",…}` event saying which model it uses. `drift-agent models --json` gives the
panel the account's models and the current default to fill its model menu.

## Development

```bash
npm test           # policy, skills, storyboard, sources, model choice and pickers
npm run typecheck
npm run build      # emits dist/; then `node dist/cli.js …`
```
