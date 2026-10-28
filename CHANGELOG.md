# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0, minor versions may contain breaking
changes. The three packages (`overtone-format`, `videojs-overtone`, `overtone-captions`) are versioned together.

## [Unreleased]

## [0.1.0] - 2026-10-28

The first public release.

### Format (`overtone-format`)

- The `.overtone.json` caption format: words stored once (time, speaker, semantic classes `emphasis`, `key`,
  `brand`, `number`, `soft`, match kind and confidence), any number of line-cut profiles, each with an `aspect`
  and its `rules`, and a record of accepted LLM `edits`.
- The [format specification](docs/format/spec.md), version 1 (working draft): conformance, player processing and
  conversion rules for WebVTT, SRT and plain text.
- JSON Schema (`overtone-format/schema.json`) and a validator (`validate`, `assertValid`) for timing, word
  numbering, line text, speakers and cues.
- `closestProfile`, `parseAspect` and `ASPECT_PATTERN` to pick the profile closest to a picture's shape.
- `toPlayerDocument` strips authoring data (`meta`, `edits`, per-word `match` and `confidence`) for publishing.
- Exporters: WebVTT with class spans and voice tags, optionally a timestamp per word (`toWebVTT`), SRT (`toSRT`)
  and a plain transcript with speaker names (`toTranscript`).
- ESM with TypeScript types. No runtime dependencies. Runs in Node 18+ and the browser.

### Player (`videojs-overtone`)

- A video.js 8.5+ plugin (`player.overtone()`) as ESM and as a script-tag bundle (`window.OvertoneVideojs`).
- Automatic profile choice (`profile: 'auto'`): the profile closest to the visible picture, re-checked on
  resize, fullscreen and video size changes.
- Captions sit on the visible picture; text size follows the profile's line length. Each cue carries the
  document's language and each line `dir="auto"`, so right-to-left and CJK text render correctly.
- One captions button that cycles off, styled and plain (also the <kbd>C</kbd> key), remembered across visits
  and kept in sync across players.
- Speaker names option `speakers`: `never` (default), `change` or `always`.
- Style packs `clean`, `social`, `minimal`, `high-contrast` and `lumora`, on a shared `base.css`. Each pack is a
  CSS file and a `pack.json`, checked for WCAG contrast, plain mode, reduced motion and scoping. A template and a
  schema help you write your own.
- `social` grows the word being spoken. `prefers-reduced-motion: reduce` turns the motion off.
- WebVTT fallback tracks for iOS native fullscreen.
- Load and validation errors are reported on the controller, not thrown. Once a document loads, the page's own
  caption tracks are turned off so captions never show twice; `dispose()` restores them.
- `videojs-overtone/core`: the caption rendering without video.js.

### CLI (`overtone-captions`, command `overtone`)

- `overtone transcribe`: extracts the audio with ffmpeg, hears it with several speech engines, reconciles them in
  code and corrects the words with an LLM editor. Up to 2 hours of media per file.
  - Text hearing from a transcription model (default `openai:gpt-transcribe`), timing hearing with word times and
    speakers from Azure AI Speech, and ElevenLabs Scribe as a second hearing when `ELEVENLABS_API_KEY` is set.
  - Text vote: where hearings disagree, the text model re-listens to the snippet and an LLM chooser picks the
    words.
  - Editor (default `openai:gpt-6.1-sol`): corrects misheard words, names and terms with your context and
    glossary, labels speakers and marks key words. Code checks only the structure of its edits. Unsure edits are
    applied and listed for review (`meta.review`).
  - The LLM never sets timestamps. A word no engine heard keeps an estimated time (`match: "interpolated"`,
    confidence 0).
  - Without `--context`, one short LLM call infers the topic and the names (`--no-infer-context` skips it).
  - A request a provider refused does not stop the run. It is reported in a `REFUSED` block and in
    `meta.refusals`.
  - `--dry-run` shows what a run would do, missing keys and an estimated cost, without sending a request.
  - `--local` runs whisper.cpp and Ollama, with no keys.
  - `--text-file` times an existing transcript instead of transcribing.
- Providers per role (`--text`, `--timing`, `--llm`): `openai` (and OpenAI-compatible servers), `azure-openai`,
  `anthropic`, `azure-speech`, `azure-mai`, `elevenlabs`, `whisper-cpp`, `ollama`, and `recorded` (replays
  saved responses).
- Line cutting by rules in code, per profile, showing hesitations as breaks. Profiles by name or aspect
  (`--profiles horizontal,1:1,4:5`); rules for any aspect are interpolated between 16:9 and 9:16. A video in
  another shape gets a profile for its own shape. `--llm-linebreaks` also asks the LLM, within the same rules.
- Rule set `1`: the versioned, frozen line-cutting rules, so the same words always give the same captions
  (`--rules`, recorded in `meta.rules`).
- Language packs for English and Dutch, detection for German, French, Spanish, Italian and Portuguese, and
  neutral rules for every other language. Mixed-language media with `--language en,es`.
- Exports: `.overtone.json`, a player document, WebVTT (also with word timestamps), SRT, a transcript and, with
  `--export mp4`, a video with burned-in captions.
- `overtone burn`: an MP4 with the captions burned in, drawn by the player's own code and style packs. Needs
  ffmpeg 5.0+ and Google Chrome or Chromium.
- `overtone recut`: re-cuts existing SRT, WebVTT or `.overtone.json` into the profiles' layouts, offline.
- `overtone export`, `validate`, `init`, `languages` and `providers`, all offline.
- A request cache in `.overtone/`, keyed only by what is sent: changing rules, profiles or language data sends no
  paid request again.
- Errors say what to fix. Keys are redacted from logs and errors.
- An Agent Skill (`skills/overtone/SKILL.md`) that teaches coding agents to run the CLI safely.

### Project

- Demo page, style gallery and a single-page CDN example (`examples/`).
- Live pipeline output on a generated sample, a NASA interview and three Blender open movies
  (`examples/output`).
- A benchmark of accuracy, timing, speakers, cost and speed in `bench/`, and an offline regression gate on
  frozen hearings (`npm run bench:gate`).
- A provider kit: a template, a conformance suite on recorded HTTP exchanges, and `OVERTONE_RECORD_HTTP` to
  record them with secrets redacted.
- Contributor guides for language packs, style packs and providers, each with a version for AI coding agents.
- A project site at [overtone.lont.ai](https://overtone.lont.ai/).

[Unreleased]: https://github.com/lonthq/overtone-captions/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lonthq/overtone-captions/releases/tag/v0.1.0
