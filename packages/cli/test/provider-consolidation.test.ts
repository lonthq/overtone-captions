// One way of doing things across the providers: HTTP errors, environment variables, redaction, shared pieces
// (lang-codes.ts, ImplausibleTranscriptError) and the request cache keys of ElevenLabs Scribe.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cachedLlm, cachedText, cachedTiming, hashJson, RequestCache, REQUEST_CACHE_VERSION } from '../src/cache.js';
import { parseModelSpec } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { memoryLogger } from '../src/log.js';
import * as azureSpeech from '../src/providers/azure-speech.js';
import * as elevenlabs from '../src/providers/elevenlabs.js';
import {
  defineProvider,
  displayUrl,
  envEnum,
  envFlag,
  envInt,
  envNumber,
  envString,
  httpErrorFrom,
  jsonErrorField,
  type AnyProvider,
} from '../src/providers/kit.js';
import { fromIso639_3, fromWhisperName, toIso639_3, toLocale } from '../src/providers/lang-codes.js';
import { OllamaLlmProvider, ollamaProvider } from '../src/providers/ollama.js';
import { azureTextShape, createOpenAIClient, OPENAI_CACHE_WARMUP_MS, openaiProvider } from '../src/providers/openai.js';
import { createProvider, createProviders, preflight, registerProvider, resolveSelection, secondOpinionSelection } from '../src/providers/registry.js';
import {
  ImplausibleTranscriptError,
  IMPLAUSIBLE_TRANSCRIPT,
  isImplausibleTranscript,
  type LlmProvider,
  type TextProvider,
  type TimingProvider,
} from '../src/providers/types.js';
import { whisperCppProvider } from '../src/providers/whisper-cpp.js';
import { HttpError } from '../src/util/retry.js';
import { tempDir } from './tmp.js';

const SECRET = 'sk-consolidation-SECRET-0123456789';

async function audioFile(name = 'audio.wav', content = 'RIFF0000WAVEfmt '): Promise<string> {
  const path = join(await tempDir('overtone-consolidation-'), name);
  await writeFile(path, content);
  return path;
}

describe('httpErrorFrom', () => {
  it('redacts, then extracts the service message, then cuts to 500 characters; keeps status and headers', async () => {
    const body = JSON.stringify({ error: `${'x'.repeat(600)} ${SECRET}` });
    const err = await httpErrorFrom(new Response(body, { status: 429, headers: { 'retry-after': '3' } }), 'Svc', [SECRET], jsonErrorField);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(429);
    expect(err.headers?.get('retry-after')).toBe('3');
    expect(err.message.startsWith('Svc returned HTTP 429: xxx')).toBe(true);
    expect(err.message).not.toContain('{"error"');
    expect(err.message.length).toBe('Svc returned HTTP 429: '.length + 500);
  });

  it('never leaks a prefix of a key that straddles the cut', async () => {
    const err = await httpErrorFrom(new Response(`${'x'.repeat(495)}${SECRET}`, { status: 401 }), 'Svc', [SECRET]);
    expect(err.message).not.toContain(SECRET.slice(0, 5));
  });

  it('keeps the body when the extractor finds nothing or fails, and leaves secrets under 8 characters alone', async () => {
    expect((await httpErrorFrom(new Response('<html>bad gateway</html>', { status: 502 }), 'Svc', ['k'], jsonErrorField)).message).toBe('Svc returned HTTP 502: <html>bad gateway</html>');
    expect((await httpErrorFrom(new Response('{"detail":"no"}', { status: 400 }), 'Svc', [], jsonErrorField)).message).toBe('Svc returned HTTP 400: {"detail":"no"}');
    expect(jsonErrorField('{"error":{"message":"m"}}')).toBe('m');
  });
});

