# Instructions for AI coding agents

Start here if you are an AI coding agent. People: read [CONTRIBUTING.md](CONTRIBUTING.md).

An npm workspace with three TypeScript packages:

| Package | Folder | What it is |
|---|---|---|
| `overtone-format` | `packages/format` | Types, JSON Schema, validator and exporters for `.overtone.json`. No runtime dependencies. |
| `videojs-overtone` | `packages/videojs` | The video.js plugin and the style packs (`styles/<name>/`). |
| `overtone-captions` | `packages/cli` | The `overtone` command: `transcribe`, `recut`, `burn`, `export`, `validate`, `init`, `languages`, `providers`. |

## Task guides

Follow the agent page step by step: files to read, files you may change, invariants, definition of done.

| Task | Agent page |
|---|---|
| Add or improve a language pack | [docs/contributing/languages.agents.md](docs/contributing/languages.agents.md) |
| Add or change a style pack | [docs/contributing/style-packs.agents.md](docs/contributing/style-packs.agents.md) |
| Add or fix a provider | [docs/contributing/providers.agents.md](docs/contributing/providers.agents.md) |

## Commands

```bash
npm install
npm test                 # whole suite (vitest); the live API test and bench-gate's private-clips test skip
npm run typecheck        # tsc --noEmit for every package
npm run build            # tsup into packages/*/dist; needed for the CLI, demo and previews
npm run test:lang        # language-pack and caption-example tests
npm run test:styles      # style-pack lint, contrast and schema checks
npm test -- conformance  # provider conformance kit
npm run bench:gate       # regression gate table: WER and timing per clip and engine, offline
node packages/cli/dist/cli.js languages   # language pack coverage, offline
node packages/cli/dist/cli.js providers   # providers, roles and env variables, offline
```

Tests import the packages from source (`vitest.config.ts`) and need no build. Prerequisites: Node.js 22.12+,
`ffmpeg` and `ffprobe` on the `PATH`. Style previews and the burn tests also need Google Chrome or Chromium
(`CHROME_PATH` for another binary). A test that needs a missing tool skips. If more than those two skip,
report which tests skipped and which tool was missing.

## Conventions

- TypeScript, strict, ES modules. Relative imports end in `.js` (`import { x } from './y.js'`).
- An error the user can fix is a `UserError` (`packages/cli/src/errors.ts`) whose message says the fix. The CLI
  prints it as `error: …`.
- The LLM never sets timestamps.
- The editor and the text vote's chooser judge the words. Code checks only the structure of their changes
  (`packages/cli/src/refine/edits.ts`, `packages/cli/src/reconcile/vote.ts`); the benchmark and the regression
  gate measure whether the words are right. Do not add word lists or language heuristics that second-guess the
  LLM. Do not weaken a structure check or a budget to make a test pass.
- The regression gate (`packages/cli/test/bench-gate.test.ts`) compares WER and timing with
  `packages/cli/test/fixtures/bench/baseline.json`. Rewrite the baseline (`BENCH_GATE_WRITE=1`) only for a change
  meant to move a metric, and say so in your report.
- Every behavior change comes with a test. Tests use recorded provider responses (`examples/fixtures/recorded`,
  `packages/cli/test/conformance/fixtures`), never live services.
- Update the docs where behavior changes: `README.md`, `packages/cli/README.md` (short guide), `docs/cli/` (full
  CLI reference: `reference.md`, `config.md`, `languages.md`, `pipeline.md`, `providers.md`) and the rest of
  `docs/`. Write in US English. User-visible changes get a line under "Unreleased" in `CHANGELOG.md`.
- Never edit generated files by hand: `packages/*/dist/`, `packages/videojs/styles/<name>/preview.png`
  (`npm run styles:previews -- <name>`), `docs/images/style-packs.png`.

## Running the CLI for a person

When you run `overtone` for someone, never retry or work around a refusal or an error silently. Show them:

- The `REFUSED` block. A run a provider partly refused (Azure OpenAI's content filter, a model that declined)
  still writes captions, then lists each refused request: time range, provider, what the CLI did instead. Also in
  `meta.refusals`.
- Every `error: …` line.
- The `review:` block: LLM changes to check by ear (unsure edits, vote changes no engine heard). Also in
  `meta.review`.

The rest is in the Agent Skill ([skills/overtone/SKILL.md](skills/overtone/SKILL.md)) and the
[CLI reference](docs/cli/reference.md).

## Guardrails

- Never add video or audio (`.mp4`, `.mov`, `.wav`, `.m4a`, …) to the repository, not even a short test clip.
- Never print, read out, copy or commit `.env`, API keys or tokens. Fixtures and tests use fake values. Never
  commit `.overtone/`: it holds full transcripts.
- Run `npm run test:live` or `overtone transcribe` with cloud providers only when the user asks. They make
  billable API calls.
- Before you report done, `npm test` and `npm run typecheck` pass, and so does `npm run build` if you changed
  package code or style packs.
- Keep the change to its task. Do not reformat or refactor unrelated files. Do not edit existing tests to make
  new code pass.
