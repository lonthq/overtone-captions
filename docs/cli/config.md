# Configuration

The config file, profiles, rule sets and the request cache. Commands and flags: [CLI reference](reference.md).

## Config file

`overtone.config.json` in the current folder, or `--config <path>`. Optional, but with `--config` the file must
exist. [`overtone init`](reference.md#overtone-init) writes one with today's defaults pinned.

```json
{
  "llm": "anthropic",
  "glossary": ["DriveCover", "Lumora"],
  "speakers": { "S1": "Maya", "S2": "Tom" },
  "profileRules": {
    "vertical": { "rules": { "maxCharsPerLine": 20 } },
    "square": { "description": "Square feed", "aspect": "1:1", "rules": { "maxCharsPerLine": 30, "maxLines": 3, "maxCps": 15 } }
  },
  "styling": { "maxStyledRatio": 0.15, "maxKeyPerCue": 1 },
  "edits": { "maxSpan": 6 },
  "effort": { "corrections": "medium", "styling": "low", "linebreaks": "low" },
  "rules": "1",
  "languages": { "nl": { "llm": "anthropic" } },
  "cacheDir": ".overtone"
}
```

- Precedence: flags, then the file, then the defaults. The `--no-…` flags turn off a `true` from the
  file.
- Paths in the file are relative to the file; paths on the command line to the current folder.
- A value of the wrong type fails with a message naming the field.
- An unknown key is ignored with a warning that suggests the closest known key
  (`unknown key "chunkMB" is ignored (did you mean "chunkMb"?)`). Keys starting with `$` (`$comment`, `$schema`)
  are never reported.
- `transcribe` reads every key. `recut` reads `profiles`, `profileRules`, `rules`, `export`, `out`, `language`,
  `speakers`, `glossary` and `styling.maxKeyPerCue`. `export` and `burn` read no config file.

### Keys

Keys that match a `transcribe` flag:

| Key | Flag | Type |
|---|---|---|
| `text`, `timing`, `llm` | `--text`, `--timing`, `--llm` | `"provider[:model]"` |
| `timingSecondOpinion` | `--timing-second-opinion` | `"auto"` (default), `"none"` or `false`, or a provider |
| `local` | `--local` | boolean. Uses the [local mode](providers.md#local-mode) providers for every role that `text`, `timing` or `llm` leave unset |
| `context`, `contextFile` | `--context`, `--context-file` | string |
| `inferContext` | `--no-infer-context` | boolean (default `true`) |
| `llmLinebreaks` | `--llm-linebreaks` | boolean (default `false`) |
| `rules` | `--rules` | `"latest"` (default) or a [rule set](#stable-output-rule-sets) id |
| `twoPass` | `--two-pass` | boolean |
| `glossary` | `--glossary` | a file path, or the list of terms |
| `speakers` | `--speakers` | `"S1=Maya,S2=Tom"` or `{ "S1": "Maya" }` |
| `language` | `--language` | a code, `"auto"`, or candidates as `"en,es"` or `["en", "es"]` ([Mixed-language media](languages.md#mixed-language-media)) |
| `profiles` | `--profiles` | `"horizontal,1:1"` or a list ([Profiles](#profiles)) |
| `export` | `--export` | `"json,vtt"` or a list |
| `numbers`, `currency`, `styleGuide` | `--numbers`, `--currency`, `--style-guide` | string |
| `out` | `--out` | folder |
| `markUncertain` | `--mark-uncertain` | boolean |
| `normalizeLoudness` | `--normalize-loudness` | boolean |

No config key: `--from-stage`, `--no-cache`, `--text-file`, `--dry-run`, `--burn-style`, `--burn-speaker-names`,
`--burn-font`, `--config`.

Keys without a flag:

| Key | Meaning |
|---|---|
| `profileRules.<id>` | Overrides a built-in profile or defines one ([Profiles](#profiles)). Fields: `description`, `aspect` (`"W:H"`), `rules` (`maxCharsPerLine`, `maxLines`, `maxCps`, `minDuration`, `maxDuration`), and `window` (`{ "start": 0, "end": 30 }`, seconds) to limit when the profile's captions show. `minDuration` may not exceed the resolved `maxDuration` |
| `styling.maxStyledRatio` | Share of words that may be styled, 0 to 1 (default 0.15) |
| `styling.maxKeyPerCue` | `key` phrases per cue (default 1) |
| `edits.maxSpan` | Longest edit in words (default 6) ([The editor](pipeline.md#the-editor)). `edits.minSimilarity` is ignored with a warning |
| `effort` | Reasoning effort per step: `corrections` (default `medium`), `styling` (`low`), `linebreaks` (`low`); each `low`, `medium` or `high` ([Speed and cost](pipeline.md#speed-and-cost)) |
| `languages.<code>` | `text`, `llm` and `effort` per language ([Per-language defaults](languages.md#per-language-defaults)) |
| `chunkMb` | Upload chunk size for the text model, 1 to 25 MB (default 24; 25 MB is OpenAI's upload limit) |
| `cacheDir` | Cache folder (default `.overtone` in the current folder) ([Cache](#cache)) |

`local` and the role keys, strongest first: an explicit flag, `--local`, the file's `text`, `timing` and `llm`,
`"local": true`.

## Profiles

A profile cuts the same words into lines for one picture shape: an id, an `aspect` (`"W:H"`) and its rules. The
player shows the profile whose aspect is closest to the visible picture. Built in: `horizontal` (16:9, 42
characters per line) and `vertical` (9:16, 22). The names have no special meaning in the document.

```bash
overtone transcribe talk.mp4 --profiles horizontal,1:1,4:5
```

- An aspect becomes the profile id `<W>x<H>`, reduced: `1:1` and `2:2` are both `1x1`. `1x1` also works as input,
  on `transcribe`, `recut`, `export` and `burn`.
- A profile defined in `profileRules` keeps its name, also one that looks like an aspect (`"2x2": { "aspect":
  "1:1" }`).
- A profile listed twice (`1:1,2:2`, `1:1,1x1`, `horizontal,horizontal`) is an error, also on `export`.
- An unknown name fails with the list of valid ones.
- An aspect's rules come from the [rule set](#stable-output-rule-sets): interpolated linearly in ln(aspect) between
  16:9 and 9:16, clamped outside. `maxLines` is 2 for all.

  | Aspect | Characters per line | `maxCps` | `minDuration` (s) | `maxDuration` (s) |
  |---|---|---|---|---|
  | 16:9 | 42 | 17 | 1 | 7 |
  | 4:3 | 37 | 16.5 | 0.95 | 6.5 |
  | 1:1 | 32 | 16 | 0.9 | 6 |
  | 4:5 | 28 | 15.61 | 0.86 | 5.61 |
  | 9:16 | 22 | 15 | 0.8 | 5 |

- `profileRules.<id>` overrides a built-in profile or defines a new one, which needs an `aspect`. Rule values given
  there win over derived ones. A new `aspect` for a built-in profile derives its rules from that aspect. An aspect
  in `--profiles` that conflicts with the profile's `profileRules` aspect is an error.

  ```json
  {
    "profiles": ["horizontal", "vertical", "square"],
    "profileRules": { "square": { "aspect": "1:1" } }
  }
  ```

- The video's own shape: without `--profiles` or a `profiles` key, `transcribe` on a video adds a profile for the
  video's shape when the defaults do not cover it. A 1:1 video gets `horizontal`, `vertical` and `1x1`;
  16:9, 21:9 and 9:16 videos add nothing. The log says `media is 1:1: adding profile 1x1 (32 characters per line)`.
  With `--export mp4`, the burn uses that profile.

## Stable output: rule sets

The same words, rule set and language pack data always give the same captions, also after a CLI upgrade. A rule set
is a versioned rule-based layout: where captions and lines break, how long a caption stays. Every document
records `meta.rules` (the rule set id) and `meta.languageData` (a fingerprint of the language pack data).

- Locked by a rule set: every threshold, cost and switch of line cutting and cue timing, the built-in profiles, the
  rules derived for any [aspect](#profiles), and the styling budget. `recut` of the same document gives the same
  captions.
- Not locked: the words. Transcription and LLM output (corrections, speaker labels, styling, `--llm-linebreaks`
  proposals) can vary between runs and model updates. Pin dated model ids where the provider has them (an Azure
  OpenAI deployment pins a model version) and keep the [cache](#cache). A changed language pack changes its
  language's layout; that shows as a new `meta.languageData` and a changelog line.
- Pin with `"rules": "1"` or `--rules 1` (on `transcribe` and `recut`). The default `"latest"` follows upgrades.
  `profileRules` apply on top of a rule set's profiles. An unknown id fails with the list of available ones.
- Every release keeps the earlier rule sets. A layout change goes into a new rule set, never a released one (golden
  tests guard each); the [changelog](../../CHANGELOG.md) says what changed.

| Rule set | Since | Rules |
|---|---|---|
| `1` | 0.1.0 | Hesitations from 0.4 s, weighted up to 0.6 s; a new caption at 1 s, always at 1.5 s; a line may end on a main-verb "have", "do" or "be" or on the subject of a question head; a caption too short to read stays up to 1.5 s longer, keeping 0.4 s of a pause of 1 s or more blank ([Line cutting](pipeline.md#line-cutting)) |

## Cache

Every provider request is cached: a run sends only requests not sent before, so a failed or repeated run continues
where it stopped. Each stage line says how many requests came from the cache:
`[2/6] transcribe: done in 0.1 s (all 3 provider requests from the cache)`.

Location: `.overtone/<media-hash>/` in the current folder (`cacheDir` moves it). The folder name is the first 16
hex digits of the media file's SHA-256.

| Contents | What |
|---|---|
| `extract.json`, `audio.wav`, `audio.mp3` | Extracted audio (WAV about 115 MB per hour, MP3 about 22 MB per hour) |
| `chunk-N.mp3` | Chunks of long media |
| `*.loudnorm.*`, `*.region-<start>-<end>.*` | Normalized copies and snippets that were sent |
| `requests/<role>-<key>.json` | One file per request: what its key was built from, and the answer |

A file's modification time is when it was last used.

A request's key holds the cache's format version, the provider and model, the provider's request settings, the
SHA-256 of the exact audio sent, the prompt, language(s) and glossary, and for an LLM request the system and user
prompt, the JSON schema and the effort.

- Provider settings in the key: Azure Speech's profanity mode; a fingerprint (not the address) of a custom
  `OPENAI_BASE_URL`, the Azure OpenAI resource and the Ollama host; `AZURE_OPENAI_API_VERSION`,
  `AZURE_OPENAI_TRANSCRIBE_MODEL`, `AZURE_OPENAI_TRANSCRIBE_KEYWORDS`; the `json_object` response format;
  `OLLAMA_NUM_CTX`, `OLLAMA_MAX_TOKENS`, `OLLAMA_THINK`; the whisper.cpp model file, `WHISPER_CPP_TDRZ`,
  `WHISPER_CPP_ARGS`.
- Not in the key: API keys, settings that do not change the answer (`AZURE_SPEECH_ENDPOINT`,
  `ELEVENLABS_BASE_URL`, timeouts, `WHISPER_CPP_THREADS`), the CLI version, usage. A model that changes behind the
  same undated name is not noticed; use `--from-stage` or `--no-cache`.

Every run recomputes everything that works only from cached answers (alignment, the vote's decisions, the editor's
checks, line cutting, export). Changing a threshold, language pack, rule set, profile or budget resends nothing,
unless it changes what a request sends. Changing the context resends the requests that hold it;
changing an effort resends only the LLM requests that use it. ElevenLabs Scribe ignores the prompt, so `--context`,
`--numbers`, `--style-guide` and `--two-pass` reuse its answer.

Extracted audio is reused while the file sizes match. A new CLI version extracts again; identical audio still reuses
every answer. The audio carries no metadata or ffmpeg version, so an ffmpeg upgrade gives the same bytes.

- `--from-stage <stage>` resends that stage's requests and all later ones (`--from-stage refine` asks the LLM
  again). `--from-stage extract` also extracts again. Which requests belong to which stage:
  [How the pipeline works](pipeline.md). New answers replace cached ones.
- `--no-cache` resends every request and extracts again. Answers are still written to the cache.
- Refusals are not cached.
- Disk and privacy: the answers hold the full transcript, and the folder is never cleaned up automatically. Delete
  it any time (`rm -rf .overtone`) and add it to `.gitignore`.