describe('Ollama answers', () => {
  const cfg = (fetch: typeof globalThis.fetch) => ({ host: 'http://localhost:11434', model: 'qwen3:8b', numCtx: 16384, maxTokens: 8192, think: false, responseFormat: 'json_schema' as const, fetch, retry: { sleep: async () => {} } });
  const req = { name: 'n', system: 's', user: 'u', schema: { type: 'object' } };

  it('keeps the error field of a long JSON error body', async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: `model failed: ${'z'.repeat(700)}` }), { status: 400 })) as typeof globalThis.fetch;
    await expect(new OllamaLlmProvider('ollama:qwen3:8b', cfg(fetch)).complete(req)).rejects.toThrow(/^Ollama returned HTTP 400: model failed: z+$/);
  });

  it('says to check OLLAMA_BASE_URL when a 200 answer is not JSON lines (a proxy page)', async () => {
    const fetch = (async () => new Response('<html><body>Sign in</body></html>', { status: 200 })) as typeof globalThis.fetch;
    const err = await new OllamaLlmProvider('ollama:qwen3:8b', { ...cfg(fetch), host: 'http://me:pw-123456789@proxy.local:8080' }).complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toMatch(/OLLAMA_BASE_URL/);
    expect((err as Error).message).toContain('http://proxy.local:8080');
    expect((err as Error).message).not.toContain('pw-123456789');
  });

  it('prints the server address without its user name and password in preflight errors', async () => {
    const fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof globalThis.fetch;
    const err = await ollamaProvider.preflight!({ OLLAMA_BASE_URL: 'http://me:pw-123456789@ollama.local:11434' }, 'qwen3:8b', { role: 'llm', id: 'ollama:qwen3:8b', cwd: '.', fetch }).catch((e: unknown) => e);
    expect((err as Error).message).toContain('Ollama is not reachable at http://ollama.local:11434.');
    expect((err as Error).message).not.toContain('pw-123456789');
  });
});

describe('environment variables', () => {
  it('envString trims and treats empty and whitespace-only as unset', () => {
    expect(envString({ A: '  x ' }, 'A')).toBe('x');
    expect(envString({ A: '   ' }, 'A')).toBeUndefined();
    expect(envString({}, 'A')).toBeUndefined();
  });

  it('envFlag takes 1/true/yes/on and 0/false/no/off in any case; anything else names the variable and the values', () => {
    for (const v of ['1', 'TRUE', 'yes', ' On ']) expect(envFlag({ F: v }, 'F')).toBe(true);
    for (const v of ['0', 'false', 'No', 'off']) expect(envFlag({ F: v }, 'F', true)).toBe(false);
    expect(envFlag({ F: ' ' }, 'F', true)).toBe(true);
    expect(() => envFlag({ F: 'maybe' }, 'F')).toThrow(new UserError('F must be one of 1, true, yes, on, 0, false, no, off (got "maybe").'));
  });

  it('envInt and envNumber check the kind and the limits', () => {
    expect(envInt({ N: ' 300 ' }, 'N', 256)).toBe(300);
    expect(envInt({}, 'N')).toBeUndefined();
    expect(() => envInt({ N: '255' }, 'N', 256)).toThrow('N must be an integer of at least 256 (got "255").');
    expect(() => envInt({ N: '2.5' }, 'N')).toThrow(UserError);
    expect(envNumber({ N: '2.5' }, 'N', { above: 0 })).toBe(2.5);
    expect(() => envNumber({ N: '0' }, 'N', { above: 0, unit: 'seconds' })).toThrow('N must be a number of seconds above 0 (got "0").');
    expect(() => envNumber({ N: 'ten' }, 'N')).toThrow(UserError);
  });

  it('envEnum matches in any case and returns the listed value', () => {
    expect(envEnum({ E: ' JSON_Object ' }, 'E', ['json_schema', 'json_object'] as const)).toBe('json_object');
    expect(envEnum({}, 'E', ['a'])).toBeUndefined();
    expect(() => envEnum({ E: 'c' }, 'E', ['a', 'b'])).toThrow('E must be one of a, b (got "c").');
  });

  it('a whitespace-only AZURE_SPEECH_ENDPOINT counts as unset: the region builds the host', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => { urls.push(url); return new Response(JSON.stringify({ phrases: [] }), { status: 200 }); }) as unknown as typeof globalThis.fetch;
    const p = azureSpeech.azureSpeechProvider.create({ AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: ' westeurope ', AZURE_SPEECH_ENDPOINT: '   ' }, 'fast', { role: 'timing', id: 'azure-speech:fast', cwd: '.', fetch }) as TimingProvider;
    await p.align({ path: await audioFile(), duration: 1 }, {});
    expect(urls[0]).toMatch(/^https:\/\/westeurope\.api\.cognitive\.microsoft\.com\/speechtotext\//);
    expect(p.id).toBe('azure-speech:fast');
  });

  it('a whitespace-only OPENAI_BASE_URL counts as unset: OpenAI itself', () => {
    const client = createOpenAIClient({ OPENAI_API_KEY: SECRET, OPENAI_BASE_URL: '  ' }) as unknown as { baseURL: string };
    expect(client.baseURL).toBe('https://api.openai.com/v1');
    const fake = { audio: { transcriptions: { create: async () => ({}) } }, chat: { completions: { create: async () => ({}) } } };
    const p = openaiProvider.create({ OPENAI_API_KEY: SECRET, OPENAI_BASE_URL: ' ' }, 'gpt-6.1-sol', { role: 'llm', id: 'openai:gpt-6.1-sol', cwd: '.', openai: () => fake }) as LlmProvider;
    expect(p.cacheWarmupMs).toBe(OPENAI_CACHE_WARMUP_MS);
    expect(p.settings).toBeUndefined();
  });

  it('flags read the same everywhere: yes turns on Azure keywords and tinydiarize; a bad value is a UserError', () => {
    expect(azureTextShape({ AZURE_OPENAI_TRANSCRIBE_KEYWORDS: 'yes' }).keywords).toBe(true);
    expect(azureTextShape({}).keywords).toBe(false);
    expect(() => azureTextShape({ AZURE_OPENAI_TRANSCRIBE_KEYWORDS: 'maybe' })).toThrow(/AZURE_OPENAI_TRANSCRIBE_KEYWORDS must be one of/);
    const deps = { role: 'text' as const, id: 'whisper-cpp:/m/custom.bin', cwd: '/' };
    expect((whisperCppProvider.create({ WHISPER_CPP_TDRZ: 'on' }, '/m/custom.bin', deps) as unknown as { args(w: string, o: object): string[] }).args('a.wav', {})).toContain('-tdrz');
    expect(() => whisperCppProvider.create({ WHISPER_CPP_TDRZ: 'maybe' }, '/m/custom.bin', deps)).toThrow(/WHISPER_CPP_TDRZ must be one of/);
    expect(() => whisperCppProvider.create({ WHISPER_CPP_THREADS: '0' }, '/m/custom.bin', deps)).toThrow('WHISPER_CPP_THREADS must be an integer of at least 1 (got "0").');
  });
});

