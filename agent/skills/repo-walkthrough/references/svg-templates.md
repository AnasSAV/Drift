# SVG templates for repo walkthroughs

Fill these in and pass the SVG text to `add_svg`. All are self-contained: no external fonts, images
or CSS files. They are drawn for a 1920x1080 canvas; for 1080x1920 keep the same card sizes and
stack them vertically.

## Palette

| Role | Hex |
| --- | --- |
| Background | `#0f1117` |
| Card | `#181b24` |
| Card border | `#2a2f3d` |
| Text | `#e6e8ee` |
| Muted text | `#8b92a5` |
| Accent (keywords, highlights) | `#7aa2f7` |
| Accent 2 (strings) | `#9ece6a` |
| Accent 3 (numbers, warnings) | `#ff9e64` |
| Comments | `#5c6370` |

Monospace stack: `font-family="JetBrains Mono, Cascadia Code, Consolas, Menlo, monospace"`.
Sans stack: `font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif"`.

## Background (full canvas, lowest track)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080" width="1920" height="1080">
  <defs>
    <radialGradient id="g" cx="30%" cy="20%" r="90%">
      <stop offset="0" stop-color="#171b26"/>
      <stop offset="1" stop-color="#0f1117"/>
    </radialGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#g)"/>
</svg>
```

## Code card

One `<tspan>` per token colour. Line height 44 px at font-size 30. Escape `<`, `>` and `&` in
code as `&lt;`, `&gt;`, `&amp;`. Size the card height to the line count: 120 + 44 × lines.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400 600" width="1400" height="600">
  <rect x="2" y="2" width="1396" height="596" rx="20" fill="#181b24" stroke="#2a2f3d" stroke-width="2"/>
  <circle cx="44" cy="44" r="9" fill="#ff5f56"/>
  <circle cx="74" cy="44" r="9" fill="#ffbd2e"/>
  <circle cx="104" cy="44" r="9" fill="#27c93f"/>
  <text x="140" y="53" font-family="JetBrains Mono, Cascadia Code, Consolas, Menlo, monospace"
        font-size="24" fill="#8b92a5">src/engine/render.ts</text>
  <g font-family="JetBrains Mono, Cascadia Code, Consolas, Menlo, monospace" font-size="30">
    <text x="48" y="130"><tspan fill="#5c6370">1 </tspan><tspan fill="#7aa2f7">export function</tspan><tspan fill="#e6e8ee"> render(frame) {</tspan></text>
    <text x="48" y="174"><tspan fill="#5c6370">2 </tspan><tspan fill="#e6e8ee">  const out = </tspan><tspan fill="#7aa2f7">compose</tspan><tspan fill="#e6e8ee">(frame.layers);</tspan></text>
    <text x="48" y="218"><tspan fill="#5c6370">3 </tspan><tspan fill="#7aa2f7">  return</tspan><tspan fill="#e6e8ee"> out;</tspan></text>
    <text x="48" y="262"><tspan fill="#5c6370">4 </tspan><tspan fill="#e6e8ee">}</tspan></text>
  </g>
</svg>
```

Line-highlight bar (separate clip, placed over the card and keyframed down line by line):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1360 44" width="1360" height="44">
  <rect width="1360" height="44" rx="6" fill="#7aa2f7" fill-opacity="0.16"/>
  <rect width="6" height="44" fill="#7aa2f7"/>
</svg>
```

## Terminal card

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1400 360" width="1400" height="360">
  <rect x="2" y="2" width="1396" height="356" rx="20" fill="#0b0d12" stroke="#2a2f3d" stroke-width="2"/>
  <text x="48" y="56" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif" font-size="22" fill="#8b92a5">Terminal</text>
  <g font-family="JetBrains Mono, Cascadia Code, Consolas, Menlo, monospace" font-size="32">
    <text x="48" y="140"><tspan fill="#9ece6a">$ </tspan><tspan fill="#e6e8ee">git clone https://github.com/owner/project</tspan></text>
    <text x="48" y="196"><tspan fill="#9ece6a">$ </tspan><tspan fill="#e6e8ee">npm install</tspan></text>
    <text x="48" y="252"><tspan fill="#9ece6a">$ </tspan><tspan fill="#e6e8ee">npm start</tspan></text>
  </g>
</svg>
```

## Architecture box and arrow

Draw each component as its own clip when they should appear one by one. Box: 360x150, label
centred, optional one-line role under it.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 150" width="360" height="150">
  <rect x="2" y="2" width="356" height="146" rx="18" fill="#181b24" stroke="#7aa2f7" stroke-width="3"/>
  <text x="180" y="70" text-anchor="middle" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif"
        font-size="36" font-weight="700" fill="#e6e8ee">Engine</text>
  <text x="180" y="112" text-anchor="middle" font-family="Inter, Segoe UI, Helvetica, Arial, sans-serif"
        font-size="24" fill="#8b92a5">decode · compose · encode</text>
</svg>
```

Arrow (horizontal, 240 px; rotate with the clip transform for other directions):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 40" width="240" height="40">
  <line x1="4" y1="20" x2="212" y2="20" stroke="#8b92a5" stroke-width="4" stroke-linecap="round"/>
  <path d="M206 6 L236 20 L206 34 Z" fill="#8b92a5"/>
</svg>
```

Layout for 3–5 components on 1920x1080: a single row at y≈450 with 120 px gaps, or two rows
(y≈300 and y≈620) when there are more than four. Keep everything within 96 px of the edges.
