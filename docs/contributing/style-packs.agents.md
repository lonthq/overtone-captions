# Style packs: instructions for AI agents

Background for humans: [style-packs.md](style-packs.md).

## Goal

Add or change one caption style pack (`<name>`) for videojs-overtone so that it passes every lint, contrast and
schema test and fits every line at 16:9, 1:1 and 9:16.

## Files to read

1. `packages/videojs/src/themes/base.css`: the layout and the default of every `--ot-*` variable.
2. `packages/videojs/styles/_template/style.css` and `pack.json`: every variable, commented.
3. `packages/videojs/styles/pack.schema.json`: the `pack.json` fields.
4. `packages/videojs/styles/social/style.css`: the pack with motion and joined key-word strips.
5. `packages/videojs/scripts/style-packs.mjs`: `LINT_RULES`, `lintStyle` and the contrast math, when a check is unclear.

## Files you may change

| Path | Action |
|---|---|
| `packages/videojs/styles/<name>/style.css` | Write |
| `packages/videojs/styles/<name>/pack.json` | Write |
| `packages/videojs/styles/<name>/preview.png` | Generate with `npm run styles:previews -- <name>`; never draw or edit it |
| `packages/videojs/styles/pack.schema.json` | Only to add a tag to the `tags` enum when none fits |
| `CHANGELOG.md` | A line under "Unreleased" for a new or changed pack |

Do not edit `_template/`, `base.css`, the build, the gallery (`examples/styles/`) or the demo. They discover packs from
the folder.

## Invariants

`npm run test:styles` enforces all of these except three you check yourself: the rounding of the `contrast` note,
the color formats of `--ot-pack-*` variables, and line fit (checked by `npm run styles:previews`).

- **Name**: matches `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, at most 32 characters, not `base` or `packs`, equal to the folder
  name and `pack.json`'s `name`.
- **Folder**: only `style.css`, `pack.json` and `preview.png` (PNG, at most 100 KB and 1000 px wide).
- **`pack.json`**: `name`, `title` (1–40 characters), `description` (20–240), `author`, `license: "MIT"`, `tags` (from
  the schema enum, at least one), `contrast` (20–300: how legibility is kept and the lowest ratio, rounded down to one
  decimal).
- **Scope**: every selector contains `.ot-theme-<name>` as a whole class and styles the layer or its descendants.
  Never `+` or `~` right after the scoped compound.
- **Plain mode**: a selector that mentions `.ot-emphasis`, `.ot-key`, `.ot-brand`, `.ot-number`, `.ot-soft` or
  `.ot-active` also contains `.ot-mode-styled`.
- **Custom properties**: only variables declared on `.ot-layer` in `base.css`, or `--ot-pack-*` names you declare.
  Set them only on `.ot-layer.ot-theme-<name>`, optionally with `.ot-tall` or one `.ot-profile-<id>`.
- **Colors**: in variables, hex, `rgb()`, `hsl()`, `transparent`, `black` or `white` only. In rules, `color`,
  `background`, `background-color`, `background-image` and `-webkit-text-fill-color` take only base variables or
  keywords (`transparent`, `inherit`, `currentColor`).
- **Contrast**: at least 4.5:1 for `--ot-color`, `--ot-speaker-color`, `--ot-emphasis-color`, `--ot-brand-color`,
  `--ot-number-color`, `--ot-soft-color` and `--ot-key-color`, in every layout (wide, tall, each targeted
  `.ot-profile-<id>`, each `@media` block that sets variables).
  - Box mode (`--ot-bg` alpha ≥ 0.6): measured against the box over white and over black; the worse result counts.
  - Outline mode (alpha < 0.6): `--ot-shadow` needs at least 2 layers with offset `0 0` and alpha ≥ 0.9; measured
    against their color.
  - `--ot-key-color` is measured against `--ot-key-highlight` when that is not transparent.
- **Classes**: in styled mode each class differs from plain text: emphasis (color or style), key (weight, color or
  highlight), brand (color or weight), number (color; `tabular-nums` alone does not count), soft (color).
- **Size**: `--ot-font-size` in `cqw`; `--ot-font-size` × `--ot-scale` ≥ 3.4cqw in wide, tall and each targeted
  profile.
- **Fonts**: `--ot-font` ends with a generic family (`sans-serif`, `serif`, `system-ui`, `monospace`, `ui-*`, …).
- **Not allowed**: `@import`, `url()`, `image-set()`, `@font-face`, at-rules other than `@media`, `@supports`,
  `@container` and `@keyframes ot-<name>-*`, nesting, `!important`, `position: fixed`, `z-index`, `display: none`,
  `visibility` other than `visible`, `opacity`, `font-size: 0`, `content` with text.
- **Motion**: every `transition*`, `animation`, `animation-name` (not `none`) and every `transform` on a selector with
  `.ot-active` has a rule with the identical selector inside `@media (prefers-reduced-motion: reduce)` that sets that
  property to `none`.
- **Line fit**: `npm run styles:previews` prints no `WRAPS` line.

## Steps

1. For a new pack: `cp -R packages/videojs/styles/_template packages/videojs/styles/<name>`, then replace every
   `my-pack` with `<name>` in both files.
2. Write `style.css`: variables on `.ot-layer.ot-theme-<name>`, tall values on `.ot-layer.ot-theme-<name>.ot-tall`.
   Delete the template's instruction comments; keep a one-line header saying what the pack is for.
3. Write `pack.json`.
4. Run `npm run test:styles` and fix every failure in the pack. To list every contrast ratio:

   ```bash
   node -e "import('./packages/videojs/scripts/style-packs.mjs').then((m) => { const fs = require('fs');
     const r = m.packContrast(fs.readFileSync('packages/videojs/src/themes/base.css', 'utf8'),
       fs.readFileSync('packages/videojs/styles/<name>/style.css', 'utf8'), '<name>');
     for (const v of r.variants) for (const c of v.checks) console.log(v.shape, v.profile ?? '-', c.label, c.fg, c.bg, c.ratio.toFixed(2)); })"
   ```

5. Put the lowest ratio in `pack.json`'s `contrast`.
6. Run `npm run styles:previews -- <name>` (it builds first; needs Chrome, or `CHROME_PATH`). It writes `preview.png`
   and prints line fit for that pack. On a `WRAPS` line, lower `--ot-scale` on `.ot-tall` within the size rule, or
   lighten the font.
7. Add the `CHANGELOG.md` line.
8. Run `npm test`, `npm run typecheck` and `npm run build`.

Common causes of failure: a translucent text color (the check measures the mixed color), a dark `--ot-key-color`
without an opaque `--ot-key-highlight`, `--ot-bg: transparent` with only a drop shadow, and `display: inline-block`
on `.ot-word` without social's `[data-joined]` rules (the key-word marker splits into boxes).

## Definition of done

- `npm run test:styles`, `npm test`, `npm run typecheck` and `npm run build` pass.
- `npm run styles:previews -- <name>` wrote `preview.png` and printed no `WRAPS`.
- `pack.json`'s `contrast` states the real lowest ratio, rounded down.
- `git status` shows only files from [Files you may change](#files-you-may-change).
