# `@threecrowco/dither-image`

A hover/focus-triggered ordered-dither ("halftone") image effect, rendered
with raw WebGL (no three.js/ogl/postprocessing) directly onto a `<canvas>`.
It's a port of [darkroomengineering/spargo](https://github.com/darkroomengineering/spargo)'s
ordered-dithering postprocessing shader, adapted to a self-contained
single-image React component: the source image loads into a texture, and on
hover/focus it crossfades from the clean image into a 1-bit dithered look
driven by a small threshold matrix (or per-pixel noise, in `RANDOM` mode).

Zero dependencies beyond React (peer dependency only). Works in any
React 18+ app — Next.js App Router (`"use client"` is already set on the
component), Pages Router, Vite, CRA, etc.

## Install

Not published to npm — install directly from GitHub:

```json
{
  "dependencies": {
    "@threecrowco/dither-image": "github:threecrowco/dither-image#v0.1.0"
  }
}
```

then `pnpm install` / `npm install` / `yarn install`. Pin to a tag (not
`#main`) so updates to this package don't silently change what you resolve.

## Props

| Prop | Type | Default | Description |
|---|---|---|---|
| `src` | `string` | — (required) | Image URL to render. |
| `alt` | `string` | — (required) | Accessible label (the canvas has no real `<img>`, so this becomes `aria-label`). |
| `width` | `number` | — (required) | Rendered width in px. |
| `height` | `number` | — (required) | Rendered height in px. |
| `mode` | `DitherMode` | `"BAYER_4x4"` | Dither pattern — one of 18 fixed matrices, or `"RANDOM"` for per-pixel noise. See [Modes](#modes) below. |
| `granularity` | `number` | `2` | Size (px) of each dithered "block" — bigger = chunkier pattern. |
| `color` | `[number, number, number]` | `[1, 1, 1]` | RGB (0..1 each) tint applied to "on" dither pixels. |
| `duration` | `number` | `250` | Hover/focus crossfade duration in ms. Respects `prefers-reduced-motion` (snaps instantly instead of animating). |
| `className` | `string` | — | Passed through to the underlying `<canvas>`. |

`DitherImageProps`, `DitherMode`, `DithererName`, and `Ditherer` are all
exported for consumers who want to type their own wrapper components (e.g. a
mode picker — see [Usage](#usage)).

## Modes

19 selectable `mode` values: 18 fixed dither matrices ported from spargo,
plus `RANDOM` (no fixed matrix — a fresh pseudo-random threshold per pixel,
per frame). All are exported as keys of `ORDERED_DITHERERS` (plus the
literal `"RANDOM"`).

| Group | Modes |
|---|---|
| Bayer | `BAYER_2x2`, `BAYER_4x4`, `BAYER_8x8` |
| Dot | `DOT_4x4`, `DOT_6x6`, `DOT_6x6_2`, `DOT_6x6_3`, `DOT_8x8` |
| Directional | `VERTICAL_5x3`, `HORIZONTAL_3x5` |
| Diagonal / spiral | `DOT_DIAGONAL_6x6`, `DOT_DIAGONAL_8x8`, `DOT_DIAGONAL_8x8_2`, `DOT_DIAGONAL_8x8_3`, `DOT_DIAGONAL_16x16`, `DOT_SPIRAL_5x5`, `DOT_HORIZONTAL_6x6`, `DOT_VERTICAL_6x6` |
| Noise | `RANDOM` (per-pixel pseudo-random threshold, no fixed matrix) |

Bayer matrices give the most evenly-spaced, classic "ordered dither" look.
Dot matrices cluster values so the result reads like a halftone print (dots
that grow/shrink rather than an even scatter). Directional matrices
(`VERTICAL_5x3`, `HORIZONTAL_3x5`) are non-square and bias the pattern along
one axis. Diagonal/spiral matrices angle or swirl the clustering. `RANDOM`
has no repeating tile at all — every pixel gets an independent threshold, so
the result looks like static/noise rather than a structured pattern.

## How it works

**Ordered dithering** fakes greyscale on a 1-bit (on/off) display by turning
pixels on or off according to a small, fixed, repeating grid of threshold
numbers tiled across the screen. A pixel turns "on" wherever the source
image's brightness clears its cell's threshold. Since brighter regions clear
more thresholds than darker ones, brighter areas end up with denser "on"
pixels and darker areas end up sparser — from normal viewing distance the
eye blends this density gradient into a shade of grey, the same trick a
newspaper halftone photo uses with dot size.

Rather than hardcoding one matrix as GLSL math, the chosen matrix is
rendered into a tiny grayscale image — one pixel per matrix cell, value
normalized to `matrix[i] / max` — and uploaded as a small GPU texture (see
`buildMatrixTexture` in `src/dither-image.tsx`). The fragment shader
(`src/shader.ts`) then just samples that texture per pixel, tiling it across
the screen with `mod()`, instead of branching on matrix size or values. This
means switching `mode` is "upload a different tiny image" rather than
"recompile a different shader" — any matrix size (2x2 up to 16x16 here) is
handled identically by the same shader code. The texture is uploaded with
`NEAREST` filtering (not `LINEAR`) so each texel maps to exactly one matrix
cell — interpolating between cells would blur the threshold values and
break the effect.

## Usage

Fixed mode:

```tsx
import { DitherImage } from "@threecrowco/dither-image";

<DitherImage
  src="/photo.jpg"
  alt="A photo"
  width={320}
  height={320}
  mode="DOT_DIAGONAL_8x8"
  granularity={3}
/>;
```

Interactive mode picker — build your own small Client Component using the
exported types and `ORDERED_DITHERERS`:

```tsx
"use client";

import { useState } from "react";
import { DitherImage, ORDERED_DITHERERS, type DitherMode } from "@threecrowco/dither-image";

const MODES: DitherMode[] = [...Object.keys(ORDERED_DITHERERS), "RANDOM"] as DitherMode[];

export function DitherImageDemo({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) {
  const [mode, setMode] = useState<DitherMode>("BAYER_4x4");

  return (
    <div>
      <DitherImage src={src} alt={alt} width={width} height={height} mode={mode} />
      <select value={mode} onChange={(e) => setMode(e.target.value as DitherMode)}>
        {MODES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  );
}
```

A picker like this isn't shipped as part of the package itself — the styling
choices (a plain `<select>` above) are the kind of thing every consuming
project will want to own, not inherit from a dependency.

## Attribution

Dither matrix data and the ordered-dithering shader concept are ported from
[darkroomengineering/spargo](https://github.com/darkroomengineering/spargo)
(MIT licensed). This component reimplements the effect with raw WebGL only —
no three.js, ogl, or postprocessing dependency. See [LICENSE](./LICENSE).
