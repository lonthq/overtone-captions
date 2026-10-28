# Providers: instructions for AI agents

Background for humans: [providers.md](providers.md).

## Goal

Add or fix one provider (`<id>`, lowercase, such as `deepgram`) that serves one or more roles (`text`, `timing`,
`llm`), passes the conformance kit with recorded responses, and changes nothing else.

## Files to read

1. `packages/cli/src/providers/kit.ts`: the contract (`ProviderDescriptor`, `EnvVar`, `CreateDeps`, `Usage`) and helpers.
2. `packages/cli/src/providers/types.ts`: role interfaces, `CacheTraits`, `LlmFormatError`, `RefusalError`,
   `ImplausibleTranscriptError`.
3. `packages/cli/src/providers/_template.ts`: all three roles against a made-up API, with the rules as comments.
4. The closest real provider: `azure-speech.ts` (fetch, timing), `openai.ts` (SDK, text and llm), `anthropic.ts`
   (SDK, streaming llm), `elevenlabs.ts` (`cacheInputs`, implausible answers), `whisper-cpp.ts` (local binary).
5. `packages/cli/src/providers/registry.ts`: `BUILTIN_PROVIDERS`, env checks, redaction.
6. `packages/cli/test/conformance/suites.ts` (harness fields) and `conformance.test.ts` (existing harnesses).
7. `packages/cli/src/util/retry.ts`: `withRetry`, `retryTimeoutsOnce`, `withDeadline`, `reportTimeouts`.

## Files you may change

| File | Action |
|---|---|
| `packages/cli/src/providers/<id>.ts` | Create from `_template.ts`, or fix |
| `packages/cli/src/providers/registry.ts` | Import the descriptor and add it to `BUILTIN_PROVIDERS` |
| `packages/cli/test/conformance/fixtures/<id>/*.json` | Recorded or documented response bodies |
| `packages/cli/test/conformance/conformance.test.ts` | Append one harness per role; do not edit other harnesses |
| `packages/cli/test/<id>.test.ts` | Optional: unit tests for mapping functions |
| `docs/cli/reference.md` | The provider's row in "Providers and environment variables" |
| `docs/cli/providers.md` | A section on how the provider is called |
| `packages/cli/README.md` | Optional: a row in "Choosing models" |
| `.env.example` | Optional: the variables, commented out, without values |
| `CHANGELOG.md` | A line under "Unreleased" |

## Invariants

- Do not change `kit.ts`, `types.ts`, `structured.ts`, `retry.ts`, the pipeline, another provider or an existing test.
  If the contract does not fit the service, stop and report what is missing.
- No new dependency unless the service has no HTTP API usable with `fetch`. Use `deps.fetch ?? fetch`.
- Use `deps.id` as the instance `id`. Turn off SDK retries (`maxRetries: 0`).
- Every network call: `withRetry(fn, retryTimeoutsOnce(deps.retry))`, a timeout (`LLM_TIMEOUT_MS`, or
  `audioTimeoutMs(seconds, policy)`, applied with `withDeadline` for fetch or `timeout` for an SDK), and
  `reportTimeouts` for timed-out attempts. No timers of your own.
- Failed fetch: `throw await httpErrorFrom(res, '<Service>', [key], extract?)`. Never build an `HttpError` message
  yourself.
- `deps.usage?.(…)` once per billable call (successful, cut off, refused, timed out): `audioSeconds` from the audio
  sent; tokens as the service reports them.
- Timing words: trimmed non-empty `text`, `start` < `end` in seconds, starts never decrease, speakers `S1`, `S2`, … in
  order of first appearance (`speakerNumbering` in `kit.ts`; `S1` without diarization). Text-role `words` are
  relative to the chunk start.
- LLM: cut off → `LlmFormatError(msg, { truncated: true })`; not JSON → `LlmFormatError(msg)`; refusal →
  `RefusalError(id, 'model', msg)`; content filter → `RefusalError(id, 'content filter', msg)`, also from a text
  provider. The message says "refused", "declined" or "content filter". Do not validate the schema yourself.
