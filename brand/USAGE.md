# ANX format — brand usage

The brand name is **ANX format**, always presented as one composite. Never crop, separate, downplay, recolor, or remove “format” to create standalone ANX text branding. No rights are asserted in bare “ANX”. The standalone document glyph is permitted.

## Assets and minimum sizes

- `anx-lockup.svg`: preferred introductory identity, mark + complete name. Minimum **180px wide**; recommended README width **264–330px**.
- `anx-wordmark.svg`: complete name without the glyph, for already identified contexts. Minimum **128px wide**. Never extract just the first three letters.
- `anx-mark.svg`: glyph only for repeated navigation or avatars where the full name is already supplied. Minimum **24 × 24px**.
- `anx-mark-micro.svg`: optically simplified glyph for **16–23px**, especially favicons. Two rows, enlarged spacing, pixel-aligned 1px strokes at 16px. Do not shrink the standard glyph to 16px. No use below 16px.
- `anx-lockup-light.svg` and `anx-lockup-dark.svg`: explicit foregrounds for image embedding on light and dark backgrounds respectively.

Keep proportions fixed. Leave clear space of at least one quarter of the glyph canvas height (16 units in the 64-unit design) around the lockup/mark. For the wordmark alone, leave half a capital-letter height. Do not add containers, pills, shadows, gradients, textures, or extra symbols.

## Color and type

Base shapes and all lettering use `currentColor`. The only accent is cyan **#06b6d4**, limited to the addressed branches/nodes; it never carries meaning by color alone. Light foreground: **#0f172a**; dark foreground: **#e6edf7**. Transparent surfaces; never use a low-contrast foreground/background combination.

For inline SVG, set `color` on its host. Override `--anx-accent` with `currentColor` for a completely monochrome identity; the variable deliberately has no hard-coded root declaration. A self-contained monochrome export can replace `var(--anx-accent, #06b6d4)` with `currentColor`. Do not introduce other accent colors.

The name is outlined from **Arial Regular**, 36 design units throughout, one weight, one baseline, modest uniform tracking. The delivered paths require no installed font, external resource, or font download. Keep the two words together at equal size and weight; the earlier contrasting X and expansion tagline are retired.

## GitHub README

External SVG images do **not** inherit the surrounding page's `color` or CSS variables. Use the explicit themed files (copy into the repository only when separately authorized):

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="anx-lockup-dark.svg">
  <img src="anx-lockup-light.svg" width="264" alt="ANX format">
</picture>
```

Glyph-only UI should have an accessible name “ANX format” unless decorative alongside equivalent text. SVGs already contain accessible titles/labels; use `alt="ANX format"` when embedding as images.

## Licence

The brand files in this directory are provided under the repository licence for referring to the ANX format. No rights are asserted in the bare word "ANX".
