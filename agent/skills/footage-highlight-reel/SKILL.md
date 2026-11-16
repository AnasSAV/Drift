---
name: footage-highlight-reel
description: Cut raw footage (a talk, vlog, gameplay, event or screen recording) into a tight highlight reel with a hook, captions and music, vertical by default.
sources: [video]
---

# Footage → highlight reel

Find the moments worth watching in the footage and cut them into a short that holds attention from
the first second.

## Defaults (the user's note overrides any of these)
- 30–60 seconds, 1080x1920 at 30 fps (vertical). "landscape" or "youtube" in the note means
  1920x1080.
- Captions on (most people watch muted). No added voiceover (`voiceover: "none"`): the footage's
  own sound carries it.
- Music only under stretches without speech, ducked under any speech.

## Understanding the footage (plan phase)
1. import_media the source (absolute path), then place nothing yet — just the bin.
2. If it has speech: transcribe it (local engine), then read get_transcript in the compact
   phrases view. This is your main map of the content.
3. detect_scenes for the shot structure; activity() over the whole length to find visual and
   loudness peaks.
4. frames() — sample "changes" across the whole source, then `at:[…]` on candidate moments — to
   see what is actually on screen. Look before you choose; a great line over a black frame is not
   a highlight.
5. Choose 4–8 moments. A good moment is self-contained (makes sense without what came before),
   has energy or a payoff, and starts and ends on a clean boundary: between words for speech, on
   a cut or a still moment for visuals.

In the storyboard, each scene is one moment: `sourceRefs` carries the exact source in/out times
(seconds), `narration` stays empty, `onScreenText` carries the hook/title text, and `visuals`
says how it is framed.

## Story shape
1. **Hook** (first 2–3 s): the strongest moment or line, with a short punchy title on top.
2. **Body**: the remaining moments in an order that builds — chronological unless a different
   order makes a better arc.
3. **Payoff / end**: the best remaining moment, ideally one that loops back to the hook.

## Look and feel
- Cuts are hard cuts by default; at most one or two quick transitions for real changes of place
  or time.
- Vertical from landscape: auto_reframe so the subject stays in frame.
- Captions from the transcript, 1–4 words at a time, large and centred in the lower third, in a
  bold readable preset (list_text_presets: pick a karaoke or high-contrast pack). Apply one style
  to all of them (apply_text_style_to_all).
- Hook title: big, 2–6 words, animated in, gone after 2–3 seconds.
- Music: market_search for a track that fits (if the marketplace is available), duck_under the
  speech, snap cuts to the beat (detect_beats, snap_clips_to_beats) only where it doesn't clip
  words.

## Building notes
- Place each moment from the bin and trim to its exact source range (set_trim, or keep_ranges /
  assemble from the transcript for speech).
- Close gaps so the reel plays continuously.
- Normalise loudness so cuts don't jump in volume (normalize_volume).
- Verify with frames at every cut, and read the transcript of the assembled timeline
  (get_transcript with start/end) to make sure no cut lands mid-word.
