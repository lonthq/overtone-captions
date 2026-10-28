/*
 * Template for a new provider (not registered).
 *
 * 1. Copy to `<id>.ts` (lowercase id: `deepgram.ts`) and rename `exampleProvider`.
 * 2. Keep only the roles your service serves: `text` (words), `timing` (timed words with speakers), `llm` (JSON
 *    answers to a schema).
 * 3. Add the descriptor to BUILTIN_PROVIDERS in `registry.ts`.
 * 4. Add a conformance harness to packages/cli/test/conformance/conformance.test.ts, with recorded responses in
 *    packages/cli/test/conformance/fixtures/<id>/.
 *
 * Walkthrough: docs/contributing/providers.md. Contract: kit.ts. Role interfaces: types.ts.
 */
import { UserError } from '../errors.js';
import type { TimedWord } from '../types.js';
import { reportTimeouts, retryTimeoutsOnce, withDeadline, withRetry, type RetryOptions } from '../util/retry.js';
import { audioTimeoutMs, defineProvider, envString, httpErrorFrom, jsonErrorField, LLM_TIMEOUT_MS, speakerNumbering, type AudioTimeoutPolicy, type ProviderDescriptor, type Usage, type UsageCallback } from './kit.js';
import { LlmFormatError, RefusalError, type AudioChunk, type AudioFile, type LlmProvider, type LlmRequest, type TextOptions, type TextProvider, type TextResult, type TimingOptions, type TimingProvider } from './types.js';

/** Cite the API version, source page and date: "v2 (https://…, verified 2026-10-17)". */
const BASE_URL = 'https://api.example.com/v1';

interface ExampleConfig {
  key: string;
  baseUrl: string;
  model: string;
  fetch: typeof fetch;
  retry?: RetryOptions;
  usage?: UsageCallback;
}

/**
 * Per-attempt upload timeout from the audio length. Size it at several times the slowest measured healthy request;
 * see TIMEOUT in elevenlabs.ts.
 */
const UPLOAD_TIMEOUT: AudioTimeoutPolicy = { minMs: 60_000, msPerAudioSecond: 200 };

/**
 * POSTs within `timeoutMs` per attempt, retrying transient failures and a timeout at most once. The service may have
 * billed a timed-out attempt, so `timedOut` reports each as usage. Errors never contain the key.
 */
async function call(cfg: ExampleConfig, path: string, body: BodyInit, timeoutMs: number, timedOut: Usage, headers: Record<string, string> = {}): Promise<unknown> {
  return withRetry(reportTimeouts(() => withDeadline(timeoutMs, async (signal) => {
    const res = await cfg.fetch(`${cfg.baseUrl}${path}`, { method: 'POST', headers: { authorization: `Bearer ${cfg.key}`, ...headers }, body, signal });
    // redacts the body, keeps status and Retry-After for the retry logic; never build this error yourself
    if (!res.ok) throw await httpErrorFrom(res, 'Example API', [cfg.key], jsonErrorField);
    return res.json();
  }), () => cfg.usage?.({ ...timedOut, timedOut: true })), retryTimeoutsOnce(cfg.retry));
}

class ExampleText implements TextProvider {
  constructor(readonly id: string, private readonly cfg: ExampleConfig) {}

  async transcribe(audio: AudioChunk, opts: TextOptions): Promise<TextResult> {
    const { openAsBlob } = await import('node:fs');
    const form = new FormData();
    form.append('file', await openAsBlob(audio.path), audio.path.split('/').pop());
    form.append('model', this.cfg.model);
    // send as given: the prompt already holds context, glossary and style
    if (opts.prompt) form.append('prompt', opts.prompt);
    // no language: the service detects it
    if (opts.language) form.append('language', opts.language);
    const res = (await call(this.cfg, '/transcribe', form, audioTimeoutMs(audio.end - audio.start, UPLOAD_TIMEOUT), { audioSeconds: audio.end - audio.start })) as { text?: unknown; language?: string };
    if (typeof res.text !== 'string') throw new Error(`${this.id}: response has no text`);
    // audio seconds from the chunk, not the bill
    this.cfg.usage?.({ audioSeconds: audio.end - audio.start });
    return { text: res.text, ...(res.language ? { language: res.language } : {}) };
  }
}

