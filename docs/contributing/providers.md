# Add a provider

A provider connects one speech or LLM service to Overtone: one TypeScript file plus one line in the registry. You
test it with recorded responses, so you need no paid call until an optional live check at the end
([step by step](#add-a-provider-step-by-step)).

AI agents: follow [providers.agents.md](providers.agents.md).

## Roles

| Role | Gets | Returns | Selected with |
|---|---|---|---|
| `text` | Compressed MP3 chunks (local engines: the whole 16 kHz WAV) and a prompt with context, glossary and style; later short WAV snippets for the text vote | The best transcript; word times optional | `--text <provider>[:<model>]` |
| `timing` | The whole 16 kHz mono WAV with language and glossary, as the timing hearing or the second hearing; later short windows where no engine heard words | Timed words with speakers `S1`, `S2`, … | `--timing <provider>[:<model>]` |
| `llm` | A system prompt, a user prompt and a JSON schema | A JSON value that matches the schema | `--llm <provider>[:<model>]` |

The text hearing gives "$12" and "DriveCover"; the timing hearing knows that "twelve dollars" ran from 9.51 s to
9.72 s. Code aligns the two. A text provider that also returns word times can serve both roles from one call with
`--timing same`. The LLM never sees audio and never sets timestamps.

`node packages/cli/dist/cli.js providers` lists the built-in providers with their roles and default models;
`providers <id>` shows one provider's environment variables. How each one is called:
[Provider details](../cli/providers.md).

## The provider contract

A provider file in [`packages/cli/src/providers/`](../../packages/cli/src/providers) exports a descriptor. Contract
and helpers: [`kit.ts`](../../packages/cli/src/providers/kit.ts). Role interfaces and shared errors:
[`types.ts`](../../packages/cli/src/providers/types.ts). Language code maps:
[`lang-codes.ts`](../../packages/cli/src/providers/lang-codes.ts).

```ts
export const deepgramProvider: ProviderDescriptor = defineProvider({
  id: 'deepgram',                      // used as --timing deepgram:<model>
  description: 'Deepgram speech-to-text (word timings + diarization)',
  roles: ['text', 'timing'],
  env: [
    { name: 'DEEPGRAM_API_KEY', description: 'API key', required: true, secret: true },
  ],
  defaults: { text: 'nova-3', timing: 'nova-3' },
  create(env, model, deps) {
    return new DeepgramProvider(deps.id, { key: env.DEEPGRAM_API_KEY!, model, fetch: deps.fetch ?? fetch, retry: deps.retry, usage: deps.usage });
  },
});
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Lowercase letters, digits and `-`: what users type before the `:` |
| `description` | yes | One line for `overtone providers` |
| `roles` | yes | Any of `text`, `timing`, `llm` |
| `env` | yes | Every variable the provider reads ([Environment variables](#environment-variables)) |
| `defaults` | yes | Default model per role; leave a role out when there is none (Azure deployment names) |
| `create(env, model, deps)` | yes | Returns an object with `transcribe` (text), `align` (timing) or `complete` (llm) for `deps.role` |
| `modelHint` | no | What the model part means, for the error when it is missing |
| `normalizeModel(model, role)` | no | Check or normalize the model part; throw a `UserError` for a bad one |
| `wordTimings` | no | `true`, or a list of models, when the text role returns `words`: allows `--timing same` |
| `preflight(env, model, deps)` | no | Checks before any work (binary, model file, local server). Throws a `UserError` with the fix. No paid calls. |
| `shareKey(model, deps)` | no | Shares one instance between roles |

`deps` carries the role, the instance `id` (`provider:model`, use it as your `id`), the working directory, the logger,
`fetch` (always use it when given: tests and recordings go through it), retry options and the `usage` callback.

What each role returns:

- **text**: `{ text, language?, words? }`. `language` is an ISO 639-1 code or locale, if the service reports one.
  `words` (only with `wordTimings`) are relative to the chunk start. A provider that transcribes the whole WAV sets
  `input: 'wav'`.
- **timing**: `{ words, language? }`. Each word has trimmed non-empty `text` and `start` < `end` in seconds; starts
  never decrease; `speaker` is `S1`, `S2`, … in order of first appearance (`S1` without diarization); `confidence`,
  if present, is 0 to 1.
- **llm**: the parsed JSON value. Do not validate it yourself: the registry wraps every LLM in
  `withSchemaValidation`, which checks the answer against the schema and retries once.

The pipeline shapes every request. Send the text prompt as given: it already holds the context, glossary and style.
The glossary also arrives as `keywords` (text) or `phrases` (timing) for services with a term list. Languages arrive
as ISO 639-1 codes; convert with `toLocale`, `toIso639_3`, `fromIso639_3` or `fromWhisperName` from `lang-codes.ts`.

## Add a provider, step by step

The example is Deepgram. You need Node.js 22.12 or later; no account until step 9.

1. Fork, clone and install:

   ```bash
   git clone https://github.com/<you>/overtone-captions.git
   cd overtone-captions
   npm install
   ```

2. Read the service's official API reference: request, response and error formats, rate-limit headers, usage
   reporting. Note each URL.

3. Copy the template and rename `example` inside it:

   ```bash
   cp packages/cli/src/providers/_template.ts packages/cli/src/providers/deepgram.ts
   ```

   The [template](../../packages/cli/src/providers/_template.ts) implements all three roles against a made-up API,
   with every rule as a comment. Keep the roles your service has.

4. Add the descriptor to `BUILTIN_PROVIDERS` in [`registry.ts`](../../packages/cli/src/providers/registry.ts).

5. Add response fixtures to `packages/cli/test/conformance/fixtures/deepgram/` ([Record fixtures](#record-fixtures)).

6. Add a harness per role to [`conformance.test.ts`](../../packages/cli/test/conformance/conformance.test.ts) and run
   the kit ([Conformance tests](#conformance-tests)):

   ```bash
   npm test -- conformance
   ```

7. Run everything:

   ```bash
   npm test
   npm run typecheck
   npm run build
   node packages/cli/dist/cli.js providers deepgram
   ```

8. Document it: a row in the provider table of the [CLI reference](../cli/reference.md#providers-and-environment-variables)
   and a section in [Provider details](../cli/providers.md).

9. Optional live check with your own key, on a short clip (billable):

   ```bash
   node packages/cli/dist/cli.js transcribe clip.mp4 --timing deepgram --export json,vtt
   ```

10. Open a pull request with the conformance output and the API version and pages you built against.

## Conformance tests

The kit in [`packages/cli/test/conformance/`](../../packages/cli/test/conformance) has one suite per role. The real
SDKs run on a fake `fetch` that replays recorded responses, so the tests cover request building, response parsing and
error handling.

| Suite | Checks |
|---|---|
| `textConformance` | Text and language; prompt and language sent as given, no language when none is forced; one call per chunk with its audio; usage; word times (with `wordTimings`); transient errors retried, fatal ones not; no secret in errors |
| `timingConformance` | Monotonic starts, start < end, speakers in order, language tag; language and glossary sent; audio seconds reported; retries; no secret in errors |
| `llmConformance` | Prompts and schema sent, answer parsed; token usage; cut-off answer → `LlmFormatError` with `truncated: true`; not JSON → `LlmFormatError`; refusal and content filter → `RefusalError`; one schema retry, none after a cut-off; retries; no secret in errors |

A harness tells the kit how to build your provider and where its requests carry each field:

```ts
timingConformance({
  name: 'deepgram (timing)',
  make: async (steps) => viaHttp<TimingProvider>('timing', 'deepgram', { DEEPGRAM_API_KEY: SECRET }, steps),
  ok: { body: fixture('deepgram/listen.json') },
  expectedWords: 42,
  expectedSpeakers: 2,
  languageOf: (c) => new URL(c.url).searchParams.get('language') ?? undefined,
  phrasesOf: (c) => new URL(c.url).searchParams.getAll('keyterm').join(', '),
  transient: { status: 429, body: { err_code: 'TOO_MANY_REQUESTS' } },
  fatal: { status: 401, body: { err_msg: `Invalid credentials ${SECRET}` } },
  secret: SECRET,
});
```

`steps` are the fake server's responses, in order. `c` is a captured request (`method`, `url`, `headers`, parsed
`body`; multipart forms become objects). [`suites.ts`](../../packages/cli/test/conformance/suites.ts) documents the
harness fields, such as `usagePerFile` for a timing provider that makes several requests per file, `promptless` for a
text service without a prompt, and `userErrors` for checks that must fail with a `UserError`. Local binaries use a fake binary instead (see the whisper.cpp harness and
[`fake-whisper-cli.mjs`](../../packages/cli/test/conformance/fake-whisper-cli.mjs)). The template itself runs
through all three suites, so a fresh copy starts out conformant.

## Record fixtures

Fixtures are response bodies in `packages/cli/test/conformance/fixtures/<id>/`. Three sources, best first:

1. **A real exchange**, recorded once with your own key on a short clip. With `OVERTONE_RECORD_HTTP=<folder>`, every
   HTTP exchange is saved as `NNN-<provider>-<role>.json` (request URL and body, response status, relevant headers,
   body), with secret variables replaced by `[redacted]`. Request headers are never saved.

   ```bash
   OVERTONE_RECORD_HTTP=recordings node packages/cli/dist/cli.js transcribe clip.mp4 --timing deepgram
   ```

   Copy the `response.body` you need, cut it down, and check it for anything private: it holds your clip's transcript.

2. **The official example response**, with its source in a `"_source"` field at the top (providers ignore unknown
   fields).

3. **A synthesized response** in the documented shape, explained in `"_note"`.

For a local engine, save its own output file (the whisper.cpp fixture is a real `-ojf` output with machine-specific
blocks removed).

## Environment variables

- Name them `<PROVIDER>_<THING>` in upper case: `DEEPGRAM_API_KEY`, `DEEPGRAM_BASE_URL`.
- Declare each in `env` with a one-line description that includes an example value.
- Mark keys and tokens `secret: true` (a test checks every `*_KEY`, `*_TOKEN` and `*_SECRET`).
- Read them with the kit's helpers, never `env.X` directly: `envString` (trimmed; empty counts as unset), `envFlag`
  (`1/true/yes/on`, `0/false/no/off`), `envInt`, `envNumber`, `envEnum`. A bad value is a `UserError` that names the
  variable. Check variables in `preflight` too, so a run stops before any work.
- Mark as `required` only what the provider cannot run without. A missing one stops the run with
  `Missing environment variables for the selected providers:` and the names. `waivedBy` names a variable that makes
  it unnecessary (Azure Speech: an endpoint replaces the region).
- Offer `<PROVIDER>_BASE_URL` when the service has regional or self-hosted versions.
- Never read another provider's variables.

## Errors and retries

| Situation | Throw | The user sees |
|---|---|---|
| Wrong setting, missing binary or model, server not running | `UserError` with the fix | `error: <message>` |
| HTTP 408, 409, 429, 5xx, network failure | an error with `status` (`httpErrorFrom` for fetch) | Retried up to 4 times with backoff; `Retry-After` honored |
| HTTP 400, 401, 403, 404 | the same | No retry; `Stage "timing" failed: …` with the service's message |
| HTTP 200 that cannot be a transcript (a check calibrated on real answers, like `implausibleScribe` in `elevenlabs.ts`) | ask once more yourself, reporting usage for both; then `ImplausibleTranscriptError` saying what was wrong | A warning, then the stage fails (as second hearing, the run goes on without it); in a short window, no words there |
| HTTP 200 with a body in another format (an HTML page from a proxy) | `UserError` that names the address variable (see `ollama.ts`) | `error: <message>` |
| No answer within the timeout | see below; after the last timeout a plain `Error` naming the setting that raises the limit (see `elevenlabs.ts`) | A warning, then the stage fails |
| LLM answer cut off at the token limit | `LlmFormatError(…, { truncated: true })` | Stops at once, with a hint to lower the reasoning effort (`effort` in `overtone.config.json`), unless the message already names a limit to raise (`OLLAMA_MAX_TOKENS`) |
| LLM answer not JSON | `LlmFormatError` | Retried once |
| Refusal by the model or a content filter (LLM or text) | `RefusalError(id, 'model' \| 'content filter', msg)` | No retry; the step goes on without the answer where it can (a `REFUSED:` warning, the block at the end of the run, `meta.refusals`) |

Wrap each network call in `withRetry` from [`util/retry.ts`](../../packages/cli/src/util/retry.ts). For a failed fetch
response, throw `await httpErrorFrom(res, '<Service>', [key], extract?)` from `kit.ts`: it redacts the key, takes the
service's message (`jsonErrorField` for `{ "error": … }` bodies), cuts it to 500 characters and keeps status and
headers. Turn SDK retries off (`maxRetries: 0`) so there is one retry layer.

Every call has a timeout, and a timed-out call is retried once at most, because the service may have billed it:

- **Limit**: `LLM_TIMEOUT_MS` (5 minutes) for LLM calls; `audioTimeoutMs(seconds, policy)` for uploads, with a policy
  sized from measured healthy timings (`TRANSCRIPTION_TIMEOUT` in `openai.ts`, `UPLOAD_TIMEOUT` in `_template.ts`).
- **Apply**: with fetch, run each attempt in `withDeadline(ms, (signal, extend) => …)` and pass `signal`; calling
  `extend()` per streamed piece makes it an idle timeout (see `ollama.ts`). With an SDK, pass `timeout` to the client
  and the request.
- **Retry**: `withRetry(fn, retryTimeoutsOnce(deps.retry, onTimeoutRetry?))`.
- **Count**: wrap the attempt in `reportTimeouts(fn, () => deps.usage?.({ audioSeconds, timedOut: true }))` (LLM:
  `{ timedOut: true }`).

If the service can look up a finished request, do that instead of sending it twice (see `elevenlabs.ts`).

## Usage reporting

Call `deps.usage?.({ … })` once per call that the service may bill: successful, cut off, refused, or timed out
(`timedOut: true`).

- text and timing: `audioSeconds`, from the audio you sent (`chunk.end - chunk.start`, or the WAV's `duration`);
- llm: `inputTokens` and `outputTokens` as reported (cached input counts as input), and `cachedInputTokens` and
  `reasoningTokens` when the service reports them.

Leave out what the service does not report. The pipeline prints one `usage:` line per run. Cached answers report
nothing; usage never enters a cache key or the document.

## The request cache

Answers are cached by a hash of what is sent: the provider `id`, the audio bytes, the options and the provider's
`settings`.

- Put every environment variable that changes the request or answer into `settings` with
  `withSettings(provider, { … })` from `kit.ts`: a server address as `serverTag(url)`, a request format, a model file.
  Never a key. Leave out settings that do not change the answer (timeouts, threads).
- When you change how you map the service's response, change `settings` too (for example `{ format: 2 }`), so old
  cached answers are not reused.
- A free provider whose answers are not worth caching sets `uncached: true`.
- A speech provider that ignores some options declares `cacheInputs(role, opts)`, the fields it actually sends. If its
  text and timing roles then send the same request, `sameRequestForTextAndTiming: true` keeps one answer for both, and
  `align` returns the text too (see `elevenlabs.ts`).

## Security

- Never log a key, even at debug level, and never put one in a URL, an error or a cache file.
- The registry redacts every `secret` value from provider errors, preflight errors, retry warnings and recordings.
  Redact in your own messages too, before truncating; `httpErrorFrom` does both.
- Print a server address only through `displayUrl(url)` from `kit.ts`, which drops user name and password.
- Send keys in headers, not query strings, when the service allows both.
- Call only the configured host (`<PROVIDER>_BASE_URL`) or the documented default.
- For local binaries: take the path from the environment or `PATH`, pass arguments as an array (no shell), make temp
  folders with `makeTempDir(prefix)` from [`util/temp-file.ts`](../../packages/cli/src/util/temp-file.ts) and
  `remove()` them in `finally`, and register a child process with `onInterrupt(() => child.kill('SIGKILL'))` from
  [`util/interrupt.ts`](../../packages/cli/src/util/interrupt.ts) (Ctrl-C skips `finally`; see `whisper-cpp.ts`).
- Tests use fake keys such as `sk-conformance-SECRET-…`. A fixture never contains a real one.

## Wanted providers

Open an issue titled `Provider: <name>` so nobody else starts the same one.

| Provider | Roles | What it would bring |
|---|---|---|
| Deepgram (Nova) | text, timing | Word times with diarization in one call, keyterm prompting |
| AssemblyAI | text, timing | Word times, speaker labels and custom vocabulary in one call |
| Google Gemini | text, llm | An editor with JSON-schema output, and long-context transcription |
| Google Cloud Speech-to-Text (Chirp) | text, timing | Word times and diarization for many languages |
| AWS Transcribe | timing | Word times, diarization and custom vocabularies for teams on AWS |
| faster-whisper / WhisperX through a local HTTP server | text, timing | Local and faster than whisper.cpp on GPUs; WhisperX adds forced alignment and pyannote diarization |
| pyannote (local or pyannoteAI) | timing (speakers) | Speaker ids for whisper.cpp's words in local mode |

## Review checklist

- [ ] `npm test`, `npm run typecheck` and `npm run build` pass.
- [ ] One provider file plus one line in `registry.ts`; shared code changes were discussed first.
- [ ] Every claimed role passes its conformance suite, with fixtures whose `_source` names a real exchange or the
      official documentation.
- [ ] Default models, API versions and request shapes cite the official documentation with the date checked.
- [ ] Every variable is in `env`; keys are `secret`; no other provider's variables are read.
- [ ] Network calls go through `withRetry`; SDK retries are off; every call has a timeout.
- [ ] Usage is reported; no error or log holds a key.
- [ ] The CLI reference lists the provider.
- [ ] The pull request names the API version and whether it ran live.

## Getting help

Open an issue on [GitHub](https://github.com/lonthq/overtone-captions/issues) titled `Provider: <name>`, even before
you start. A maintainer can help with the harness, a service that fits no role, or a change the contract needs.
