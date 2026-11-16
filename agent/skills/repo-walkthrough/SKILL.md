---
name: repo-walkthrough
description: Explain a code repository on video — what it does, how it is built, the code that matters, and how to run it — with architecture diagrams and code cards drawn from the real source.
sources: [repo]
---

# Repository → walkthrough video

Make a video a developer can watch in under two minutes and then explain the project to someone
else: the problem it solves, its shape, one piece of code that captures how it works, and how to
start using it.

## Defaults (the user's note overrides any of these)
- 75–120 seconds, 1920x1080 at 30 fps. Vertical (1080x1920) if the note asks for a short/reel.
- Local voiceover. Calm, precise, developer-to-developer tone; no hype words.
- Dark, editor-like look (see `references/svg-templates.md`).

## Reading the repository
Spend your reading where it pays:
1. README, then any docs/ overview or architecture file.
2. The manifest(s): package.json, pyproject.toml, Cargo.toml, go.mod, CMakeLists.txt, pom.xml…
   — they tell you the language, the dependencies that matter and the entry points.
3. The top-level layout: Glob for the main source folders; work out what each one is for.
4. The entry point and the one or two modules that do the core job. Read them, not just their
   names.
5. How to run it: install and start commands, from the README or scripts.

Accuracy is the whole point. Every name, number and claim in the video must come from a file you
read; record `path:line-range` in each scene's `sourceRefs`. If something is unclear, leave it
out rather than guess. Never invent features, benchmarks or users.

## Story shape
1. **Hook** (4–6 s): the problem this project solves, in one sentence, with the project name.
2. **What it is** (8–12 s): language, kind of project (library, CLI, app, service), the one-line
   pitch.
3. **Architecture** (15–25 s): one diagram of the real top-level components and how data or
   control flows between them, built up piece by piece while the narration walks through it.
4. **How it works** (15–25 s): one code card — the 6–14 most telling lines from a real file,
   with the path shown — plus narration explaining what happens there. Optionally a second card.
5. **Getting started** (8–12 s): the real install/run commands on a terminal card.
6. **Close** (4–6 s): project name, what to read next (repo URL or docs path if known).

## Look
- Use the templates in `references/svg-templates.md` for code cards, terminal cards and
  architecture diagrams; keep their palette unless the note asks otherwise.
- Code on screen is real code, copied exactly (trim lines, never rewrite them). Keep lines under
  ~60 characters; elide with `…` rather than shrink the font.
- Highlight the line being discussed by animating a translucent accent bar behind it
  (a separate SVG or shape clip keyed in position).
- Diagram boxes appear one at a time as the narration names them; arrows draw after both ends
  exist.
- Titles: one clean sans preset for headings, consistent across scenes.

## Building notes
- Generate each scene's voiceover first and fit the scene to it.
- Build diagrams as several add_svg clips (one per box/arrow group) when they need to appear in
  sequence; a single SVG when the whole diagram appears at once.
