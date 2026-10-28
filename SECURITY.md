# Security policy

## Supported versions

Only the latest 0.x release of each package (`overtone-format`, `videojs-overtone`, `overtone-captions`) gets
security fixes.

| Version | Supported |
|---|---|
| Latest 0.x | Yes |
| Older 0.x releases | No |

## Reporting a vulnerability

Do not open a public issue. Use GitHub's private reporting: open the
[Security tab](https://github.com/lonthq/overtone-captions/security) and choose "Report a vulnerability".
Include what you found, steps or a small file that reproduce it, the package and version, and the impact you
expect.

This is a small open-source project, handled on a best-effort basis. We aim to acknowledge a report within about
a week and tell you what we plan to do. We cannot promise a date for a fix. We credit you in the release notes if
you want.

## In scope

- `overtone-format`: the validator and exporters on an untrusted `.overtone.json` file. Examples: a crash, a
  hang, or markup injected into WebVTT output.
- `videojs-overtone`: the plugin rendering an untrusted `.overtone.json` file or `.vtt` fallback track. Examples:
  script or HTML injection through caption text, speaker labels, theme names or profile ids.
- `overtone-captions`: unsafe handling of input files, paths or environment variables. `overtone burn` renders
  captions in headless Chrome with network requests blocked. A way for an untrusted `.overtone.json` or style pack
  to run code or reach the network there is in scope.
- Any place where an API key can leak into an output file or a log.

## How the project handles keys and data

- API keys belong in a git-ignored `.env` file or the environment, never in `overtone.config.json`. The CLI
  redacts keys from warnings and errors.
- The CLI sends audio, transcripts, your context and your glossary to the transcription, timing and LLM providers
  you select. That is expected behavior. With `--local`, it uses whisper.cpp and Ollama on your machine instead.
- The `.overtone/` cache holds full transcripts and extracted audio. Protect it like the recording.
- LLM output is checked for structure, not meaning. Every LLM response is validated against a schema. Code checks
  the structure of each proposed edit (its span, speakers and room for the new words), enforces the styling
  budget, and never lets the LLM set a timestamp. Whether a correction is right is the editor's judgment; edits it
  is unsure about are listed for review (`meta.review`). A wrong correction is a quality bug. It is a security
  issue only with a security impact, for example text in the media that makes the LLM do something other than
  edit the transcript.
- The demo server (`npm run demo`) is for development only. It serves `examples/` and the package build folders on
  `127.0.0.1`. Do not expose it to a network or use it in production.

## Out of scope

- Vulnerabilities in third-party services (OpenAI, Azure, Anthropic, ElevenLabs), in video.js, or in your own
  deployment of the player.
- Reports that need a modified local copy of the code or access to someone's `.env` file.
