# overtone-format

The reference implementation of the
[Overtone caption format](https://github.com/lonthq/overtone-captions/blob/main/docs/format/spec.md)
(`.overtone.json`): TypeScript types, a JSON Schema, a validator, and WebVTT, SRT and plain-text exporters. No
runtime dependencies. Runs in Node and the browser.

An Overtone file stores each spoken word once, with its time, speaker and optional semantic classes. **Profiles**
refer to those words to cut them into caption lines, one picture shape each. One file can hold a 16:9 cut (42
characters per line) and a 9:16 cut (22) of the same words.

## Install

```bash
npm install overtone-format
```

ESM only.

## Usage

```js
import { readFile, writeFile } from 'node:fs/promises';
import { assertValid, closestProfile, toSRT, toTranscript, toWebVTT, validate } from 'overtone-format';

// Returns the typed document, or throws one error that lists every issue.
const doc = assertValid(JSON.parse(await readFile('clip.overtone.json', 'utf8')));

await writeFile('clip.horizontal.vtt', toWebVTT(doc, 'horizontal'));               // <c.brand>…</c> spans
await writeFile('clip.plain.vtt', toWebVTT(doc, 'horizontal', { styled: false })); // same cues, no spans
await writeFile('clip.vertical.srt', toSRT(doc, 'vertical'));                      // plain text
await writeFile('clip.txt', toTranscript(doc));                                    // "Maya: …" paragraphs

// The profile whose aspect is closest to the picture (width / height).
const profile = closestProfile(doc.profiles, 1);

// Never throws: { valid, errors: [{ path, message }] }
const { valid, errors } = validate(somethingUntrusted);
```

- `toWebVTT` and `toSRT` throw for a profile id the document does not have. WebVTT cues start with a `<v Label>`
  voice tag. SRT has no styling or speaker names; `toSRT` writes `-->` as `→`, a tag-like `<i>` as `‹i>` and `{\`
  as `｛\`, so players show the text literally.
- For a profile with a `window`, the exporters drop cues outside it and clamp cues that cross its edges.
- `closestProfile(profiles, pictureAspect)` picks the smallest |ln(picture aspect) − ln(profile aspect)|, ties to
  the wider profile
  ([spec §14.3](https://github.com/lonthq/overtone-captions/blob/main/docs/format/spec.md#143-profile-selection)).
  `parseAspect("16:9")` returns `1.777…`; `ASPECT_PATTERN` is the pattern an aspect must match.
- Also exported: `toPlayerDocument` (the document without authoring data), the constants `STYLE_CLASSES`,
  `MATCH_KINDS`, `EDIT_REASONS` and `DEFAULT_PROFILES`, helpers such as `flattenWords`, `getProfile`,
  `findCueIndex` and `speakerLabel`, and the types (`OvertoneDocument`, `Word`, `Profile`, `Cue`, …).

## The format at a glance

This example validates:

```json
{
  "format": "overtone",
  "version": 1,
  "language": "en",
  "duration": 6.5,
  "speakers": [{ "id": "S1", "label": "Maya", "role": "host" }],
  "turns": [
    {
      "speaker": "S1", "start": 4.7, "end": 6.245,
      "words": [
        { "text": "With", "start": 4.7, "end": 4.96 },
        { "text": "DriveCover", "start": 4.99, "end": 5.561, "classes": ["brand"] },
        { "text": "from", "start": 5.591, "end": 5.85 },
        { "text": "Lumora,", "start": 5.881, "end": 6.245, "classes": ["brand"], "match": "edited" }
      ]
    }
  ],
  "profiles": [
    {
      "id": "horizontal",
      "aspect": "16:9",
      "rules": { "maxCharsPerLine": 42, "maxLines": 2 },
      "cues": [
        { "start": 4.7, "end": 6.245, "speaker": "S1",
          "lines": [{ "words": [0, 3], "text": "With DriveCover from Lumora," }] }
      ]
    },
    {
      "id": "vertical",
      "aspect": "9:16",
      "rules": { "maxCharsPerLine": 22, "maxLines": 2 },
      "cues": [
        { "start": 4.7, "end": 6.245, "speaker": "S1",
          "lines": [{ "words": [0, 1], "text": "With DriveCover" },
                    { "words": [2, 3], "text": "from Lumora," }] }
      ]
    }
  ],
  "edits": [{ "words": [3, 3], "from": "Lumorra,", "to": "Lumora,", "reason": "brand" }]
}
```

| Field | Meaning |
|---|---|
| `language`, `duration` | Language tag of the speech; media length in seconds |
| `speakers` | `id`, optional `label` (name) and `role` |
| `turns[].words` | `text` with punctuation, `start`/`end` in seconds, optional `classes`, `match` (`exact`, `fuzzy`, `split`, `merge`, `interpolated`, `edited`) and `confidence` (0–1) |
| `profiles` | `id` (free name), `aspect` (`"W:H"`), optional `description`, `rules` (`maxCharsPerLine`, `maxLines`, optional `maxCps`, `minDuration`, `maxDuration`), optional `window` (`{ start, end }`), `cues` |
| `cues[].lines` | Inclusive `[first, last]` word ranges and the derived `text` |
| `edits` | Optional record of accepted LLM changes: `words`, `from`, `to`, `reason` (`correction`, `brand`, `style`, `punctuation`, `split-word`) |
| `meta` | Optional: `title`, `context`, `style`, `models`, `generator`, `createdAt`, and run data the CLI writes ([CLI reference](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/reference.md)) |

The validator checks:

- Times are non-negative seconds with at most 3 decimals. Words in a turn are ordered and do not overlap.
- Words are numbered globally from 0, in turn order and then word order. A line's `text` equals its words joined
  by single spaces.
- `classes` come from a fixed set: `emphasis` (stressed), `key` (what to remember), `brand` (brand or product
  name), `number` (figures, prices, dates), `soft` (an aside).
- A cue never spans two speakers. Cues in a profile are ordered and never overlap.

Readers ignore unknown fields; breaking changes bump `version`. A complete file:
[examples/fixtures/sample.overtone.json](https://github.com/lonthq/overtone-captions/blob/main/examples/fixtures/sample.overtone.json).

## JSON Schema

```js
import schema from 'overtone-format/schema.json' with { type: 'json' };
```

The schema covers the structure. `validate()` also checks what a schema cannot express, such as word numbering,
line text and cue order
([spec, Appendix A](https://github.com/lonthq/overtone-captions/blob/main/docs/format/spec.md#appendix-a-json-schema-coverage)).

## Related

- [Format specification](https://github.com/lonthq/overtone-captions/blob/main/docs/format/spec.md)
- [`videojs-overtone`](https://github.com/lonthq/overtone-captions/tree/main/packages/videojs): the video.js
  plugin that plays these files
- [`overtone-captions`](https://github.com/lonthq/overtone-captions/tree/main/packages/cli): the CLI that makes
  them from subtitles, audio or video
- [Live demo](https://overtone.lont.ai/)

MIT licensed.
