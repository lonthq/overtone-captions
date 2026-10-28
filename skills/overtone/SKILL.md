---
name: overtone
description: Make captions, subtitles or a transcript from an audio or video file with the Overtone CLI (`overtone`), as WebVTT, SRT, plain text and `.overtone.json`, cut for 16:9 and 9:16 screens, or an MP4 with the captions burned in. Use when the user asks to caption, subtitle or transcribe a video or audio file, to burn captions into a video, or to re-cut, re-time or convert existing SRT or WebVTT subtitles.
---

# Overtone captions

The `overtone` CLI turns audio or video into word-timed, speaker-labeled captions. Several engines hear the audio,
a text vote settles where they disagree, an LLM editor fixes misheard words, and rules cut the lines. The LLM never
sets timestamps. Output: a `.overtone.json` document, WebVTT, SRT and a transcript, cut for 16:9 and 9:16.

## Rules for the agent

- **Never read, print, copy or commit `.env` or any key or token.** The user writes keys into `.env`.
  `overtone providers <id>` prints the variable names a provider needs, never values.
- **Ask before every run that calls a cloud provider.** Cloud runs are billed, and the audio and transcript go to
  the providers. First run the same command with `--dry-run`: it sends nothing and prints the providers per role,
  where the audio and transcript go, the media length, missing variables and the estimated cost. Show the user
  those lines, including the cost, and run without `--dry-run` only after a yes.
  These make no paid calls: `recut`, `validate`, `export`, `burn`, `languages`, `providers`, `init`, and `--local`
  runs without a cloud provider on the command line (`--text`, `--timing`, `--llm` or `--timing-second-opinion`).
- **Ask before installing the local models** (about 6.8 GB of downloads).
- **Never commit `.env` or the `.overtone/` cache folder.** The cache holds the full transcript and the extracted
  audio. In a git repository, make sure `.gitignore` lists both (edit `.gitignore` only; do not open `.env`).