- A 200 answer that cannot be a transcript: request it once more, then throw `ImplausibleTranscriptError`.
- Send the text prompt as given. Use `keywords`/`phrases` only for the service's own term list. Convert languages with
  `lang-codes.ts`; send none when unsure.
- Cache: an env variable that changes the request or answer goes into `withSettings(provider, { … })` (a server
  address as `serverTag(url)`, never a key). When you change the response mapping, change `settings` (such as
  `{ format: 2 }`). A provider that ignores options declares `cacheInputs`; one whose text and timing requests are
  identical also sets `sameRequestForTextAndTiming`.
- Environment variables: `<ID>_<THING>` in upper case, all in `env`; keys and tokens `secret: true`; `required` only
  for what the provider cannot run without. Read them only with `envString`, `envFlag`, `envInt`, `envNumber`,
  `envEnum`.
- Settings errors and missing binaries, models or servers: `UserError` with the exact fix. Checks that need no paid
  call go in `preflight`. Print addresses only through `displayUrl`.
- Temp folders: `makeTempDir` and `remove()` in `finally`. Child processes: `onInterrupt(() => child.kill('SIGKILL'))`,
  unregistered on exit.
- Never log, print, or put a real key in a URL, error, fixture or test. Tests use `sk-conformance-SECRET-…`.
- No live calls in tests. Do not run `npm run test:live` or `transcribe` with paid providers unless the user asks.

## Steps

1. Check the current state:

   ```bash
   npm install && npm run build
   node packages/cli/dist/cli.js providers
   ```

2. From the vendor's own API reference and changelog (not blog posts), write down with URLs: endpoint and version,
   auth header, request fields (audio, language, prompt or vocabulary), response fields (text, words, time unit,
   speakers, language, usage), the error body and rate-limit headers. Where docs and a real response disagree, follow
   the real response and say so in a comment. Do not depend on undocumented fields without an opt-in variable.
3. Copy `_template.ts` to `<id>.ts`. Rename `exampleProvider` to `<camelId>Provider`; set `id`, `description`,
   `roles`, `env`, `defaults`. Next to each API version or model constant, cite the page and the date checked:

   ```ts
   /** Fast Transcription, GA api-version (verified 2026-10-07). */
   export const FAST_TRANSCRIPTION_API_VERSION = '2025-10-15';
   ```

4. Write an exported pure function that maps the response to the role output (like `mapFastTranscription` or
   `mapWhisperJson`). Watch for milliseconds or 100 ns ticks, 0-based or internal speaker ids, words unsorted by
   start, zero-length words (give them `MIN_WORD_SECONDS` or drop them), and punctuation tokens (attach to the
   previous word).
5. Add the descriptor to `BUILTIN_PROVIDERS`.
6. Add fixtures to `packages/cli/test/conformance/fixtures/<id>/`: one success response per role, from the docs'
   example or a recording (`OVERTONE_RECORD_HTTP=<dir>`, only when the user supplies a key and asks). Put
   `"_source": "<doc URL or 'recorded YYYY-MM-DD'>"` at the top. Keep each file under 20 KB.
7. Append harnesses to `conformance.test.ts`, modeled on azure-speech (fetch) or openai (SDK over fetch). Use the
   documented error bodies for `transient` (429 or 503) and `fatal` (401, echoing `SECRET`).
8. Run the commands under Definition of done. Fix failures in your provider, never in the kit.
9. Add the docs rows and the `CHANGELOG.md` line.

## Definition of done

- [ ] `npm test -- conformance` passes, with a harness for every role the descriptor claims.
- [ ] `npm test`, `npm run typecheck` and `npm run build` pass (one skipped file, the live API test, is normal);
      the descriptor test in `provider-kit.test.ts` passes for the new provider.
- [ ] `node packages/cli/dist/cli.js providers <id>` shows the description, roles, default models and every variable.
- [ ] Every role has a fixture with `_source`.
- [ ] `docs/cli/reference.md` lists the provider.
- [ ] `git status` shows only files from [Files you may change](#files-you-may-change).
- [ ] Your report lists every documentation URL and what you took from it, the API version, anything you could not
      verify, and whether anything ran live.
