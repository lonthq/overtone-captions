# CLI reference

Every command, option, environment variable, output file and `meta` field of `overtone`. New to the CLI? Start
with the [CLI README](../../packages/cli/README.md). Other reference pages:

- [Configuration](config.md): config file, profiles, rule sets, cache.
- [Language](languages.md): codes, detection, mixed-language media, language packs, CMU Pronouncing Dictionary.
- [How the pipeline works](pipeline.md): hearings, text vote, editor, line cutting, speed, retries, refusals.
- [Provider details](providers.md): how each provider is called, Azure setup, local mode.

## Commands

| Command | What it does | API calls |
|---|---|---|
| [`transcribe <media>`](#overtone-transcribe-media) | Media in, `.overtone.json` and caption files out | yes |
| [`recut <file>`](#overtone-recut-file) | Re-cuts `.srt`, `.vtt` or `.overtone.json` into profiles | no |
| [`validate <file>`](#overtone-validate-file) | Checks a document against the format | no |
| [`export <file>`](#overtone-export-file) | Writes caption files from a document | no |
| [`burn <media> <document>`](#overtone-burn-media-document) | Writes a video with the captions burned in | no |
| [`init`](#overtone-init) | Writes `overtone.config.json` with today's defaults pinned | no |
| [`languages [code]`](#overtone-languages-code) | Lists language packs | no |
| [`providers [id]`](#overtone-providers-id) | Lists providers, roles, defaults, environment variables | no |

`overtone --version` prints the version. `overtone <command> --help` lists the options.

### `overtone transcribe <media>`

| Option | Default | Meaning |
|---|---|---|
| `--text <provider[:model]>` | `openai:gpt-transcribe` | Text provider ([text hearing](pipeline.md#hearings)) |
| `--timing <provider[:mode]>` | `azure-speech` (mode `fast`) | Timing and diarization provider, or `same` ([`--timing same`](#--timing-same)) |
| `--timing-second-opinion <provider>` | `auto` | Second hearing of the whole file. `auto`: `elevenlabs` when `ELEVENLABS_API_KEY` is set and it is not the timing or text provider; none with `--local` or `"local": true`. `none` (also `off`, `false`): none. Or a provider such as `elevenlabs`, other than the timing provider. `same` is rejected |
| `--llm <provider[:model]>` | `openai:gpt-6.1-sol` | LLM editor, also the text vote's chooser and context inference |
| `--local` | off | Local providers, no keys: `--text whisper-cpp:large-v3-turbo --timing same --llm ollama:qwen3:8b`. See [Local mode](providers.md#local-mode) |
| `--context <text>` | none | What the media is about. Sent to the text model, the chooser and the editor |
| `--context-file <path>` | none | File with the context text. `--context` wins |
| `--no-infer-context` | off | Without a context, do not infer one ([Context](pipeline.md#context)) |
| `--llm-linebreaks` / `--no-llm-linebreaks` | off | Also ask the LLM where captions and lines break ([LLM line cutting](pipeline.md#llm-line-cutting)) |
| `--rules <id>` | `latest` | Rule set for the layout, e.g. `1` ([rule sets](config.md#stable-output-rule-sets)) |
| `--text-file <path>` | none | Use this transcript as the text ([Your own transcript](#your-own-transcript---text-file)). Not with `--text` or `--two-pass` |
| `--two-pass` / `--no-two-pass` | off | Transcribe again with the inferred topic, names and terms in the prompt. Up to twice the transcription cost. No effect with a given context |
| `--glossary <path>` | none | One term per line; blank lines and lines starting with `#` are skipped |
| `--speakers <list>` | none | Pin speaker labels: `"S1=Sarah,S2=Tom"`. Wins over labels the LLM finds. Each id once, labels not empty |
| `--language <code>` | `auto` | Spoken language, or candidates for mixed-language media (`en,es`, first is main). See [Language](languages.md) |
| `--profiles <ids>` | `horizontal,vertical` | Profiles to cut: names and aspects (`horizontal,1:1,4:5`). Without this flag or a `profiles` list in the config file, a video also gets a profile for its own shape ([Profiles](config.md#profiles)) |
| `--export <formats>` | `json,vtt` | Any of `json`, `player`, `vtt`, `vtt-words`, `srt`, `txt`, `mp4` ([Output](#output)) |
| `--burn-style <name\|path>` | `clean` | With `mp4`: as `burn --style` |
| `--burn-speaker-names <when>` | `never` | With `mp4`: `never`, `change` or `always` |
| `--burn-font <file>` | the style's font | With `mp4`: as `burn --font` |
| `--numbers <style>` | `auto` | `digits`, `words` or `auto` |
| `--currency <style>` | `auto` | `symbol`, `code`, `words` or `auto` |
| `--style-guide <text>` | none | Free-text style rules for the editor |
| `-o, --out <dir>` | the input's folder | Output folder |
| `--mark-uncertain` / `--no-mark-uncertain` | off | Write `(??)` in VTT, SRT and TXT after unresolved words ([Uncertain words](pipeline.md#uncertain-words)) |
| `--normalize-loudness` / `--no-normalize-loudness` | off | Loudness-normalize the audio (EBU R128, ffmpeg `loudnorm`) before any provider hears it |
| `--from-stage <stage>` | none | Send the requests of this stage and later ones again: `extract`, `transcribe`, `timing`, `align`, `refine`, `export` ([Cache](config.md#cache)) |
| `--no-cache` | off | Send every request again and extract again |
| `--config <path>` | `./overtone.config.json` | Config file. Optional, unless you pass this flag |
| `--dry-run` | off | Print the plan and stop ([Dry run](#dry-run)) |

- A selection is `provider` or `provider:model`. Only the first `:` splits, so model names may contain colons
  (`ollama:llama3.1:8b`). The provider is case-insensitive; the model is not.
- The `--no-…` flags turn off a `true` from the config file.
- With `mp4`, these fail before the first paid call: media without a video stream, no Chrome, ffmpeg older than
  5.0, a bad `--burn-style` or `--burn-font`. With `--export mp4` alone the MP4 is the only file.

#### Dry run

Add `--dry-run` to the real run's flags (`overtone transcribe talk.mp4 --dry-run`) to print the plan as
`key: value` lines on stdout. It sends, extracts and writes nothing (no cache, no output), but runs the
`ffmpeg`/`ffprobe` checks and reads the media's length and shape.

| Line | Shows |
|---|---|
| `media`, `duration`, `video` | The input, its length and frame size (`none (audio only)`) |
| `config file`, `.env` | The files found (variable values are never printed) |
| `text`, `timing`, `second hearing`, `llm` | Providers after the config file, `--local` and `auto` are applied |
| `per-language` | [Per-language](languages.md#per-language-defaults) overrides, with their condition (`if the detected language is nl`) |
| `language`, `context` | What the run will use |
| `audio goes to`, `transcript goes to` | Each destination, marked `[cloud]` or `[local]` |
| `missing environment variables` | Names only |
| `not checked` | Local tools (whisper.cpp, Ollama), Chrome and ffmpeg 5.0+ for `mp4` |
| `profiles`, `outputs` | Profiles (and one added for the media's shape) and every file path |
| `cache` | The cache folder |
| `estimated cost` | List-price estimate for the measured setups (the default, with or without the ElevenLabs second hearing, also on Azure OpenAI deployments named after the default models). Local runs are $0 |
| `runnable` | `yes` when every checked prerequisite passed |

A failed check (missing keys, no ffmpeg, media over 2 hours, `mp4` without video) exits with 1 after the plan,
printing the error the real run would give. A bad flag, config value or media path fails before any plan.

### `overtone recut <file>`

Re-cuts `.srt`, `.vtt` or `.overtone.json` into the profiles' layouts, offline: no providers, keys or ffmpeg.
Never overwrites its input. How it reads input: [Re-cut existing subtitles](#re-cut-existing-subtitles).

| Option | Default | Meaning |
|---|---|---|
| `--profiles <ids>` | `horizontal,vertical` | Names and aspects, as for `transcribe` |
| `--export <formats>` | `json,vtt,srt,txt` | As for `transcribe`, without `mp4` (use [`burn`](#overtone-burn-media-document)) |
| `-o, --out <dir>` | the input's folder | Output folder |
| `--language <code>` | the config file's `language`, else the document's, else detected, else `und` | Language for the line-break rules |
| `--speakers <list>` | none | Speaker labels; win over names in the file |
| `--glossary <path>` | none | Terms never split across lines |
| `--rules <id>` | `latest` | Rule set |
| `--config <path>` | `./overtone.config.json` | Config file ([which keys apply](config.md#config-file)) |

An `mp4` in the config file's `export` is skipped with a note; when it was the only format, `recut` writes
`json,vtt,srt,txt`.

### `overtone validate <file>`

Checks a document against the format. A valid one prints on stdout:

```
talk.overtone.json: valid (312 words, 14 turns, cues: horizontal 48, vertical 71)
```

Exit code 1 for an invalid file, which prints `<file>: invalid (N issues)` and one indented `<path>: <message>`
line per issue, and for a missing, unreadable or non-JSON file, which prints `error: …` on stderr.

### `overtone export <file>`

Writes files from a document. Does not read the config file.

| Option | Default | Meaning |
|---|---|---|
| `--export <formats>` | `vtt,srt,txt` | As for `transcribe`, without `mp4` (use [`burn`](#overtone-burn-media-document)) |
| `--profiles <ids>` | every profile in the file | Profiles of the file to write |
| `-o, --out <dir>` | the input's folder | Output folder |
| `--mark-uncertain` | off | As for `transcribe` |

Never overwrites its input: a `json` output to the input's path is skipped with a warning; any other output to that
path stops the command before anything is written.

### `overtone burn <media> <document>`

Burns the captions into a video, with no API calls. It draws them with the code and CSS of the
[video.js player](../../packages/videojs), so [style packs](../contributing/style-packs.md) and their animations
look the same, frame-exact.

```bash
overtone burn talk.mp4 talk.overtone.json --style social -o talk.captioned.mp4
```

| Option | Default | Meaning |
|---|---|---|
| `--style <name\|path>` | `clean` | A built-in pack (`clean`, `high-contrast`, `lumora`, `minimal`, `social`) or a pack's `style.css`. The file must be self-contained: no `@import`, no remote `url()` |
| `--profile <id>` | the profile closest to the video's aspect | Profile to burn. When none fits, `burn` warns and prints a `recut` command that adds one |
| `--mode <mode>` | `styled` | `styled` shows the semantic classes; `plain` does not |
| `--speaker-names <when>` | `never` | `never`, `change` or `always` |
| `--font <file>` | the style's font | `.woff2`, `.woff`, `.ttf` or `.otf`. A custom pack that sets `font-family` on its own elements can override it |
| `-o, --out <file\|dir>` | `<media name>.captioned.mp4` next to the media | `.mp4`, `.mov` or `.m4v`. A folder, or a path ending in `/`, gets the default name inside it. Never the media file |

- Needs ffmpeg 5.0 or later, `ffprobe`, and Google Chrome or Chromium (found on macOS, Linux and Windows;
  `CHROME_PATH` for another binary). Nothing is downloaded.
- Video: the source frame size after rotation (odd sizes get one pixel of padding), H.264 at CRF 18. Non-square
  pixels are not corrected. Cover art before the video stream is skipped.
- Audio: the first audio track. `.mp4` and `.m4v` copy AAC and re-encode anything else to AAC at 192 kbit/s, since
  many players play no sound from MP3, Opus or FLAC in an MP4. `.mov` also copies MP3, ALAC, AC-3 and E-AC-3.
- Fonts: styles use system fonts, so output can differ between machines unless you pass `--font`.
- Speed: one Chrome screenshot (about 50 ms) per caption change, plus one per frame (at most 60 per second) while a
  caption animates.
- Ctrl-C or SIGTERM stops Chrome and ffmpeg and removes the frames and the partial video.

### `overtone init`

Writes `overtone.config.json` in the current folder with today's defaults pinned: `"rules": "1"`, the default
`text`, `timing` and `llm`, `llmLinebreaks: false`, and the built-in profiles in `profileRules`. `$comment` lines
explain each pin. OpenAI has no dated ids for `gpt-transcribe` and `gpt-6.1-sol` yet; pin them once they exist.
`profiles` is not pinned, so a video still gets a profile for its own shape. `--force` overwrites an existing file.

### `overtone languages [code]`

Lists the language packs and their coverage (detection, line cutting, numbers); with a code, every field of that
pack. See [Language packs](languages.md#language-packs).

### `overtone providers [id]`

Lists providers with roles and default models; with an id, every environment variable of that provider: required
or optional, secret or not.

## Re-cut existing subtitles

### Subtitle files

How `recut` reads `.srt` and `.vtt`:

- Encoding: UTF-8, or UTF-16 with a byte order mark. Invalid UTF-8 is read as Windows-1252, with a warning.
- Text: markup is removed (`<i>`, `<font>`, `<c.class>`, inline timestamps, `{\an8}`), HTML entities are decoded,
  and a cue's lines are joined. CRLF, the WebVTT header, `NOTE`, `STYLE` and `REGION` blocks, cue identifiers and
  cue settings are accepted. Blocks without a readable timing line or text are skipped with a warning.
- Word times are estimated: each cue's span is spread over its words by length, and the time between cues stays a
  pause. Every word gets an [unknown time](pipeline.md#unknown-times) (`"match": "interpolated"`, confidence 0).
  The document records `meta.source` (`srt` or `vtt`) and `meta.timing: "estimated-from-cues"`. For real word
  times, use [`--text-file`](#your-own-transcript---text-file) with the media.
- Speakers come from the first source the file uses:
  1. WebVTT voice tags (`<v Sarah>`);
  2. `NAME:` at the start of a line. An all-caps name (`SARAH:`, `DR. LEE:`) always counts; a capitalized one
     (`Sarah:`) only when at least two names each start at least two lines;
  3. dialogue dashes (a cue with two or more lines starting with `-`): each dashed line after the first switches
     between two unnamed speakers.

  Otherwise there is one speaker. A speaker change always starts a new caption.
- Without voice tags or `NAME:` prefixes, a cue that ends a sentence (`.`, `!`, `?`, `…`) or breaks off (`could-`,
  `—`) also ends a caption. A cue that opens with an ellipsis (`...but`) may join the caption before it. The
  document does not record these breaks, so re-cut the subtitle file, not a document written from it.
- Language: `--language` (or the config file's `language`), else detected from the text, else `und`.

### Overtone documents

An `.overtone.json` input keeps its words and times, speakers, edits and classes (at most `styling.maxKeyPerCue`
key phrases per new caption). Only the profiles are replaced, and `meta.linebreaks` becomes `rules`. Pass `--out`
to write the new document, since the input is never overwritten.

### Your own transcript (`--text-file`)

`overtone transcribe <media> --text-file <file>` uses your transcript as the text. The timing provider supplies word
times and speakers; context inference, the editor and line cutting run as usual.

- `.srt` and `.vtt` give their cue text (times, speaker names and markup dropped). Any other file is plain text,
  with the encoding rules above. A `.txt` that Overtone wrote works as is: when every paragraph starts with a
  speaker label (`Maya:`, `S1:`), the labels are dropped.
- Your text is kept as given: no text vote. Speech it leaves out gets no captions. A warning names each chunk
  where the text has under 30% of the words the timing provider heard (when it heard at least 10), and each
  stretch of at least 15 heard words over 6 s that the text lacks.
- Not with `--text`, `--two-pass` or `--timing same`. With `--local`, whisper.cpp times the file.
- `meta.models.text` is `file:<name>`.
- No output may overwrite the text file, the media, the `--context-file` or the `--glossary` file. Such a run stops,
  naming the file, before anything is extracted or sent.

## Providers and environment variables

| Provider | Roles | Environment | Default model |
|---|---|---|---|
| `openai` | text, timing, llm | `OPENAI_API_KEY`; optional `OPENAI_BASE_URL`, `OPENAI_RESPONSE_FORMAT` | text `gpt-transcribe`; timing `whisper-1+gpt-4o-transcribe-diarize` (`words`: `whisper-1` alone, no speakers); llm `gpt-6.1-sol`. Text `whisper-1` has word timings |
| `azure-openai` | text, llm | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`; optional `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_TRANSCRIBE_MODEL`, `AZURE_OPENAI_TRANSCRIBE_KEYWORDS` | none: the model part is your deployment name (`azure-openai:my-deployment`) |
| `anthropic` | llm | `ANTHROPIC_API_KEY`; optional `ANTHROPIC_BASE_URL` | `claude-opus-5-5` |
| `azure-speech` | timing | `AZURE_SPEECH_KEY`, and `AZURE_SPEECH_REGION` or `AZURE_SPEECH_ENDPOINT`; optional `AZURE_SPEECH_PROFANITY` | mode `fast` (the only mode) |
| `azure-mai` | text, timing | `AZURE_MAI_KEY`, and `AZURE_MAI_REGION` or `AZURE_MAI_ENDPOINT` | `mai-transcribe-2`, with word timings |
| `elevenlabs` | text, timing | `ELEVENLABS_API_KEY` (speech-to-text permission is enough); optional `ELEVENLABS_BASE_URL`, `ELEVENLABS_TIMEOUT_SECONDS` | `scribe_v2`, with word timings |
| `whisper-cpp` | text, timing | optional `WHISPER_CPP_BIN`, `WHISPER_CPP_MODEL`, `WHISPER_CPP_TDRZ`, `WHISPER_CPP_THREADS`, `WHISPER_CPP_ARGS` | `large-v3-turbo` (a model name such as `base` or `small.en-tdrz`, or a path to a ggml `.bin`), with word timings |
| `ollama` | llm | optional `OLLAMA_BASE_URL`, `OLLAMA_API_KEY`, `OLLAMA_NUM_CTX`, `OLLAMA_MAX_TOKENS`, `OLLAMA_THINK`, `OLLAMA_RESPONSE_FORMAT` | `qwen3:8b` (any tag you pulled) |
| `recorded:<dir>` | text, timing, llm | none | Replays recorded responses from `<dir>` (tests, demos) |

Examples: `--llm anthropic`, `--llm openai:gpt-6-astra`, `--text azure-openai:my-transcribe`,
`--text whisper-cpp:base --timing same`, `--timing elevenlabs`, `--timing openai`, `--llm ollama:llama3.1:8b`.
What each variable does and how each provider is called: [Provider details](providers.md).

Only the selected providers' variables are required. A missing one fails the run before any extraction or API
call:

```
Missing environment variables for the selected providers:
  OPENAI_API_KEY (openai)
  ANTHROPIC_API_KEY (anthropic)
Set them in .env or your environment; .env.example lists them all (https://github.com/lonthq/overtone-captions/blob/main/.env.example).
No keys? Use --local to run free and offline with whisper.cpp and Ollama.
```

For a [per-language editor](languages.md#per-language-defaults) the first line names it:
`Missing environment variables for the nl editor (languages.nl.llm):`.

- `.env` is read from the current directory. Variables already set in the environment win.
- Values are trimmed; empty counts as unset.
- Flags (`WHISPER_CPP_TDRZ`, `AZURE_OPENAI_TRANSCRIBE_KEYWORDS`) take `1`, `true`, `yes`, `on`, `0`, `false`, `no`
  or `off`, in any case. `OLLAMA_THINK` also takes `low`, `medium`, `high` and `default`.
- Numbers and choices are checked before any work. A bad value stops the run, naming the variable and its allowed
  values.
- A server address (`*_BASE_URL`, `*_ENDPOINT`) may not contain a user name or password.
- Keys are never printed: errors and retry warnings show `[redacted]`, and addresses are shown without credentials.

Other variables:

| Variable | Meaning |
|---|---|
| `CHROME_PATH` | Chrome or Chromium binary for `burn` and `--export mp4` |
| `OVERTONE_DEBUG` | `1` logs every usage report ([Usage line](#usage-line)) |
| `OVERTONE_CACHE_HOME` | Folder for the CMU Pronouncing Dictionary ([details](languages.md#cmu-pronouncing-dictionary)) |
| `OVERTONE_CMUDICT` | A local copy of the dictionary |
| `OVERTONE_RECORD_HTTP` | Folder to save every provider HTTP exchange in, secrets redacted, for test fixtures ([Record fixtures](../contributing/providers.md#record-fixtures)) |
| `OVERTONE_LIVE`, `OVERTONE_LIVE_TEXT`, `OVERTONE_LIVE_TIMING`, `OVERTONE_LIVE_LLM` | The [live test](#live-test) |

Retries, timeouts and refused requests: [Retries and timeouts](pipeline.md#retries-and-timeouts),
[Refusals](pipeline.md#refusals).

### `--timing same`

A text provider with word timings also serves the timing role from the same call, with no second speech request:
`--text whisper-cpp:large-v3-turbo --timing same`. These are `elevenlabs`, `azure-mai`, `whisper-cpp` and
`openai:whisper-1`, marked in `overtone providers`. `same` takes no model part
and is rejected for a text provider without word timings.

## Output

Files go to `--out` (default: the input's folder). The base name is the input name without its extension
(`talk.mp4` → `talk`).

| Format | File |
|---|---|
| `json` | `<base>.overtone.json` |
| `player` | `<base>.player.overtone.json`: for publishing. Without `meta`, `edits` and each word's `match` and `confidence`; only the chosen profiles |
| `vtt` | `<base>.<profile>.vtt` per profile, with `<c.class>` styling spans |
| `vtt-words` | `<base>.<profile>.words.vtt` per profile: `vtt` plus a timestamp before each word (`<00:00:01.200>word`) |
| `srt` | `<base>.<profile>.srt` per profile, plain text |
| `txt` | `<base>.txt`, a transcript with speaker names |
| `mp4` | `<base>.captioned.mp4`, the video with captions burned in (`transcribe` only) |

- Each file is written under a temporary name and renamed when complete, so an interrupted run never leaves a
  truncated file. A read-only target stops the run with `Cannot write <path> (EACCES)`.
- Written paths go to stdout. Progress, warnings, the review list, the summary and the `REFUSED` block go to stderr.
- Errors print as `error: …` with exit code 1.

### Summary line

The last line of a run, unless a [`REFUSED` block](pipeline.md#refusals) follows:

```
312 words: 290 exact, 18 fuzzy, 4 interpolated · 6 edits, 1 rejected · 2 to review · 2 speakers · 48/71 cues
```

| Part | Meaning |
|---|---|
| `312 words: …` | Word count, per match kind (`exact`, `fuzzy`, `split`, `merge`, `interpolated`, `edited`); empty kinds left out |
| `6 edits, 1 rejected` | Applied editor edits; `rejected` when a [structure check](pipeline.md#the-editor) rejected some |
| `2 to review` | Items on the [review list](pipeline.md#the-review-list), printed just before; left out when empty |
| `2 speakers` | Speaker count |
| `48/71 cues` | Cues per profile, in `--profiles` order |

### Usage line

What the providers reported for this run's requests, printed before the review list and the summary.

```
usage: text whisper-cpp:large-v3-turbo 1 request, 18.0 s audio · llm ollama:qwen3:8b 4 requests, 3,000 in / 424 out tokens
```

- Audio seconds are the audio sent. Tokens come from the provider's response: `usage` (OpenAI, Azure OpenAI;
  Anthropic with cache reads and writes counted as input), `prompt_eval_count` and `eval_count` (Ollama).
- Cached input and reasoning tokens follow in parentheses when reported:
  `11,164 in (2,303 cached) / 5,709 out (4,662 reasoning) tokens`. OpenAI and Azure OpenAI report both; Anthropic
  reports cache reads.
- Requests answered from the [cache](config.md#cache) report nothing. They are counted as `…, 3 from the cache`, or
  alone: `llm azure-openai:gpt-6.1-sol 4 requests from the cache`.
- Timed-out requests are counted, since they may be billed: `3 requests (1 timed out with 60.0 s audio, may be
  billed)`.
- `OVERTONE_DEBUG=1` logs every report. The line shows no money amounts. Usage is not stored in the document or
  the cache key.

<a id="meta"></a>

### `meta` fields

Always present: `linebreaks` (`llm` or `rules`), `rules`, `languageData`, `generator`, `createdAt`; from
`transcribe` also `style` (`numbers`, `currency`, `guide`) and `models`. A `recut` of a subtitle file writes no
`style` or `models`; a `recut` of a document keeps its `meta`. The others appear when they apply. Every reader
accepts them, since the format allows extra `meta` fields.

| Field | Meaning |
|---|---|
| `rules` | Rule set that cut the captions, e.g. `"1"` ([rule sets](config.md#stable-output-rule-sets)) |
| `languageData` | Fingerprint (16 hex digits) of the language pack data the rules read for the document's language |
| `models` | `text`, `timing` and `llm` selections, and `second` for the second hearing |
| `generator`, `createdAt` | CLI name and version; ISO time of the run |
| `context`, `contextSource` | The context used; `user` (`--context`, `--context-file`) or `inferred` ([Context](pipeline.md#context)) |
| `review` | LLM changes to check by ear ([review list](pipeline.md#the-review-list)): `kind` (`edit` or `vote`), `start`, `end`, `from`, `to`, `why` |
| `refusals` | Refused requests the run went on without ([Refusals](pipeline.md#refusals)): `provider`, `by` (`content filter` or `model`), `request`, `start`, `end`, `instead` |
| `fallbacks` | Chunks whose text came from an engine because the text provider gave none, also after retries: `start`, `end`, `source` (the engine), `reason` ([text base](pipeline.md#the-text-base)) |
| `textRetries` | Chunks the text base changed: `start`, `end`, `reason`; for an empty chunk `loudnorm: true`, the `language` sent, each try in `attempts` (`audio`: `chunk` or `speech` with `start` and `end`; `prompt`: `context`, `names` or `none`; the answer's `words`), the `attempt` that gave the text; for a prompt echo the removed `echo`; and `result` (`retry`, `timing` when every try was empty, `removed` for an echo) |
| `timingRetries` | Snippets sent again for timing ([Timing](pipeline.md#timing)): `start`, `end` of the gap, the stretch's `words`, the `provider`, words `heard`, `result` (`heard`, `partial` or `none`) |
| `textVotes` | Vote regions where the text changed or a change was rejected ([text vote](pipeline.md#the-text-vote)): `start`, `end`, `class` (`a`, `b`, `c`), `from`, `to`, `result` (`changed` or `rejected:<check>`: `empty`, `repeat`, `relisten`, `overlap`), what each engine and the re-listen `heard`, the chooser's `basis`, and `review` for a change no hearing heard |
| `languagesHeard` | With candidate languages: share of speech per language as Azure reported it ([Mixed-language media](languages.md#mixed-language-media)) |
| `source`, `timing` | From `recut` of a subtitle file: `srt` or `vtt`, and `estimated-from-cues` |

Examples:

```json
"textVotes": [{ "start": 9.5, "end": 24.3, "class": "c", "from": "You jerked up.", "to": "You're a jerk, Thom.", "result": "changed",
  "heard": { "azure-speech:fast": "You're a jerk, Tom.", "elevenlabs:scribe_v2": "We have lift off. You're a jerk, Thom.", "relisten": "You're a jerk, Tom." }, "basis": "…" }],
"textRetries": [{ "start": 0, "end": 730.56, "reason": "the text provider returned no text where the engines heard 287 words", "loudnorm": true, "language": "en",
  "attempts": [{ "audio": "chunk", "prompt": "names", "words": 0 }, { "audio": "speech", "start": 139.54, "end": 350.82, "prompt": "names", "words": 311 }], "attempt": 2, "result": "retry" }]
```

## Limits and inputs

- Length: up to 2 hours. Longer media stops with `Media is 2:01:40 long; v1 supports up to 2:00:00.` The check runs
  before extraction, or after it for containers that report no duration (streamed WebM).
- Input: anything ffmpeg reads that has an audio track. A file without audio, or not media, fails with an error
  naming it. With several audio tracks the first is used (and kept by `burn`); reorder with e.g.
  `ffmpeg -i in.mkv -map 0:v -map 0:a:1 -c copy out.mkv`.
- Upload to the text model: MP3 (mono, 24 kHz, 48 kbit/s) in chunks of at most `chunkMb` (default 24 MB) and
  1400 s, cut in the middle of the latest silence before the limit (else a hard cut). Chunks go in order, each
  prompted with the last 300 characters of the previous text.
- Azure Speech, MAI-Transcribe and ElevenLabs get the whole 16 kHz mono WAV in one request. OpenAI timing cuts a WAV
  over 25 MB or 1400 s into pieces. whisper.cpp reads it locally.

## Live test

The live test runs the real providers and makes billable calls; every other test uses recorded responses:

```bash
bash examples/media/make-sample.sh   # once: creates examples/media/sample-16x9.mp4 (macOS say, ffmpeg, ffprobe, bc)
npm run test:live
```

- It runs only with `OVERTONE_LIVE=1`, which the script sets; `npm test` skips it. On Windows PowerShell:
  `$env:OVERTONE_LIVE=1; npx vitest run packages/cli/test/live.test.ts`.
- The test checks the spoken script, so on other systems it needs a clip at that path that says the same text.
- Keys come from `.env` at the repository root. Without them it fails with `Missing environment variables …`
  before any call.
- Providers are the CLI defaults. Override with `OVERTONE_LIVE_TEXT`, `OVERTONE_LIVE_TIMING`, `OVERTONE_LIVE_LLM`
  (e.g. `OVERTONE_LIVE_TEXT=azure-openai:<transcribe-deployment>`).
- It runs in a fresh temp folder (working directory, cache, output), printed, deleted on success and kept on
  failure.
- It checks: all six files written; a valid document with profiles `horizontal` and `vertical`, each with cues;
  language `en`; two speakers; text close to the script, containing `DriveCover` and `Lumora`.
