# videojs-overtone

A [video.js](https://videojs.com/) 8.5+ plugin for
[Overtone captions](https://github.com/lonthq/overtone-captions/blob/main/docs/format/spec.md) (`.overtone.json`).
It shows the line cut made for the shape of the visible picture.

- **A cut per picture shape.** The player picks the profile whose `aspect` is closest to the visible picture and
  switches live on resize, fullscreen and a new video size. Text size follows the profile's line length.
- **Style packs.** Words marked `key`, `brand`, `number`, `emphasis` or `soft` are styled by `clean` (default),
  `social`, `high-contrast`, `minimal`, `lumora`, or your own CSS.
- **One captions button.** It and the <kbd>C</kbd> key cycle off → styled → plain; the choice is remembered.
- **iOS native fullscreen.** Plain WebVTT fallback tracks per profile.

[Live demo](https://overtone.lont.ai/) · [Style gallery](https://overtone.lont.ai/styles/)

## Install

```bash
npm install video.js videojs-overtone
```

`video.js` is a peer dependency. `overtone-format` comes with the plugin.

## Usage

```js
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import 'videojs-overtone';                     // registers the 'overtone' plugin
import 'videojs-overtone/themes/base.css';     // layout and CSS variables, always needed
import 'videojs-overtone/themes/clean.css';    // one file per style pack you use
import 'videojs-overtone/themes/social.css';   // for setTheme('social') below

const player = videojs('my-video');
const captions = player.overtone({
  src: 'clip.overtone.json',   // or data: { …document… }
  theme: 'clean',
  fallbackTracks: { horizontal: 'clip.horizontal.vtt', vertical: 'clip.vertical.vtt' },
});

await captions.ready;          // resolves after loading, also when loading failed
if (captions.error) console.warn('no Overtone captions:', captions.error.message);
captions.setTheme('social');
captions.cycle();              // same as clicking the captions button
```

Without a bundler, load video.js, then `dist/index.global.js` (it uses the global `videojs` and exposes
`window.OvertoneVideojs`) and the CSS from `dist/themes/`, for example from
`https://cdn.jsdelivr.net/npm/videojs-overtone@0.1.0/`. A complete page:
[examples/cdn/index.html](https://github.com/lonthq/overtone-captions/blob/main/examples/cdn/index.html).

## Options

| Option | Default | Meaning |
|---|---|---|
| `src` / `data` | none | URL of the `.overtone.json` file, or the document itself. One is required. |
| `profile` | `'auto'` | `'auto'` picks the profile closest to the visible picture (the player box with `object-fit: cover` or `fill`). A profile id the document has is used as is; otherwise `'auto'` applies. |
| `theme` | `'clean'` | Style pack name |
| `speakers` | `'never'` | Speaker names: `'never'`, `'change'` or `'always'` |
| `fallbackTracks` | `{}` | Profile id → `.vtt` URL, for iOS native fullscreen |
| `storageKey` | `'overtone-caption-mode'` | `localStorage` key for the caption mode |
| `defaultMode` | `'styled'` | Mode when nothing is stored: `'off'`, `'styled'` or `'plain'` |

`player.overtone()` returns a controller with `getMode()`, `setMode(mode)`, `cycle()`, `setTheme(name)`,
`getProfileId()`, `dispose()`, a `ready` promise and an `error` field. The player fires `overtone:modechange`
(with `event.mode`) when the mode changes.

An invalid or missing document never throws. It is logged and reported in `error`, and video.js's own captions
button comes back for the page's `<track>` captions. After a successful load, the plugin turns off the page's
showing caption tracks so captions are not doubled; `dispose()` restores them.

## Picture and text size

Captions sit on the visible picture, not the whole player. A `.ot-picture` element wraps the caption layer
(`.ot-layer`) and is the CSS size container, so `cqw` units and `--ot-bottom` are relative to the picture.

The font size is `calc(var(--ot-font-size) * 42 / var(--ot-chars) * var(--ot-scale))`. The player sets
`--ot-chars` to the profile's `maxCharsPerLine`, so a full line spans the same share of the picture in every
profile. Profiles with an aspect below 1 add the class `ot-tall` to the layer.

## Without video.js

`videojs-overtone/core` renders captions without video.js, for a headless browser or your own player:
`cueIndexAt`, `cueIndexWithHold`, `CUE_HOLD_SECONDS`, `applyProfileToLayer`, `classToken`, `pictureRect`,
`chooseProfile`, `renderCue`, `shouldShowSpeaker`, `turnOf`, `updateActiveWords`, `wordsOf`, `isInWindow` and their
types. The main entry exports the plugin (`overtonePlugin`, `registerOvertone`), `OvertoneController`,
`OvertoneCaptionsButton` and the option types. The `<script>` bundle has both.

## Documentation

- [Player guide](https://github.com/lonthq/overtone-captions/blob/main/docs/player.md): behavior, theming, every
  CSS variable
- [Make a style pack](https://github.com/lonthq/overtone-captions/blob/main/docs/contributing/style-packs.md)
- [Format specification](https://github.com/lonthq/overtone-captions/blob/main/docs/format/spec.md)
- [`overtone-captions`](https://github.com/lonthq/overtone-captions/tree/main/packages/cli): the CLI that makes
  `.overtone.json` files

MIT licensed.