- **Pass refusals and errors on to the user.** Show every `error: …` line and the whole `REFUSED` block (see
  [Output](#output)) with the time ranges it names. Do not retry, rephrase the context or switch providers to work
  around it without asking.
- **Show the review list.** When a run prints a `review:` block, show it with its times: these are edits the editor
  was unsure about and vote changes no engine heard, the places to check by ear. The same list is in `meta.review`.
- Do not edit generated caption files by hand to fix the layout. Run `recut` or `export` again.

## Setup

Check for the command: `overtone --version`. If it is missing:

```bash
npm install -g overtone-captions   # Node.js 22.12 or newer
```

`transcribe` needs `ffmpeg` and `ffprobe` on the `PATH` (macOS: `brew install ffmpeg`). `recut` needs neither, and
no keys. `burn` and `--export mp4` need ffmpeg 5.0 or later and Google Chrome or Chromium (`CHROME_PATH` for another
binary). Inside the Overtone repository, run `npm run build` and use `node packages/cli/dist/cli.js`.

## Pick the path

| The user has | Command | Keys | Cost |
|---|---|---|---|
| SRT or VTT subtitles to re-cut | `overtone recut talk.srt` | none | free, offline |
| Media and a transcript or subtitles | `overtone transcribe talk.mp4 --text-file talk.srt` | timing provider and LLM | billed |
| Media, no keys or private media | `overtone transcribe talk.mp4 --local` | none | free, local |
| Media and cloud keys | `overtone transcribe talk.mp4 …` | per provider | billed |
| Media and an `.overtone.json` to burn in | `overtone burn talk.mp4 talk.overtone.json` | none | free, offline |

## Providers and keys

`overtone providers` lists every provider, its roles (`text`, `timing`, `llm`) and default models.

- Default: `--text openai:gpt-transcribe --timing azure-speech --llm openai:gpt-6.1-sol`, with `OPENAI_API_KEY`,
  `AZURE_SPEECH_KEY` and `AZURE_SPEECH_REGION`.
- With `ELEVENLABS_API_KEY` set, ElevenLabs Scribe joins as a second hearing and gives the word times. Recommend it
  for films, music or noisy audio. `--timing elevenlabs` replaces Azure Speech.
- Other choices: `--llm anthropic` (`ANTHROPIC_API_KEY`); `--text elevenlabs --timing same`; `--timing openai`
  (OpenAI only); `--timing azure-mai` or `--text azure-mai --timing same` (MAI-Transcribe-2: `AZURE_MAI_KEY`,
  `AZURE_MAI_ENDPOINT`; an HTTP 400 "Enhanced mode with model is currently not supported yet" means the region does
  not serve it); `--text azure-openai:<deployment> --llm azure-openai:<deployment>`.
- Keys go in `.env` in the folder where `overtone` runs, or in the environment, never in `overtone.config.json`. A
  run with a missing key stops before any API call and names it; tell the user which variables to add.
- `--local` means `--text whisper-cpp:large-v3-turbo --timing same --llm ollama:qwen3:8b`. Media stays on the
  machine, but there are no speakers (every word is `S1`) and the editor is small. English runs download the CMU
  pronunciation dictionary once. A cloud `timingSecondOpinion` from the config file is turned off;
  `--timing-second-opinion <provider>` on the command line still sends the audio there. `--local --llm anthropic`
  pairs local speech with a cloud editor. Install steps:
  [Local mode](https://github.com/lonthq/overtone-captions/blob/main/packages/cli/README.md#local-mode-free-and-offline).
- `overtone init` writes an `overtone.config.json` that pins the rule set, models and profile rules. It holds no keys.

## Transcribe

```bash
overtone transcribe talk.mp4 \
  --language en \
  --context "Panel about urban cycling in Amsterdam, hosted by Sarah Lee" \
  --glossary terms.txt \
  --export json,vtt,srt,txt --profiles horizontal,vertical --out captions/
```

- `--language en` (or `en,es` for mixed-language media) when the language is known.
- `--context`: one or two sentences on topic, setting and people. Without it, one short LLM call infers it.
- `--glossary <file>`: one term per line, `#` starts a comment. Ask the user for names and terms, or collect them
  from the conversation, and write the file.
- `--export`: any of `json,player,vtt,vtt-words,srt,txt,mp4` (default `json,vtt`). `player` is the document
  without authoring data, for publishing. `mp4` burns the captions in (`--burn-style social` for another pack).
- `--profiles`: names or aspects, such as `horizontal,vertical,1:1`. Default `horizontal,vertical`, plus the
  video's own shape when those do not cover it.
- `--text-file talk.srt` (or `.vtt`, `.txt`) uses that text instead of a text model; the timing provider times it.
- Media can be up to 2 hours long.

Speaker names: the first run cannot know who `S1` is. Read the transcript (`captions/talk.txt`), then name them
offline, keeping words, times and edits:

```bash
overtone recut captions/talk.overtone.json --speakers "S1=Sarah,S2=Tom" \
  --profiles horizontal,vertical --out captions/named/
```

Pass the first run's `--profiles`: `recut` does not add a profile for the video's own shape. On a rerun with known
ids, `--speakers` on `transcribe` works too.

### Cache

A repeated or failed run reuses cached requests from `.overtone/`, keyed on what is sent. Only a changed request is
sent again:

- `--profiles` or a layout rule: nothing is sent (unless `--llm-linebreaks` is on).
- `--llm`: every LLM request (inferred context, the vote's chooser, the editor).
- `--context`: the transcriptions (billed) and the LLM requests that hold it, not the timing request.
- `--from-stage <stage>` sends that stage and later ones again, for example `--from-stage refine` for the editor.

See [Cache](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/config.md#cache).

## Re-cut, validate, export, burn

```bash
overtone recut talk.srt --profiles vertical            # offline; word times estimated from cues
overtone validate talk.overtone.json                   # exit code 1 when invalid
overtone export talk.overtone.json --export vtt,srt --profiles vertical --out captions/
overtone burn talk.mp4 talk.overtone.json --style social   # talk.captioned.mp4
```

`burn` uses the profile closest to the video's shape (`--profile` picks another). `--style` takes `clean`
(default), `social`, `high-contrast`, `minimal` or `lumora`; `-o` sets the output.

## Output

| Format | File |
|---|---|
| `json` | `<base>.overtone.json` |
| `player` | `<base>.player.overtone.json`, without `meta`, `edits` and per-word `match`/`confidence`; serve this one publicly |
| `vtt` | `<base>.<profile>.vtt` per profile, with styling spans |
| `vtt-words` | `<base>.<profile>.words.vtt` per profile, a timestamp tag before each word |
| `srt` | `<base>.<profile>.srt` per profile |
| `txt` | `<base>.txt`, transcript with speaker names |
| `mp4` | `<base>.captioned.mp4`, captions burned in |

Written paths go to stdout. Progress, warnings, the `review:` block and a summary line (words, edits, speakers, cues
per profile) go to stderr. Report the summary and warnings, especially about missing speech or text taken from the
timing provider. Errors print as `error: …` and say the fix.

When a provider refused requests (Azure OpenAI's content filter, or a model that declined), the run still writes
the captions, prints `warning: REFUSED: …` at the time, and ends with a block between `=====` lines. It lists each
refused request: time range, provider, what the request was for and what the CLI did instead. The same list is in
`meta.refusals`. Pass the block on as it is: the captions may be incomplete there. Running again is refused again.

More: [CLI reference](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/reference.md) (every command,
option, variable, output file and `meta` field),
[Configuration](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/config.md),
[Language](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/languages.md),
[How the pipeline works](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/pipeline.md),
[Provider details](https://github.com/lonthq/overtone-captions/blob/main/docs/cli/providers.md).