class ExampleTiming implements TimingProvider {
  constructor(readonly id: string, private readonly cfg: ExampleConfig) {}

  async align(audio: AudioFile, opts: TimingOptions): Promise<{ words: TimedWord[]; language?: string }> {
    const { openAsBlob } = await import('node:fs');
    const form = new FormData();
    form.append('file', await openAsBlob(audio.path, { type: 'audio/wav' }), 'audio.wav');
    if (opts.language) form.append('language', opts.language);
    if (opts.phrases?.length) form.append('keywords', opts.phrases.join(','));
    const res = (await call(this.cfg, '/align', form, audioTimeoutMs(audio.duration, UPLOAD_TIMEOUT), { audioSeconds: audio.duration })) as { words: Array<{ word: string; start_ms: number; end_ms: number; speaker?: number }> };
    // speakers → "S1", "S2", … by first appearance; times in seconds; sorted by start
    const speakerOf = speakerNumbering<number>();
    const words = res.words
      .map((w) => ({ text: w.word, start: w.start_ms / 1000, end: w.end_ms / 1000, speaker: w.speaker === undefined ? 'S1' : speakerOf(w.speaker) }))
      .sort((a, b) => a.start - b.start);
    this.cfg.usage?.({ audioSeconds: audio.duration });
    return { words };
  }
}

class ExampleLlm implements LlmProvider {
  constructor(readonly id: string, private readonly cfg: ExampleConfig) {}

  async complete<T>(req: LlmRequest): Promise<T> {
    const res = (await call(this.cfg, '/chat', JSON.stringify({
      model: this.cfg.model,
      system: req.system,
      input: req.user,
      // ask for structured output with the schema; withSchemaValidation checks the answer anyway
      json_schema: { name: req.name, schema: req.schema },
    }), LLM_TIMEOUT_MS, {}, { 'content-type': 'application/json' })) as { output?: string; stop?: string; usage?: { input?: number; output?: number } };
    this.cfg.usage?.({ inputTokens: res.usage?.input, outputTokens: res.usage?.output });
    // refusal or content filter: RefusalError (never retried; the run reports it and goes on)
    if (res.stop === 'refusal') throw new RefusalError(this.id, 'model', `${this.id}: the model refused the request`);
    // cut off at the token limit: truncated, so nobody retries it
    if (res.stop === 'max_tokens') throw new LlmFormatError('response was cut off (max tokens)', { truncated: true });
    try {
      return JSON.parse(res.output ?? '') as T;
    } catch {
      // not JSON: withSchemaValidation retries once
      throw new LlmFormatError('response is not valid JSON');
    }
  }
}

export const exampleProvider: ProviderDescriptor = defineProvider({
  id: 'example',
  description: 'Example Speech API (one line for `overtone providers`)',
  roles: ['text', 'timing', 'llm'],
  env: [
    { name: 'EXAMPLE_API_KEY', description: 'API key', required: true, secret: true },
    { name: 'EXAMPLE_BASE_URL', description: `another host, e.g. a regional endpoint (default ${BASE_URL})` },
  ],
  // the model used when the selection is just `example`; verify names against the official docs and cite them
  defaults: { text: 'example-asr-2', timing: 'example-asr-2', llm: 'example-chat-1' },
  // optional: check the model part early, with a helpful message
  normalizeModel(model) {
    if (!/^[\w.-]+$/.test(model)) throw new UserError(`Invalid example model "${model}".`);
    return model;
  },
  create(env, model, deps) {
    const cfg: ExampleConfig = {
      // read every variable with the kit's env helpers (envString, envFlag, envInt, envNumber, envEnum): trimmed,
      // empty = unset, a bad value is a UserError that names the variable
      key: envString(env, 'EXAMPLE_API_KEY')!,
      baseUrl: (envString(env, 'EXAMPLE_BASE_URL') ?? BASE_URL).replace(/\/+$/, ''),
      model,
      // always take fetch from deps: tests replay recorded responses through it, OVERTONE_RECORD_HTTP records them
      fetch: deps.fetch ?? fetch,
      retry: deps.retry,
      usage: deps.usage,
    };
    if (deps.role === 'text') return new ExampleText(deps.id, cfg);
    if (deps.role === 'timing') return new ExampleTiming(deps.id, cfg);
    return new ExampleLlm(deps.id, cfg);
  },
});