describe('secrets in warnings, preflight errors and shared instances', () => {
  let remove: () => void = () => {};
  afterEach(() => remove());

  const leaky = (overrides: Partial<Parameters<typeof defineProvider>[0]> = {}) => defineProvider({
    id: 'leaky',
    description: 'test provider that echoes its key',
    roles: ['text', 'timing'],
    env: [{ name: 'LEAKY_API_KEY', description: 'key', required: true, secret: true }],
    defaults: { text: 'm', timing: 'm' },
    create: (_env, _model, deps): AnyProvider => ({
      id: deps.id,
      transcribe: async () => { throw new Error(`text failed for key ${SECRET}`); },
      align: async () => { throw new Error(`timing failed for key ${SECRET}`); },
    }),
    ...overrides,
  });

  it('redacts the reason of a retry warning that has no HTTP status', async () => {
    const { withRetry } = await import('../src/util/retry.js');
    remove = registerProvider(leaky({
      create: (_env, _model, deps): AnyProvider => ({
        id: deps.id,
        transcribe: () => withRetry(async () => { throw Object.assign(new Error(`socket closed at https://x.test/?key=${SECRET}`), { code: 'ECONNRESET' }); }, deps.retry),
      }),
    }));
    const log = memoryLogger();
    const sel = resolveSelection(parseModelSpec('leaky'), 'text');
    const p = createProvider('text', sel, { LEAKY_API_KEY: SECRET }, { cwd: '.', log, deps: { retry: { retries: 1, sleep: async () => {} } } }) as TextProvider;
    await expect(p.transcribe({ path: 'x', index: 0, start: 0, end: 1 }, {})).rejects.toThrow('[redacted]');
    const warnings = log.lines.filter((l) => l.startsWith('warn:'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('[redacted]');
    expect(warnings.join('\n')).not.toContain(SECRET.slice(0, 12));
  });

  it('redacts preflight errors', async () => {
    remove = registerProvider(leaky({ preflight: async () => { throw new UserError(`server refused key ${SECRET}`); } }));
    const sel = resolveSelection(parseModelSpec('leaky'), 'text');
    const rec = resolveSelection(parseModelSpec('recorded:x'), 'llm');
    const err = await preflight({ text: sel, timing: { ...sel, same: true }, llm: rec }, { LEAKY_API_KEY: SECRET }, { cwd: '.' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe('server refused key [redacted]');
  });

  it('redacts the errors of every role of a shared instance', async () => {
    remove = registerProvider(leaky({ shareKey: () => 'one' }));
    const text = resolveSelection(parseModelSpec('leaky'), 'text');
    const timing = resolveSelection(parseModelSpec('leaky'), 'timing');
    const llm = resolveSelection(parseModelSpec('recorded:x'), 'llm');
    const p = createProviders({ text, timing, llm }, { LEAKY_API_KEY: SECRET }, { cwd: '.' });
    await expect(p.text.transcribe({ path: 'x', index: 0, start: 0, end: 1 }, {})).rejects.toThrow('text failed for key [redacted]');
    await expect(p.timing.align({ path: 'x', duration: 1 }, {})).rejects.toThrow('timing failed for key [redacted]');
  });

  it('displayUrl drops the user name and password, nothing else', () => {
    expect(displayUrl('http://user:pass@localhost:11434')).toBe('http://localhost:11434');
    expect(displayUrl('https://u:p@host.test/v1/')).toBe('https://host.test/v1/');
    expect(displayUrl('http://localhost:11434')).toBe('http://localhost:11434');
  });
});

describe('shared pieces', () => {
  it('ImplausibleTranscriptError lives in types.ts; elevenlabs.ts re-exports the same class', () => {
    expect(elevenlabs.ImplausibleTranscriptError).toBe(ImplausibleTranscriptError);
    const err = new ImplausibleTranscriptError('no transcript');
    expect(err.name).toBe(IMPLAUSIBLE_TRANSCRIPT);
    expect(isImplausibleTranscript(err)).toBe(true);
    // replayed from the request cache: a plain Error with that name
    expect(isImplausibleTranscript(Object.assign(new Error('x'), { name: IMPLAUSIBLE_TRANSCRIPT }))).toBe(true);
    expect(isImplausibleTranscript(new Error('x'))).toBe(false);
  });

  it('language codes come from lang-codes.ts', () => {
    expect(azureSpeech.toLocale).toBe(toLocale);
    expect(toLocale('et')).toBe('et-EE');
    expect(toIso639_3('nl-BE')).toBe('nld');
    expect(toIso639_3('yue')).toBeUndefined();
    expect(fromIso639_3('cmn')).toBe('zh');
    expect(fromWhisperName('Dutch')).toBe('nl');
    expect(fromWhisperName('nl')).toBeUndefined();
  });

  it('the recorded provider takes its id from deps.id', () => {
    const p = createProvider('text', resolveSelection(parseModelSpec('recorded:fixtures/x'), 'text'), {}, { cwd: '/tmp' });
    expect(p.id).toBe('recorded:fixtures/x');
  });
});

describe('request cache: ElevenLabs Scribe', () => {
  const HEALTHY = readFileSync(new URL('./conformance/fixtures/elevenlabs/speech-to-text.json', import.meta.url), 'utf8');

  function scribe(id = 'elevenlabs:scribe_v2') {
    const calls: Array<Record<string, unknown>> = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      const form = init.body as FormData;
      calls.push({ language: form.get('language_code'), keyterms: form.getAll('keyterms') });
      return new Response(HEALTHY, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const cfg = { key: SECRET, baseUrl: 'https://api.elevenlabs.io', model: 'scribe_v2', fetch, retry: { sleep: async () => {} } };
    return { calls, text: new elevenlabs.ElevenLabsProvider(id, cfg), timing: new elevenlabs.ElevenLabsProvider(id, cfg) };
  }

  it('sends one request for the text and timing roles, and none for a prompt-only change', async () => {
    const path = await audioFile();
    const dir = await tempDir('overtone-requests-');
    const cache = new RequestCache(dir, { useCache: true });
    const { calls, text, timing } = scribe();
    const chunk = { path, index: 0, start: 0, end: 18 };
    const first = await cachedText(text, cache, 'transcribe').transcribe(chunk, { language: 'en', prompt: 'A talk.', keywords: ['Overtone'] });
    // --two-pass, --context, --numbers, --style-guide: only the prompt changes, which Scribe does not get
    await cachedText(text, cache, 'timing').transcribe(chunk, { language: 'en', prompt: 'Another prompt.', keywords: ['Overtone'] });
    // the second hearing (timing role) of the same file, language and glossary
    const heard = await cachedTiming(timing, cache, 'timing').align({ path, duration: 18 }, { language: 'en', phrases: ['Overtone'] });
    expect(calls).toHaveLength(1);
    expect(cache.counts).toEqual({ sent: 1, cached: 2 });
    expect(heard).toEqual({ words: first.words, language: first.language });
    expect(heard).not.toHaveProperty('text');
    expect((await readdir(join(dir, 'requests'))).every((f) => /^speech-[0-9a-f]{16}\.json$/.test(f))).toBe(true);
    // what Scribe gets does change: another glossary, another language
    await cachedTiming(timing, cache, 'timing').align({ path, duration: 18 }, { language: 'en', phrases: ['Lumora'] });
    await cachedTiming(timing, cache, 'timing').align({ path, duration: 18 }, { language: 'nl', phrases: ['Overtone'] });
    expect(calls).toHaveLength(3);
  });

  it('answers the text role from a timing request too, with the text', async () => {
    const path = await audioFile();
    const cache = new RequestCache(await tempDir('overtone-requests-'), { useCache: true });
    const { calls, text, timing } = scribe();
    const heard = await cachedTiming(timing, cache, 'timing').align({ path, duration: 18 }, { languages: ['en', 'es'], language: 'en' });
    const res = await cachedText(text, cache, 'transcribe').transcribe({ path, index: 0, start: 0, end: 18 }, { languages: ['en', 'es'], language: 'en', prompt: 'p' });
    expect(calls).toHaveLength(1);
    expect(res.text).toMatch(/\w/);
    expect(res.words).toEqual(heard.words);
  });

  it('the automatic second hearing is not Scribe when the text already comes from Scribe', () => {
    const azure = { provider: 'azure-speech', model: 'fast', id: 'azure-speech:fast' };
    const env = { ELEVENLABS_API_KEY: 'fake-key' };
    expect(secondOpinionSelection('auto', azure, env, { provider: 'elevenlabs', model: 'scribe_v2', id: 'elevenlabs:scribe_v2' })).toBeUndefined();
    expect(secondOpinionSelection('auto', azure, env, { provider: 'openai', model: 'gpt-transcribe', id: 'openai:gpt-transcribe' })?.id).toBe('elevenlabs:scribe_v2');
  });
});

describe('request cache: keys of other providers are unchanged', () => {
  const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

  it('an OpenAI text request and an Azure Speech timing request keep the key they had', async () => {
    const path = await audioFile('a.mp3', 'audio A');
    const dir = await tempDir('overtone-requests-');
    const cache = new RequestCache(dir, { useCache: true });
    const text: TextProvider = { id: 'openai:gpt-transcribe', settings: { server: 'abc123' }, transcribe: async () => ({ text: 'hi' }) };
    const timing: TimingProvider = { id: 'azure-speech:fast', settings: { profanity: 'none' }, align: async () => ({ words: [] }) };
    const o = { language: 'en', languages: ['en', 'es'], prompt: 'A talk.', keywords: ['Overtone'] };
    await cachedText(text, cache, 'transcribe').transcribe({ path, index: 0, start: 0, end: 5 }, o);
    await cachedTiming(timing, cache, 'timing').align({ path, duration: 5 }, { language: 'en', phrases: ['Overtone'] });
    // the key built from the request fields, for providers without cacheInputs
    const audio = sha256('audio A');
    const textKey = hashJson({ version: REQUEST_CACHE_VERSION, role: 'text', provider: text.id, request: { settings: text.settings, audio, language: 'en', languages: ['en', 'es'], prompt: 'A talk.', keywords: ['Overtone'] } });
    const timingKey = hashJson({ version: REQUEST_CACHE_VERSION, role: 'timing', provider: timing.id, request: { settings: timing.settings, audio, language: 'en', phrases: ['Overtone'] } });
    // pinned, so a change to hashJson or the request shape shows up here too
    expect([textKey, timingKey]).toEqual(['82d4838ff8bd5a78', '21d0fc4106afe96e']);
    expect((await readdir(join(dir, 'requests'))).sort()).toEqual([`text-${textKey}.json`, `timing-${timingKey}.json`].sort());
  });

  it('an LLM request keeps its key', async () => {
    const dir = await tempDir('overtone-requests-');
    const llm: LlmProvider = { id: 'azure-openai:gpt', settings: { server: 'abc' }, complete: async <T>() => ({ ok: true }) as T };
    await cachedLlm(llm, new RequestCache(dir, { useCache: true }), 'refine').complete({ name: 'edits', system: 's', user: 'u', schema: { type: 'object' }, effort: 'low' });
    const key = hashJson({ version: REQUEST_CACHE_VERSION, role: 'llm', provider: llm.id, request: { settings: llm.settings, system: 's', user: 'u', schema: { type: 'object' }, schemaName: 'edits', effort: 'low' } });
    expect(await readdir(join(dir, 'requests'))).toEqual([`llm-${key}.json`]);
  });
});
