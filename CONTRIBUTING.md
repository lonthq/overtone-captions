# Contributing to Overtone

Thanks for helping. These three contributions are most wanted, each with a guide:

| You want to | Guide |
|---|---|
| Add or improve a language (detection, line cutting, numbers) | [Add your language](docs/contributing/languages.md) |
| Design a caption look for the player | [Make a style pack](docs/contributing/style-packs.md) |
| Connect another speech or LLM service | [Add a provider](docs/contributing/providers.md) |

Each guide has an issue template: open one to say what you plan before you start. Ask questions and share early
ideas in [Discussions](https://github.com/lonthq/overtone-captions/discussions). Report security problems
privately ([SECURITY.md](SECURITY.md)). Everyone follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

You need Node.js 22.12 or newer, and `ffmpeg` and `ffprobe` on your `PATH` (extraction and end-to-end tests skip
without them). Style previews and the burn tests also need Google Chrome or Chromium (`CHROME_PATH` for another
binary).

```bash
git clone https://github.com/lonthq/overtone-captions.git overtone && cd overtone
npm install
npm run build        # builds packages/*/dist; needed for the CLI, the demo and the style gallery
npm test             # the whole suite; no API keys needed
npm run typecheck
```

Tests import the packages from source, so `npm test` needs no build. Faster loops:

```bash
npm run test:lang          # language packs and caption examples
npm run test:styles        # lint, contrast and schema checks for every style pack
npm test -- conformance    # provider conformance kit
npm run demo               # build, then serve the demo and style gallery on http://localhost:5173
npm run styles:dev         # rebuild style packs on save, with a live gallery
```

## Regression gate

`packages/cli/test/bench-gate.test.ts` runs in `npm test`. It runs alignment and line cutting offline on frozen
hearings of real clips (`packages/cli/test/fixtures/bench/`), scores WER, word timing and cue timing against human
references, and fails when a metric is worse than `baseline.json` allows. To see every engine and clip:

```bash
npm run bench:gate                                                    # full table, no API calls
npx vitest run packages/cli/test/bench-gate.test.ts --silent=false    # the gate and its table
```

If your change is meant to move a metric, check the table, rewrite the baseline in the same pull request and say
why:

```bash
BENCH_GATE_WRITE=1 npx vitest run packages/cli/test/bench-gate.test.ts
```

Never rewrite the baseline to hide a regression. The fixtures' sources and licenses are in the README next to
them.

`npm run test:live` runs the CLI against real, billable APIs with the keys in your `.env`. A pull request never
needs it.

## Repository layout

```
packages/
  format/     overtone-format: types, JSON Schema, validator, WebVTT / SRT / transcript exporters
  videojs/    videojs-overtone: plugin (src/), style packs (styles/<name>/), pack lint and build (scripts/)
  cli/        overtone-captions: the `overtone` command
    src/providers/   text, timing and LLM providers, the registry and a template
    src/lang/        language packs, caption examples and a template
    src/reconcile/   the text vote
    src/refine/      LLM steps, prompts and edit checks
    src/segment/     line and caption cutting
docs/
  format/       the format specification and its changelog
  cli/          the CLI reference
  contributing/ the guides above, each with an *.agents.md version for AI coding agents
examples/       demo page, style gallery, fixtures, recorded responses and live pipeline output
bench/          the accuracy, timing and cost benchmark
site/           the project site (npm run site:build)
skills/         the Agent Skill for coding agents that run the CLI
```

## Pull requests

- One change per pull request. Do not mix a language pack, a style pack and a provider.
- Fill in the [pull request template](.github/pull_request_template.md). Reviewers check its checklist.
- `npm test`, `npm run typecheck` and `npm run build` must pass; CI runs all three on Node 22 and 24.
- Add or update tests for what you change. Update the docs (README, package READMEs, `docs/`) where behavior
  changes. User-visible changes get a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).
- Write in plain US English.

Never commit video or audio (`.mp4`, `.mov`, `.wav`, `.m4a`, …), not even a short test clip:
`examples/media/make-sample.sh` generates the sample clip, and tests use recorded provider responses. Never commit
API keys, `.env` files or the `.overtone/` cache folder, which holds full transcripts.

By contributing, you agree to license your contribution under the [MIT License](LICENSE).
