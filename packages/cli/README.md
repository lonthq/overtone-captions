# overtone-captions

The `overtone` command turns audio or video into word-timed, speaker-labeled captions, cut for each screen shape.
It writes an [Overtone document](https://github.com/lonthq/overtone-captions/tree/main/packages/format)
(`.overtone.json`), WebVTT and SRT per profile, a transcript, and on request an MP4 with the captions burned in.
It also re-cuts subtitles you already have, offline.

Several engines hear the audio; where they disagree, a text vote picks the words. An LLM editor fixes misheard
names and terms, labels speakers and marks key words. Rules cut the lines per profile. The LLM never sets
timestamps. [How the pipeline works](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/pipeline.md)
has the details; [examples/output](https://github.com/lonthq/overtone-captions/tree/main/examples/output) has real
runs.

## Requirements

- Node.js 22.12 or newer.
- `ffmpeg` and `ffprobe` on the `PATH` for `transcribe` and `burn` (`burn` needs ffmpeg 5.0 or later). `recut`
  needs neither.
- Google Chrome or Chromium for `burn` and `--export mp4` (`CHROME_PATH` for another binary).
- API keys for the providers you pick, or whisper.cpp and Ollama for [local mode](#local-mode-free-and-offline).
- For English media, internet access once to download the [CMU Pronouncing Dictionary](#cmu-pronouncing-dictionary).

## Install

```bash
npm install -g overtone-captions      # the `overtone` command
npx overtone-captions recut talk.srt  # or run it once
```

In a clone of the repository, run `npm run build` and use `node packages/cli/dist/cli.js`.

## Quick start

By default, OpenAI gives the words and the editor, Azure AI Speech the times and speakers. Put three lines in a
`.env` file in the folder you run `overtone` from: `OPENAI_API_KEY=…`, `AZURE_SPEECH_KEY=…` and
`AZURE_SPEECH_REGION=…` (for example `westeurope`).

```bash
overtone transcribe talk.mp4 --language en --dry-run   # providers, data flow, estimated cost; sends nothing
overtone transcribe talk.mp4 --language en
```

You get `talk.overtone.json`, `talk.horizontal.vtt` (16:9) and `talk.vertical.vtt` (9:16), plus one for the video's
own shape when those two do not cover it (`talk.1x1.vtt`).

Context and a glossary (one term per line) help the words and the editor:

```bash
overtone transcribe talk.mp4 --language en --context "Panel about urban cycling" --glossary terms.txt \
  --export json,vtt,srt,txt
```

Once you know who `S1` and `S2` are, name them without a new transcription:

```bash
overtone recut talk.overtone.json --speakers "S1=Sarah,S2=Tom" --out named/
```

More with a finished document:

```bash
overtone validate talk.overtone.json
overtone export talk.overtone.json --export vtt,srt --profiles vertical --out captions/
overtone burn talk.mp4 talk.overtone.json --style social   # talk.captioned.mp4
```

`burn` draws the captions with the
[video.js player](https://github.com/lonthq/overtone-captions/tree/main/packages/videojs)'s code and CSS, so style
packs look the same.

### Azure only

Azure OpenAI and Azure Speech need no OpenAI account. Fill in the `AZURE_OPENAI_*` and `AZURE_SPEECH_*`
lines of [.env.example](https://github.com/lonthq/overtone-captions/blob/main/.env.example) and pass your deployment
names:

```bash
overtone transcribe video.mp4 \
  --text "azure-openai:<transcribe-deployment>" --llm "azure-openai:<chat-deployment>"
```

[Azure OpenAI](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/providers.md#azure-openai) lists the
deployments that work.

## Re-cut existing subtitles

`overtone recut` re-cuts SRT or WebVTT for each profile, offline, with no keys and no ffmpeg:

```bash
overtone recut talk.srt                       # talk.overtone.json, .horizontal/.vertical .vtt and .srt, talk.txt
overtone recut talk.srt --profiles vertical   # only the phone cut
overtone recut talk.overtone.json --profiles vertical --out recut/   # from a document's real word times
```

Word times are estimated from the cues. For exact times, give the media and use the subtitles as the text for the
timing provider to time:

```bash
overtone transcribe talk.mp4 --text-file talk.srt
```

[Re-cut existing subtitles](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/reference.md#re-cut-existing-subtitles)
says how a file is read and where speakers come from.

## Choosing models

| Provider | Roles | Keys | Pick it for |
|---|---|---|---|
| `openai` | text, timing, llm | `OPENAI_API_KEY` | The default words and editor. |
| `azure-speech` | timing | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | The default times and speakers. Best on clean speech. |
| `elevenlabs` | text, timing | `ELEVENLABS_API_KEY` | Films, music and noisy audio, where Scribe's word times are more precise. |
| `azure-mai` | text, timing | `AZURE_MAI_KEY`, `AZURE_MAI_ENDPOINT` | Microsoft's MAI-Transcribe-2 ([setup](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/providers.md#mai-transcribe-2-on-azure)). Word times less precise than Azure Speech's. |
| `azure-openai` | text, llm | `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY` | Azure OpenAI deployments instead of an OpenAI account. |
| `anthropic` | llm | `ANTHROPIC_API_KEY` | Claude as the editor. |
| `whisper-cpp`, `ollama` | text and timing; llm | none | [Local mode](#local-mode-free-and-offline). |

```bash
overtone transcribe talk.mp4                        # OpenAI + Azure Speech
# with ELEVENLABS_API_KEY in .env                   # + ElevenLabs Scribe as a second hearing, no flag
overtone transcribe talk.mp4 --timing elevenlabs    # OpenAI + Scribe, no Azure
overtone transcribe talk.mp4 --timing openai        # OpenAI only: whisper-1 times, gpt-4o-transcribe-diarize speakers
overtone transcribe talk.mp4 --llm anthropic        # Claude as the editor
overtone transcribe talk.mp4 --text elevenlabs --timing same   # ElevenLabs alone
overtone transcribe talk.mp4 --local                # whisper.cpp + Ollama
```

For films, music or noisy audio, add an ElevenLabs key: the text vote then compares three hearings. With
`--timing elevenlabs`, Scribe gives times and speakers, with no second hearing; it tells speakers apart less
reliably than Azure.

A run with a missing variable stops before any API call and names it. `overtone providers` lists every provider,
its roles and default models; `overtone providers <id>` lists its variables.

## Cost and privacy

`--dry-run` estimates the cost up front. After each run, a
[usage line](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/reference.md#usage-line) shows the
requests, audio seconds and tokens each provider reported. In the benchmark runs of 2026-10-23, a run cost
$0.023–0.025 per audio minute, and $0.029 with ElevenLabs Scribe, at list prices
([Speed and cost](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/pipeline.md#speed-and-cost)).

A run pays for:

- each hearing of the audio: the text model, Azure Speech, and Scribe when its key is set;
- two LLM passes over the transcript, plus one short call that infers the context when you give none;
- re-sends of a chunk that came back empty (up to three), and short snippets where the hearings disagree;
- `--two-pass` (every chunk twice) and `--llm-linebreaks` (one more LLM pass per profile).

The [cache](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/config.md#cache) in `.overtone/` reuses
every saved answer in a failed or repeated run; only a request whose content changed is paid again.

With cloud providers, the audio goes to the speech providers; the transcript, context, glossary and style settings
go to the LLM. With `--local`, nothing leaves your machine unless `OLLAMA_BASE_URL` points elsewhere.

Keys belong in `.env` (git-ignored; `.env.example` is the template) or the environment, never in
`overtone.config.json` or a commit.

## Common options

The `transcribe` options most people need; the
[CLI reference](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/reference.md) lists them all.

| Option | Default | What it does |
|---|---|---|
| `--language <code>` | `auto` | Spoken language, such as `en`; `en,es` for mixed-language media |
| `--context <text>` | inferred | What the media is about: topic, setting, people |
| `--glossary <path>` | none | Names, brands and jargon, one term per line |
| `--speakers "S1=Sarah,S2=Tom"` | none | Speaker names |
| `--profiles <ids>` | `horizontal,vertical` | Screen shapes, by name or aspect (`horizontal,1:1,4:5`) |
| `--export <formats>` | `json,vtt` | Any of `json,player,vtt,vtt-words,srt,txt,mp4` |
| `-o, --out <dir>` | next to the input | Output folder |
| `--text`, `--timing`, `--llm` | see [Choosing models](#choosing-models) | Provider and model per role |
| `--local` | off | whisper.cpp and Ollama only |
| `--dry-run` | off | Show providers, data flow and estimated cost; send nothing |
| `--mark-uncertain` | off | Write `(??)` after words the engines disagree on, for drafts |

`player` writes the document without authoring data, for public sites. Most options also go in
`overtone.config.json`, in camelCase:

```json
{
  "llm": "anthropic",
  "glossary": ["DriveCover", "Lumora"],
  "profiles": ["horizontal", "vertical", "1:1"]
}
```

[Configuration](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/config.md) lists every key.

## Language

Give `--language` when you know it. Without it, gpt-transcribe can return nothing for a film or a quiet recording.
With an ElevenLabs key, the CLI waits for the language Scribe detects and sends it with the text request. Without
one, it resends the empty part with the language the other engines heard, which bills it twice.

For media in more than one language, list the candidates, main language first: `--language en,es`.
[Language](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/languages.md) covers detection,
mixed-language media and language packs; `overtone languages` lists each pack's coverage.

### CMU Pronouncing Dictionary

The text vote compares how words sound. English spelling does not predict sound, so English words are looked up in
the [CMU Pronouncing Dictionary](https://github.com/cmusphinx/cmudict) (about 135,000 words, 0.95 MB). Without it,
English falls back to letter-to-sound rules and a less precise check.

The CLI downloads it once, on the first English run. Offline, download it ahead with the `curl` command under
[Local mode](#local-mode-free-and-offline), or set `OVERTONE_CMUDICT` to a local copy.
[The reference](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/languages.md#cmu-pronouncing-dictionary)
has the source, checksum, cache folder and license.

## Local mode (free and offline)

`--local` uses whisper.cpp for the words and times and Ollama for the editor. No keys, no paid calls.

```bash
overtone transcribe talk.mp4 --local --context "Panel about urban cycling" --glossary terms.txt
# same as: --text whisper-cpp:large-v3-turbo --timing same --llm ollama:qwen3:8b
```

Install once (about 6.8 GB for the defaults):

```bash
# whisper.cpp and the default speech model (1.5 GiB)
brew install whisper-cpp            # macOS; elsewhere build it: https://github.com/ggml-org/whisper.cpp
mkdir -p ~/.cache/whisper.cpp
curl -L --fail -o ~/.cache/whisper.cpp/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin

# Ollama and the default editor model (5.2 GB)
brew install ollama                 # or the app from https://ollama.com/download
ollama serve &                      # or start the Ollama app
ollama pull qwen3:8b

# English media: the CMU Pronouncing Dictionary (0.95 MB)
mkdir -p ~/.cache/overtone
curl -L --fail -o ~/.cache/overtone/cmu-pronouncing-dictionary-3.0.0.tgz \
  https://registry.npmjs.org/cmu-pronouncing-dictionary/-/cmu-pronouncing-dictionary-3.0.0.tgz
```

Compared with the cloud defaults:

- No speakers: every word is `S1`. The `small.en-tdrz` model marks turns as alternating `S1`/`S2` (English only).
- Word times come from whisper's token timestamps and are less precise around pauses.
- An 8B model proposes many wrong edits. Check the `edits` in the `.overtone.json`, use a larger model, or pair
  local speech with a cloud editor (`--local --llm anthropic`).

[Local mode](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/providers.md#local-mode) covers other
models, flag combinations and measured speeds.

## Stable output: rule sets

The line-cutting rules are a versioned rule set. The same words, rule set and language pack data always give the
same captions, also after an upgrade. The words themselves can vary between runs.

Pin the rule set with `--rules 1` or `"rules": "1"`; the default, `latest`, follows upgrades. `overtone init`
writes an `overtone.config.json` with the rule set, default models and profile rules pinned.
[Rule sets](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/config.md#stable-output-rule-sets) says
what a rule set locks.

## More documentation

- [CLI reference](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/reference.md): commands, options,
  environment variables, output files, `meta` fields, limits.
- [Configuration](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/config.md): config file, profiles,
  rule sets, cache.
- [Language](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/languages.md) and
  [provider details](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/providers.md).
- [How the pipeline works](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/pipeline.md).
- [Format specification](https://github.com/lonthq/overtone-captions/blob/main/docs/format/spec.md) and
  [player guide](https://github.com/lonthq/overtone-captions/blob/main/docs/player.md).

MIT licensed.
