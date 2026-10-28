import { readFileSync } from 'node:fs';
import { chmod, copyFile, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseModelSpec } from '../../src/config.js';
import type { UsageReport } from '../../src/providers/kit.js';
import { fromScribeLanguage } from '../../src/providers/elevenlabs.js';
import { createProvider, resolveSelection } from '../../src/providers/registry.js';
import type { LlmProvider, TextProvider, TimingProvider } from '../../src/providers/types.js';
import { tempDir } from '../tmp.js';
import { anthropicSse, FIXTURES, fixture, replayFetch, type Captured, type Scripted } from './replay.js';
import { expectTimedWords, llmConformance, textConformance, timingConformance, wavFile, type Built } from './suites.js';

/**
 * Every provider through the conformance kit (suites.ts), with recorded responses: HTTP providers get a fake
 * fetch (the real SDKs run on top of it), whisper-cpp gets a fake whisper-cli binary. No network, no keys.
 */

const SECRET = 'sk-conformance-SECRET-0123456789abcdef';
const noSleep = { sleep: async () => {} };

// Keep the SDK clients independent of the developer's environment (they read these as defaults).
beforeEach(() => {
  for (const name of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_API_VERSION', 'OPENAI_API_VERSION', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) {
    vi.stubEnv(name, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

/** Build `spec` for `role` through the registry, with a fake fetch replaying `steps`. */
function viaHttp<P>(role: 'text' | 'timing' | 'llm', spec: string, env: NodeJS.ProcessEnv, steps: Scripted[], route?: Parameters<typeof replayFetch>[1]): Built<P, Captured> {
  const r = replayFetch(steps, route);
  const usage: UsageReport[] = [];
  const provider = createProvider(role, resolveSelection(parseModelSpec(spec), role), env, {
    cwd: '/',
    deps: { fetch: r.fetch, retry: noSleep },
    onUsage: (u) => usage.push(u),
  }) as P;
  return { provider, requests: () => r.requests, usage };
}

const body = (c: Captured) => c.body as Record<string, unknown>;
const fileName = (c: Captured) => (body(c).file as { name: string }).name;

// ---------------------------------------------------------------- OpenAI-family chat completions

const chat = fixture('openai/chat-completion.json');
const choice = (message: Record<string, unknown>, finish = 'stop'): Scripted => ({
  body: { ...chat, choices: [{ index: 0, message: { role: 'assistant', refusal: null, ...message }, finish_reason: finish }] },
});
const openAiLlmSteps = {
  reply: (value: unknown) => choice({ content: JSON.stringify(value) }),
  truncated: choice({ content: '{"edits":[{"first":' }, 'length'),
  invalidJson: choice({ content: 'Sure! Here are the edits.' }),
  refusal: choice({ content: null, refusal: 'I can’t help with that.' }),
  contentFilter: choice({ content: null }, 'content_filter'),
};
const messages = (c: Captured) => body(c).messages as Array<{ role: string; content: string }>;
const openAiPrompts = (c: Captured) => ({ system: messages(c)[0]!.content, user: messages(c)[1]!.content });
const openAiSchema = (c: Captured) => (body(c).response_format as { json_schema?: { schema: unknown } }).json_schema?.schema;
const error401: Scripted = { status: 401, body: JSON.parse(JSON.stringify(fixture('openai/error-401.json')).replace('$SECRET', SECRET)) };
const error429: Scripted = { status: 429, headers: { 'retry-after': '0' }, body: { error: { message: 'Rate limit reached', type: 'rate_limit_exceeded' } } };

llmConformance({
  name: 'openai (llm)',
  make: async (steps) => viaHttp<LlmProvider>('llm', 'openai', { OPENAI_API_KEY: SECRET }, steps),
  ...openAiLlmSteps,
  schemaOf: openAiSchema,
  promptsOf: openAiPrompts,
  tokens: { inputTokens: 1234, outputTokens: 56 },
  transient: error429,
  fatal: error401,
  secret: SECRET,
  languageOf: () => undefined,
  userErrors: [{
    name: 'an invalid OPENAI_RESPONSE_FORMAT',
    run: async () => viaHttp('llm', 'openai', { OPENAI_API_KEY: SECRET, OPENAI_RESPONSE_FORMAT: 'xml' }, []),
  }],
});

const AZURE = { AZURE_OPENAI_ENDPOINT: 'https://conformance.openai.azure.com/', AZURE_OPENAI_API_KEY: SECRET };

llmConformance({
  name: 'azure-openai (llm)',
  make: async (steps) => viaHttp<LlmProvider>('llm', 'azure-openai:chat', AZURE, steps),
  ...openAiLlmSteps,
  schemaOf: openAiSchema,
  promptsOf: openAiPrompts,
  tokens: { inputTokens: 1234, outputTokens: 56 },
  transient: { ...error429, status: 503 },
  fatal: error401,
  secret: SECRET,
  languageOf: () => undefined,
});

// Ollama's native /api/chat streams NDJSON: content pieces, then a final chunk with done_reason and counts.
const ollamaFinal = fixture('ollama/chat-final-chunk.json');
const ndjson = (content: string, doneReason = 'stop'): Scripted => {
  const pieces = content.match(/.{1,7}/gs) ?? [];
  const lines = pieces.map((piece) => JSON.stringify({ model: 'qwen3:8b', message: { role: 'assistant', content: piece }, done: false }));
  lines.push(JSON.stringify({ ...ollamaFinal, done_reason: doneReason }));
  return { body: `${lines.join('\n')}\n`, headers: { 'content-type': 'application/x-ndjson' } };
};
const ollamaSteps = {
  reply: (value: unknown) => ndjson(JSON.stringify(value)),
  truncated: ndjson('{"edits":[{"first":', 'length'),
  // no refusal signal: with constrained decoding a refusal arrives as text that is not JSON (invalidJson)
  invalidJson: ndjson('Sure! Here are the edits.'),
};
const ollamaMessages = (c: Captured) => body(c).messages as Array<{ content: string }>;
const ollamaPrompts = (c: Captured) => ({ system: ollamaMessages(c)[0]!.content, user: ollamaMessages(c)[1]!.content });

llmConformance({
  name: 'ollama (llm, json_schema)',
  make: async (steps) => viaHttp<LlmProvider>('llm', 'ollama', {}, steps),
  ...ollamaSteps,
  schemaOf: (c) => body(c).format,
  promptsOf: ollamaPrompts,
  tokens: { inputTokens: 1234, outputTokens: 56 },
  transient: { status: 503, body: { error: 'server busy' } },
  fatal: { status: 404, body: { error: "model 'qwen3:8b' not found" } },
  languageOf: () => undefined,
});

/** json_object mode: format "json", and the schema travels in the system prompt (the server does not enforce it). */
const schemaInSystem = (c: Captured) => {
  const system = ollamaPrompts(c).system;
  return JSON.parse(system.slice(system.indexOf('{', system.indexOf('JSON schema exactly:')))) as unknown;
};
llmConformance({
  name: 'ollama (llm, OLLAMA_RESPONSE_FORMAT=json_object, Ollama cloud key)',
  make: async (steps) => viaHttp<LlmProvider>('llm', 'ollama:llama3.1:8b', { OLLAMA_RESPONSE_FORMAT: 'json_object', OLLAMA_API_KEY: SECRET }, steps),
  ...ollamaSteps,
  schemaOf: schemaInSystem,
  promptsOf: ollamaPrompts,
  tokens: { inputTokens: 1234, outputTokens: 56 },
  transient: { status: 503, body: { error: 'server busy' } },
  fatal: { status: 401, body: { error: `unauthorized: ${SECRET}` } },
  secret: SECRET,
  languageOf: () => undefined,
});

// ---------------------------------------------------------------- Anthropic (streamed, server-sent events)

const message = fixture('anthropic/message.json');
const sse = (patch: Record<string, unknown>): Scripted => ({ body: anthropicSse({ ...message, ...patch }) });

llmConformance({
  name: 'anthropic (llm)',
  make: async (steps) => viaHttp<LlmProvider>('llm', 'anthropic', { ANTHROPIC_API_KEY: SECRET }, steps),
  reply: (value) => sse({ content: [{ type: 'text', text: JSON.stringify(value) }] }),
  truncated: sse({ content: [{ type: 'text', text: '{"edits":[{"first":' }], stop_reason: 'max_tokens' }),
  invalidJson: sse({ content: [{ type: 'text', text: 'Sure! Here are the edits.' }] }),
  refusal: sse({ content: [], stop_reason: 'refusal' }),
  schemaOf: (c) => (body(c).output_config as { format: { schema: unknown } }).format.schema,
  // the system prompt is sent as one text block with cache_control (the shared, cacheable prefix)
  promptsOf: (c) => ({ system: (body(c).system as Array<{ text: string }>).map((b) => b.text).join(''), user: (body(c).messages as Array<{ content: string }>)[0]!.content }),
  // input = uncached 1100 + cache reads 134
  tokens: { inputTokens: 1234, outputTokens: 56, cachedInputTokens: 134 },
  transient: { status: 529, body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
  fatal: { status: 401, body: { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${SECRET}` } } },
  secret: SECRET,
  languageOf: () => undefined,
});

// ---------------------------------------------------------------- OpenAI-family transcription

const transcription = fixture('openai/transcription.json');
const textCommon = {
  ok: { body: transcription } as Scripted,
  expectedText: transcription.text as string,
  expectedLanguage: 'en',
  promptOf: (c: Captured) => body(c).prompt as string | undefined,
  audioOf: fileName,
  tokens: { inputTokens: 152, outputTokens: 15 },
  transient: error429,
  fatal: error401,
  secret: SECRET,
};

textConformance({
  name: 'openai (text, gpt-transcribe)',
  make: async (steps) => viaHttp<TextProvider>('text', 'openai', { OPENAI_API_KEY: SECRET }, steps),
  ...textCommon,
  // gpt-transcribe takes `languages` (multipart: one `languages[]` field per item)
  languageOf: (c) => [body(c)['languages[]']].flat()[0] as string | undefined ?? (body(c).language as string | undefined),
});

it('openai (text, gpt-transcribe): sends the glossary as keywords', async () => {
  const b = viaHttp<TextProvider>('text', 'openai', { OPENAI_API_KEY: SECRET }, [{ body: transcription }]);
  const dir = await tempDir('overtone-conf-');
  await writeFile(join(dir, 'c.mp3'), Buffer.from([1]));
  await b.provider.transcribe({ path: join(dir, 'c.mp3'), index: 0, start: 0, end: 1 }, { keywords: ['DriveCover', 'Lumora'] });
  expect(body(b.requests()[0]!)['keywords[]']).toEqual(['DriveCover', 'Lumora']);
});

textConformance({
  name: 'azure-openai (text)',
  make: async (steps) => viaHttp<TextProvider>('text', 'azure-openai:asr', AZURE, steps),
  ...textCommon,
  languageOf: (c) => body(c).language as string | undefined,
});

// ---------------------------------------------------------------- OpenAI timing (whisper-1 words + gpt-4o-transcribe-diarize speakers)

describe('openai timing', () => {
  const OAI = { OPENAI_API_KEY: SECRET };
  const verboseWords = fixture('openai/verbose-words.json');
  const diarized = fixture('openai/diarized.json');
  // `ok` stands for "the recorded answer of this request's model": the two requests run in parallel
  const OK: Scripted = { body: { _ok: true } };
  const route = (step: Scripted, req: Captured): Scripted =>
    (step.body as { _ok?: boolean })._ok ? { body: body(req).model === 'whisper-1' ? verboseWords : diarized } : step;
  /** Requests in a fixed order (the words request first), whatever order the parallel requests arrived in. */
  const make = (spec: string) => async (steps: Scripted[]) => {
    const b = viaHttp<TimingProvider>('timing', spec, OAI, steps, route);
    const rank = (c: Captured) => (body(c).model === 'whisper-1' ? 0 : 1);
    return { ...b, requests: () => [...b.requests()].sort((x, y) => rank(x) - rank(y)) };
  };
  timingConformance({
    name: 'openai (timing, whisper-1+gpt-4o-transcribe-diarize)',
    make: make('openai'),
    ok: OK,
    expectedWords: 45,
    expectedSpeakers: 2,
    languageOf: (c) => body(c).language as string | undefined,
    phrasesOf: (c) => (body(c).prompt as string | undefined) ?? '',
    usagePerFile: [{}, { inputTokens: 180, outputTokens: 549 }],
    transient: error429,
    fatal: error401,
    secret: SECRET,
  });

  timingConformance({
    name: 'openai (timing, words: whisper-1 only)',
    make: make('openai:words'),
    ok: OK,
    expectedWords: 45,
    expectedSpeakers: 1,
    languageOf: (c) => body(c).language as string | undefined,
    phrasesOf: (c) => (body(c).prompt as string | undefined) ?? '',
    transient: error429,
    fatal: error401,
    secret: SECRET,
  });

  it('asks whisper-1 for word timestamps and the diarize model for diarized_json with server-side chunking', async () => {
    const b = await make('openai')([OK]);
    await b.provider.align(await wavFile(), { language: 'en', phrases: ['DriveCover'] });
    const [words, dia] = b.requests().map(body);
    expect(words).toMatchObject({ model: 'whisper-1', response_format: 'verbose_json', 'timestamp_granularities[]': 'word', language: 'en', prompt: 'Glossary: DriveCover.' });
    expect(dia).toMatchObject({ model: 'gpt-4o-transcribe-diarize', response_format: 'diarized_json', chunking_strategy: 'auto', language: 'en' });
    // the diarize model takes no prompt
    expect(dia!.prompt).toBeUndefined();
    expect(dia!['known_speaker_names[]']).toBeUndefined();
  });

  it('puts the punctuation of the text back on the words, and gives them the diarized speakers', async () => {
    const b = await make('openai')([OK]);
    const res = await b.provider.align(await wavFile(), {});
    expect(res.language).toBe('en');
    expect(res.words.slice(0, 2).map((w) => w.text)).toEqual(['Every', 'year,']);
    // "And the best part, you can claim directly in the app." is speaker B in the recording
    const second = res.words.filter((w) => w.speaker === 'S2').map((w) => w.text).join(' ');
    expect(second).toBe('And the best part, you can claim directly in the app.');
  });

  it('several candidate languages send no language (the models detect it)', async () => {
    const b = await make('openai')([OK]);
    await b.provider.align(await wavFile(), { language: 'en', languages: ['en', 'es'] });
    for (const c of b.requests()) expect(body(c).language).toBeUndefined();
  });
});

// ---------------------------------------------------------------- Azure Speech (timing)

const definition = (c: Captured) => JSON.parse(body(c).definition as string) as { locales?: string[]; phraseList?: { phrases: string[] } };

timingConformance({
  name: 'azure-speech (timing)',
  make: async (steps) => viaHttp<TimingProvider>('timing', 'azure-speech', { AZURE_SPEECH_KEY: SECRET, AZURE_SPEECH_REGION: 'westeurope' }, steps),
  ok: { body: fixture('azure-speech/fast-transcription.json') },
  expectedWords: 4,
  expectedSpeakers: 2,
  languageOf: (c) => definition(c).locales?.[0],
  phrasesOf: (c) => (definition(c).phraseList?.phrases ?? []).join(', '),
  transient: { status: 503, body: { error: { code: 'ServiceUnavailable' } } },
  fatal: { status: 401, body: { error: { code: '401', message: `Access denied for key ${SECRET}` } } },
  secret: SECRET,
});

// ---------------------------------------------------------------- whisper.cpp (a fake whisper-cli binary)

/** One run of the fake binary: the -ojf JSON to write (a fixture path), or a failure. */
type Run = { exit: 0; json: string } | { exit: number; stderr: string };
const SAMPLE_OJF = join(FIXTURES, 'whisper-cpp/sample-base.ojf.json');
const TDRZ_OJF = join(FIXTURES, 'whisper-cpp/tdrz-synthetic.ojf.json');
/** The recorded segments' text: the words must spell exactly this. */
const sampleText = (): string =>
  (JSON.parse(readFileSync(SAMPLE_OJF, 'utf8')) as { transcription: Array<{ text: string }> }).transcription.map((s) => s.text.trim()).join(' ');

async function fakeWhisper(steps: Run[], extraEnv: NodeJS.ProcessEnv = {}, model = 'base'): Promise<Built<TextProvider & TimingProvider, string[]> & { env: NodeJS.ProcessEnv }> {
  const dir = await tempDir('overtone-whisper-fake-');
  const bin = join(dir, 'whisper-cli');
  await copyFile(join(import.meta.dirname, 'fake-whisper-cli.mjs'), bin);
  await chmod(bin, 0o755);
  const modelFile = join(dir, `ggml-${model}.bin`);
  await writeFile(modelFile, 'not a real model');
  const calls = join(dir, 'calls.jsonl');
  const script = join(dir, 'script.json');
  await writeFile(script, JSON.stringify({ steps, calls }));
  const env = { PATH: process.env.PATH, WHISPER_CPP_BIN: bin, WHISPER_CPP_MODEL: dir, FAKE_WHISPER_SCRIPT: script, ...extraEnv };
  const usage: UsageReport[] = [];
  const make = (role: 'text' | 'timing') => createProvider(role, resolveSelection(parseModelSpec(`whisper-cpp:${model}`), role), env, { cwd: dir, onUsage: (u) => usage.push(u) });
  const provider = Object.assign(Object.create(null) as object, { text: make('text'), timing: make('timing') }) as { text: TextProvider; timing: TimingProvider };
  const both = {
    id: provider.text.id,
    input: provider.text.input,
    transcribe: provider.text.transcribe.bind(provider.text),
    align: provider.timing.align.bind(provider.timing),
  } as TextProvider & TimingProvider;
  const requests = () => {
    try {
      return readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]);
    } catch {
      return [];
    }
  };
  return { provider: both, requests, usage, env };
}
const argAfter = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const OK: Run = { exit: 0, json: SAMPLE_OJF };
const CRASH: Run = { exit: 3, stderr: 'whisper_init_from_file_with_params_no_state: failed to load model\n' };

textConformance<Run, string[]>({
  name: 'whisper-cpp (text)',
  make: (steps) => fakeWhisper(steps),
  ok: OK,
  expectedText: sampleText(),
  expectedLanguage: 'en',
  promptOf: (a) => argAfter(a, '--prompt'),
  languageOf: (a) => argAfter(a, '-l'),
  audioOf: (a) => basename(argAfter(a, '-f')!),
  wordTimings: true,
  fatal: CRASH,
  userErrors: [
    {
      name: 'whisper-cli is missing',
      run: async () => {
        const b = await fakeWhisper([OK], { WHISPER_CPP_BIN: '/nonexistent/whisper-cli' });
        return b.provider.transcribe({ path: '/x.wav', index: 0, start: 0, end: 1 }, {});
      },
    },
    {
      name: 'WHISPER_CPP_THREADS is not a number',
      run: async () => fakeWhisper([OK], { WHISPER_CPP_THREADS: 'many' }),
    },
  ],
});

timingConformance<Run, string[]>({
  name: 'whisper-cpp (timing, tinydiarize)',
  make: (steps) => fakeWhisper(steps.map((s) => (s.exit === 0 ? { exit: 0, json: TDRZ_OJF } : s)), {}, 'small.en-tdrz'),
  ok: OK,
  expectedWords: 10,
  expectedSpeakers: 2,
  languageOf: (a) => argAfter(a, '-l'),
  phrasesOf: (a) => argAfter(a, '--prompt') ?? '',
  fatal: CRASH,
});

// ---------------------------------------------------------------- recorded (replays examples/fixtures/recorded)

describe('conformance: recorded', () => {
  const dir = resolve(import.meta.dirname, '../../../../examples/fixtures/recorded/sample');
  const make = <P>(role: 'text' | 'timing' | 'llm') => createProvider(role, resolveSelection(parseModelSpec(`recorded:${dir}`), role), {}, { cwd: '/' }) as P;

  it('timing: the recorded sample follows the timing contract', async () => {
    const res = await make<TimingProvider>('timing').align({ path: 'x', duration: 18 }, {});
    expect(expectTimedWords(res.words, { duration: 18 })).toEqual(['S1', 'S2']);
  });

  it('text: returns the recorded chunk text', async () => {
    const res = await make<TextProvider>('text').transcribe({ path: 'x', index: 0, start: 0, end: 18 }, {});
    expect(res.text).toMatch(/^Every year/);
  });

  it('llm: replays the recorded answers by schema name', async () => {
    const all = JSON.parse(await readFile(join(dir, 'llm.json'), 'utf8')) as Record<string, unknown[]>;
    const name = Object.keys(all)[0]!;
    expect(await make<LlmProvider>('llm').complete({ name, system: '', user: '', schema: {} })).toEqual(all[name]![0]);
  });
});

// ---------------------------------------------------------------- the provider template (src/providers/_template.ts)
// The template must pass the kit too, so a provider copied from it starts out conformant.

describe('the provider template', () => {
  let remove: () => void = () => {};
  beforeEach(async () => {
    const { exampleProvider } = await import('../../src/providers/_template.js');
    const { registerProvider } = await import('../../src/providers/registry.js');
    remove = registerProvider(exampleProvider);
  });
  afterEach(() => remove());

  const env = { EXAMPLE_API_KEY: SECRET };
  const transient: Scripted = { status: 503, body: { error: 'busy' } };
  const fatal: Scripted = { status: 401, body: { error: `bad key ${SECRET}` } };
  const form = (c: Captured) => body(c);

  textConformance({
    name: 'example template (text)',
    make: async (steps) => viaHttp<TextProvider>('text', 'example', env, steps),
    ok: { body: { text: 'Hello there.', language: 'en' } },
    expectedText: 'Hello there.',
    expectedLanguage: 'en',
    promptOf: (c) => form(c).prompt as string | undefined,
    languageOf: (c) => form(c).language as string | undefined,
    audioOf: fileName,
    transient,
    fatal,
    secret: SECRET,
  });

  timingConformance({
    name: 'example template (timing)',
    make: async (steps) => viaHttp<TimingProvider>('timing', 'example', env, steps),
    ok: { body: { words: [{ word: 'Hi', start_ms: 0, end_ms: 300, speaker: 7 }, { word: 'there.', start_ms: 350, end_ms: 700, speaker: 7 }, { word: 'Hello.', start_ms: 900, end_ms: 1300, speaker: 2 }] } },
    expectedWords: 3,
    expectedSpeakers: 2,
    languageOf: (c) => form(c).language as string | undefined,
    phrasesOf: (c) => (form(c).keywords as string | undefined) ?? '',
    transient,
    fatal,
    secret: SECRET,
  });

  const out = (output: string, stop = 'end'): Scripted => ({ body: { output, stop, usage: { input: 10, output: 2 } } });
  llmConformance({
    name: 'example template (llm)',
    make: async (steps) => viaHttp<LlmProvider>('llm', 'example', env, steps),
    reply: (value) => out(JSON.stringify(value)),
    truncated: out('{"edits":[', 'max_tokens'),
    invalidJson: out('no json here'),
    refusal: out('', 'refusal'),
    schemaOf: (c) => (body(c).json_schema as { schema: unknown }).schema,
    promptsOf: (c) => ({ system: body(c).system as string, user: body(c).input as string }),
    tokens: { inputTokens: 10, outputTokens: 2 },
    transient,
    fatal,
    secret: SECRET,
    languageOf: () => undefined,
  });
});

// ---------------------------------------------------------------- ElevenLabs Scribe (text + timing, multipart over fetch)

describe('elevenlabs', () => {
  const XI = { ELEVENLABS_API_KEY: SECRET };
  const scribe = fixture('elevenlabs/speech-to-text.json');
  // recorded error bodies: { detail: { type, code, message, status } }; the 401 here echoes the key
  const xiFatal: Scripted = { status: 401, body: { detail: { type: 'authentication_error', code: 'unauthorized', message: `Invalid API key ${SECRET}`, status: 'invalid_api_key' } } };
  const xiTransient: Scripted = { status: 429, headers: { 'retry-after': '0' }, body: { detail: { status: 'too_many_concurrent_requests', message: 'Too many concurrent requests' } } };
  // Scribe gets ISO 639-3 codes ('nld'); map them back to what the pipeline asked for ('nl')
  const xiLanguage = (c: Captured) => fromScribeLanguage(body(c).language_code as string | undefined);
  const xiTerms = (c: Captured) => [body(c).keyterms ?? []].flat() as string[];

  textConformance({
    name: 'elevenlabs (text, scribe_v2)',
    make: async (steps) => viaHttp<TextProvider>('text', 'elevenlabs', XI, steps),
    ok: { body: scribe },
    expectedText: scribe.text as string,
    expectedLanguage: 'en',
    // Scribe has no prompt field: the context is not sent, the glossary goes in as keyterms (tested below)
    promptless: true,
    promptOf: () => undefined,
    languageOf: xiLanguage,
    audioOf: fileName,
    wordTimings: true,
    transient: xiTransient,
    fatal: xiFatal,
    secret: SECRET,
  });

  timingConformance({
    name: 'elevenlabs (timing, scribe_v2)',
    make: async (steps) => viaHttp<TimingProvider>('timing', 'elevenlabs', XI, steps),
    ok: { body: scribe },
    expectedWords: 43,
    expectedSpeakers: 2,
    languageOf: xiLanguage,
    phrasesOf: (c) => xiTerms(c).join(', '),
    transient: xiTransient,
    fatal: xiFatal,
    secret: SECRET,
  });

  const chunk = async () => ({ path: (await wavFile()).path, index: 0, start: 0, end: 18 });

  it('text: sends the glossary as repeated keyterms, asks for diarized word timestamps without audio events', async () => {
    const b = viaHttp<TextProvider>('text', 'elevenlabs', XI, [{ body: scribe }]);
    await b.provider.transcribe(await chunk(), { prompt: 'Ad for DriveCover.', keywords: ['DriveCover', 'Lumora', 'drivecover'] });
    const req = b.requests()[0]!;
    expect(req.url).toBe('https://api.elevenlabs.io/v1/speech-to-text');
    expect(req.headers.get('xi-api-key')).toBe(SECRET);
    expect(body(req)).toMatchObject({ model_id: 'scribe_v2', diarize: 'true', timestamps_granularity: 'word', tag_audio_events: 'false' });
    expect(xiTerms(req)).toEqual(['DriveCover', 'Lumora']);
    expect(body(req).prompt).toBeUndefined();
  });

  it('text: several candidate languages send no language_code (Scribe detects and follows switches)', async () => {
    const b = viaHttp<TextProvider>('text', 'elevenlabs', XI, [{ body: scribe }]);
    await b.provider.transcribe(await chunk(), { language: 'en', languages: ['en', 'es'] });
    expect(body(b.requests()[0]!).language_code).toBeUndefined();
  });

  it('takes the whole WAV in one call and gives its words with speakers (for --timing same)', async () => {
    const b = viaHttp<TextProvider>('text', 'elevenlabs', XI, [{ body: scribe }]);
    expect(b.provider.input).toBe('wav');
    const res = await b.provider.transcribe(await chunk(), {});
    expect(expectTimedWords(res.words!, { duration: 18 })).toEqual(['S1', 'S2']);
  });

  it('ELEVENLABS_BASE_URL replaces the host; a 400 names the service\'s message', async () => {
    const b = viaHttp<TimingProvider>('timing', 'elevenlabs', { ...XI, ELEVENLABS_BASE_URL: 'https://api.eu.residency.elevenlabs.io/' }, [{
      status: 400,
      body: { detail: { type: 'validation_error', code: 'invalid_parameters', message: "Invalid language code received: 'xx'.", status: 'invalid_language_code', param: 'language_code' } },
    }]);
    await expect(b.provider.align({ path: (await chunk()).path, duration: 18 }, {})).rejects.toThrow(/HTTP 400: Invalid language code received: 'xx'\. \(invalid_language_code\)/);
    expect(b.requests()).toHaveLength(1);
    expect(b.requests()[0]!.url).toBe('https://api.eu.residency.elevenlabs.io/v1/speech-to-text');
  });
});

// ---------------------------------------------------------------- Azure MAI-Transcribe (text + timing, multipart over fetch)

describe('azure-mai', () => {
  const MAI = { AZURE_MAI_KEY: SECRET, AZURE_MAI_ENDPOINT: 'https://example-foundry.cognitiveservices.azure.com/' };
  const recorded = fixture('azure-mai/transcribe.json');
  const maiDefinition = (c: Captured) => JSON.parse(body(c).definition as string) as {
    locales?: string[];
    phraseList?: { phrases: string[] };
    diarization?: { enabled: boolean };
    enhancedMode?: { enabled: boolean; model: string; modelOptions?: Record<string, string> };
  };
  // the Speech API's error body: { error: { code, message } }
  const maiFatal: Scripted = { status: 401, body: { error: { code: '401', message: `Access denied for key ${SECRET}` } } };
  const maiTransient: Scripted = { status: 429, headers: { 'retry-after': '0' }, body: { error: { code: 'TooManyRequests', message: 'Too many requests' } } };
  const expectedText = 'Welcome back to the show. Today we talk about Overtone captions. Thanks for having me. Um, I think captions should show every hesitation.';

  textConformance({
    name: 'azure-mai (text, mai-transcribe-2)',
    make: async (steps) => viaHttp<TextProvider>('text', 'azure-mai', MAI, steps),
    ok: { body: recorded },
    expectedText,
    expectedLanguage: 'en',
    // MAI has no prompt field: the context is not sent, the glossary goes in as the phrase list (tested below)
    promptless: true,
    promptOf: () => undefined,
    languageOf: (c) => maiDefinition(c).locales?.[0],
    audioOf: (c) => (body(c).audio as { name: string }).name,
    wordTimings: true,
    transient: maiTransient,
    fatal: maiFatal,
    secret: SECRET,
  });

  timingConformance({
    name: 'azure-mai (timing, mai-transcribe-2)',
    make: async (steps) => viaHttp<TimingProvider>('timing', 'azure-mai', MAI, steps),
    ok: { body: recorded },
    expectedWords: 23,
    expectedSpeakers: 2,
    languageOf: (c) => maiDefinition(c).locales?.[0],
    phrasesOf: (c) => (maiDefinition(c).phraseList?.phrases ?? []).join(', '),
    transient: maiTransient,
    fatal: maiFatal,
    secret: SECRET,
  });

  it('asks for MAI-Transcribe-2 with word timestamps, diarization and verbatim style; the glossary as phrase list', async () => {
    const b = viaHttp<TimingProvider>('timing', 'azure-mai', MAI, [{ body: recorded }]);
    await b.provider.align(await wavFile(), { language: 'nl-NL', phrases: ['Overtone', 'overtone', ' '] });
    const req = b.requests()[0]!;
    expect(req.url).toBe('https://example-foundry.cognitiveservices.azure.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15');
    expect(req.headers.get('Ocp-Apim-Subscription-Key')).toBe(SECRET);
    expect(maiDefinition(req)).toEqual({
      locales: ['nl'],
      diarization: { enabled: true },
      phraseList: { phrases: ['Overtone'] },
      enhancedMode: { enabled: true, model: 'MAI-Transcribe-2', modelOptions: { timestamps: 'word', transcribeStyle: 'verbatim' } },
    });
  });

  it('sends no locale for several candidates or a language MAI does not list', async () => {
    const b = viaHttp<TimingProvider>('timing', 'azure-mai', MAI, [{ body: recorded }, { body: recorded }]);
    await b.provider.align(await wavFile(), { language: 'en', languages: ['en', 'es'] });
    await b.provider.align(await wavFile(), { language: 'xx' });
    for (const c of b.requests()) expect(maiDefinition(c).locales).toBeUndefined();
  });

  it('drops the phrase confidence MAI reports as 0, and builds the host from AZURE_MAI_REGION', async () => {
    const b = viaHttp<TimingProvider>('timing', 'azure-mai', { AZURE_MAI_KEY: SECRET, AZURE_MAI_REGION: 'northeurope' }, [{ body: recorded }]);
    const res = await b.provider.align(await wavFile(), {});
    expect(res.words.every((w) => w.confidence === undefined)).toBe(true);
    expect(res.text).toBe(expectedText);
    expect(b.requests()[0]!.url).toMatch(/^https:\/\/northeurope\.api\.cognitive\.microsoft\.com\/speechtotext\//);
  });

  it('refuses an unknown model, and names the service\'s message on a 400', async () => {
    expect(() => viaHttp('timing', 'azure-mai:mai-transcribe-9', MAI, [])).toThrow(/Unknown azure-mai model "mai-transcribe-9"; supported: mai-transcribe-2/);
    const b = viaHttp<TimingProvider>('timing', 'azure-mai', MAI, [{
      status: 400,
      body: { code: 'InvalidRequest', message: "Requested MAI transcription model 'MAI-Transcribe-99' is not supported." },
    }]);
    await expect(b.provider.align(await wavFile(), {})).rejects.toThrow(/HTTP 400.*not supported/);
    expect(b.requests()).toHaveLength(1);
  });
});
