---
name: doc-explainer
description: Turn a document or web page (PDF, Markdown, article, report, spec, notes) into a short narrated explainer with kinetic titles and vector diagrams.
sources: [document, url]
---

# Document → explainer video

Make a video that someone who never opens the document comes away understanding: what it is,
the few things that matter in it, and what to do about them.

## Defaults (the user's note overrides any of these)
- 60–90 seconds, 1920x1080 at 30 fps. "vertical", "short", "reel" or "tiktok" in the note means
  1080x1920 and 30–45 seconds.
- Local voiceover (`voiceover: "local"`). If local TTS turns out to be unavailable, plan for
  on-screen text that carries the whole message instead.
- No stock footage unless the document is about something visual (a place, a product); the look
  comes from typography, colour and diagrams.

## Reading the document
- PDFs: read the first pages to find the structure (title, abstract, table of contents,
  headings), then read the sections that carry the argument. Use the Read tool's page ranges for
  long PDFs rather than reading everything.
- Markdown / text: read it all if it is under ~40 pages, otherwise headings first.
- Web pages: WebFetch the URL.
- Note the 3–6 ideas that matter most, any striking numbers, and any process, comparison or
  structure that would read better as a picture than as words. Record where each came from
  (page, section) for `sourceRefs`.

## Story shape
1. **Hook** (3–6 s): the single most surprising or useful thing, as a question or a bold claim.
2. **Context** (one scene): what the document is and why it exists.
3. **Key points** (3–5 scenes, 8–15 s each): one idea per scene. Lead with the takeaway, then the
   support. A number gets a big-number treatment; a process or comparison gets a diagram.
4. **Recap / call to action** (one scene): the one line to remember, and what to do next.

Narration runs at about 2.5 words per second; size each scene's script to its duration. On-screen
text never duplicates the narration word for word — it is the headline, the narration is the
explanation.

## Look
- Pick one palette of 3–4 colours that fits the subject (a dark neutral background, a light text
  colour, one or two accents) and give hex values in `style`. Use it everywhere.
- Pick one text preset for headlines and one for supporting text (list_text_presets during
  planning); name them in `style`.
- Diagrams are inline SVG (add_svg): flat shapes, the palette, generous spacing, large labels
  (at least 36 px at 1080p), no more than ~7 elements. Animate them in with keyframes (opacity
  and a small position or scale move), staggered when there are several parts.
- Every scene has motion: text animates in and out, diagrams build up, nothing sits static for
  more than ~3 seconds. Use soft transitions (a short dissolve or slide) between scenes, and no
  more than two kinds of transition in the whole video.

## Building notes
- Generate each scene's voiceover first (tts_generate provider "local"), read its duration, and
  set the scene to the voice length plus about 0.4 s of air.
- Keep a full-canvas background (shape or SVG) on the lowest track for the whole video.
- Text sits inside the title-safe area (5% in from every edge).
