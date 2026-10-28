import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RELISTEN, snapWindow } from '../src/align/relisten.js';
import { cachedLlm, cachedText, cachedTiming, RequestCache } from '../src/cache.js';
import { resolveConfig, type CliFlags } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { runPipeline } from '../src/pipeline.js';
import { createProvider, type Providers } from '../src/providers/registry.js';
import type { AudioChunk, AudioFile, LlmProvider, LlmRequest, TextOptions, TextProvider, TimingProvider } from '../src/providers/types.js';
import type { TimedWord } from '../src/types.js';
import { formatUsage, UsageMeter } from '../src/usage.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

async function audioFiles(dir: string) {
  const a = join(dir, 'a.mp3');
  const b = join(dir, 'b.mp3');
  const copy = join(dir, 'copy-of-a.mp3');
  await writeFile(a, 'audio A');
  await writeFile(b, 'audio B');
  await writeFile(copy, 'audio A');
  return { a, b, copy };
}

function countingText(id = 'fake:text'): TextProvider & { calls: string[] } {
  const calls: string[] = [];
  return { id, calls, transcribe: async (chunk: AudioChunk, o: TextOptions) => { calls.push(chunk.path); return { text: `heard ${o.prompt ?? ''}`.trim() }; } };
}

const piece = (path: string): AudioChunk => ({ path, index: 0, start: 0, end: 5 });

describe('request cache', () => {
  it('returns the answer when it cannot be written, and reports the failure', async () => {
    const dir = await tempDir('overtone-requests-');
    const { a } = await audioFiles(dir);
    await writeFile(join(dir, 'requests'), 'a file where the cache folder should be');
    const failures: string[] = [];
    const cache = new RequestCache(dir, { useCache: true, onWriteError: (file) => failures.push(file) });
    const p = countingText();
    expect(await cachedText(p, cache, 'transcribe').transcribe(piece(a), { prompt: 'A film.' })).toEqual({ text: 'heard A film.' });
    expect(p.calls).toEqual([a]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/requests[\\/]text-[0-9a-f]{16}\.json$/);
  });

  it('sends a request once and keys it by the audio bytes and the options, not by the file name', async () => {
    const dir = await tempDir('overtone-requests-');
    const { a, b, copy } = await audioFiles(dir);
    const cache = new RequestCache(dir, { useCache: true });
    const p = countingText();
    const text = cachedText(p, cache, 'transcribe');
    expect(await text.transcribe(piece(a), { prompt: 'A film.' })).toEqual({ text: 'heard A film.' });
    await text.transcribe(piece(a), { prompt: 'A film.' });
    await text.transcribe(piece(copy), { prompt: 'A film.' }); // same bytes, another file
    expect(p.calls).toEqual([a]);
    await text.transcribe(piece(a), { prompt: 'A talk.' }); // another prompt
    await text.transcribe(piece(b), { prompt: 'A film.' }); // other audio
    await text.transcribe(piece(a), { prompt: 'A film.', language: 'nl' }); // another language
    expect(p.calls).toEqual([a, a, b, a]);
    expect(cache.counts).toEqual({ sent: 4, cached: 2 });
    const files = await readdir(join(dir, 'requests'));
    expect(files).toHaveLength(4);
    expect(files.every((f) => /^text-[0-9a-f]{16}\.json$/.test(f))).toBe(true);
    // a new run (new instance) reuses the answers on disk
    const again = countingText();
    await cachedText(again, new RequestCache(dir, { useCache: true }), 'transcribe').transcribe(piece(a), { prompt: 'A film.' });
    expect(again.calls).toEqual([]);
  });

  it('keys by provider id and settings: another model or another setting is another request', async () => {
    const dir = await tempDir('overtone-requests-');
    const { a } = await audioFiles(dir);
    const cache = new RequestCache(dir, { useCache: true });
    const calls: string[] = [];
    const timing = (id: string, settings?: Record<string, unknown>): TimingProvider => ({ id, ...(settings ? { settings } : {}), align: async () => { calls.push(id); return { words: [] }; } });
    const audio: AudioFile = { path: a, duration: 5 };
    await cachedTiming(timing('azure-speech:fast', { profanity: 'none' }), cache, 'timing').align(audio, {});
    await cachedTiming(timing('azure-speech:fast', { profanity: 'none' }), cache, 'timing').align(audio, {});
    await cachedTiming(timing('azure-speech:fast', { profanity: 'masked' }), cache, 'timing').align(audio, {});
    await cachedTiming(timing('elevenlabs:scribe_v2'), cache, 'timing').align(audio, {});
    await cachedTiming(timing('elevenlabs:scribe_v2'), cache, 'timing').align(audio, { phrases: ['Overtone'] });
    expect(calls).toEqual(['azure-speech:fast', 'azure-speech:fast', 'elevenlabs:scribe_v2', 'elevenlabs:scribe_v2']);
  });

  it('--no-cache sends every request again (and still writes the answers)', async () => {
    const dir = await tempDir('overtone-requests-');
    const { a } = await audioFiles(dir);
    const p = countingText();
    const off = cachedText(p, new RequestCache(dir, { useCache: false }), 'transcribe');
    await off.transcribe(piece(a), {});
    await off.transcribe(piece(a), {});
    expect(p.calls).toHaveLength(2);
    await cachedText(p, new RequestCache(dir, { useCache: true }), 'transcribe').transcribe(piece(a), {});
    expect(p.calls).toHaveLength(2);
  });

  it('--from-stage sends the requests of that stage and later ones again, and reuses earlier ones', async () => {
    const dir = await tempDir('overtone-requests-');
    const { a } = await audioFiles(dir);
    const p = countingText();
    const first = new RequestCache(dir, { useCache: true });
    await cachedText(p, first, 'transcribe').transcribe(piece(a), {});
    await cachedText(p, first, 'timing').transcribe(piece(a), { prompt: 'retry' });
    const fromTiming = new RequestCache(dir, { useCache: true, fromStage: 'timing' });
    expect((['extract', 'transcribe', 'timing', 'align', 'refine'] as const).map((s) => fromTiming.allows(s))).toEqual([true, true, false, false, false]);
    await cachedText(p, fromTiming, 'transcribe').transcribe(piece(a), {});
    await cachedText(p, fromTiming, 'timing').transcribe(piece(a), { prompt: 'retry' });
    expect(p.calls).toHaveLength(3);
  });

  it('sends identical requests in flight at the same time once, and reports cached hits', async () => {
    const dir = await tempDir('overtone-requests-');
    const { a } = await audioFiles(dir);
    const hits: string[] = [];
    const cache = new RequestCache(dir, { useCache: true, onHit: (role, id) => hits.push(`${role} ${id}`) });
    const p = countingText();
    const text = cachedText(p, cache, 'transcribe');
    const answers = await Promise.all([text.transcribe(piece(a), {}), text.transcribe(piece(a), {}), text.transcribe(piece(a), {})]);
    expect(answers).toEqual([{ text: 'heard' }, { text: 'heard' }, { text: 'heard' }]);
    expect(p.calls).toHaveLength(1);
    expect(hits).toEqual(['text fake:text', 'text fake:text']);
  });

  it('caches an error the caller names as an answer (Scribe hearing no plausible transcript), never a failure', async () => {
    const dir = await tempDir('overtone-requests-');
    const { a, b } = await audioFiles(dir);
    const cache = new RequestCache(dir, { useCache: true });
    let calls = 0;
    const scribe: TimingProvider = {
      id: 'elevenlabs:scribe_v2',
      align: async (audio) => {
        calls++;
        const err = new Error(audio.path === a ? 'no plausible transcript, twice' : 'HTTP 503');
        err.name = audio.path === a ? 'ImplausibleTranscriptError' : 'Error';
        throw err;
      },
    };
    const timing = cachedTiming(scribe, cache, 'timing', { answerErrors: ['ImplausibleTranscriptError'] });
    for (let i = 0; i < 2; i++) await expect(timing.align({ path: a, duration: 5 }, {})).rejects.toMatchObject({ name: 'ImplausibleTranscriptError', message: 'no plausible transcript, twice' });
    expect(calls).toBe(1);
    for (let i = 0; i < 2; i++) await expect(timing.align({ path: b, duration: 5 }, {})).rejects.toThrow('HTTP 503');
    expect(calls).toBe(3);
    // without the option (the whole-file timing request) it is a failure: tried again next time
    const plain = cachedTiming(scribe, new RequestCache(await tempDir('overtone-requests-'), { useCache: true }), 'timing');
    for (let i = 0; i < 2; i++) await expect(plain.align({ path: a, duration: 5 }, {})).rejects.toThrow('no plausible transcript');
    expect(calls).toBe(5);
  });

  it('treats a corrupt entry as a miss, and leaves providers marked uncached alone', async () => {
    const dir = await tempDir('overtone-requests-');
    const { a } = await audioFiles(dir);
    const p = countingText();
    await cachedText(p, new RequestCache(dir, { useCache: true }), 'transcribe').transcribe(piece(a), {});
    const [file] = await readdir(join(dir, 'requests'));
    await writeFile(join(dir, 'requests', file!), '{oops');
    await cachedText(p, new RequestCache(dir, { useCache: true }), 'transcribe').transcribe(piece(a), {});
    expect(p.calls).toHaveLength(2);
    const recorded = { ...countingText('recorded:x'), uncached: true };
    expect(cachedText(recorded, new RequestCache(dir, { useCache: true }), 'transcribe')).toBe(recorded);
  });

  it('caches LLM requests by prompt, schema, schema name, effort and model; the request name is not sent', async () => {
    const dir = await tempDir('overtone-requests-');
    const cache = new RequestCache(dir, { useCache: true });
    const sent: string[] = [];
    const llm = (id: string): LlmProvider => ({ id, cacheWarmupMs: 1500, complete: async <T>(req: LlmRequest) => { sent.push(`${id} ${req.name}`); return { ok: req.user } as T; } });
    const base: LlmRequest = { name: 'corrections', system: 'S', user: 'U', schema: { type: 'object' }, effort: 'medium' };
    const editor = cachedLlm(llm('openai:m'), cache, 'refine');
    expect(editor.cacheWarmupMs).toBe(0); // nothing sent yet: answers from the cache need no warm-up
    expect(await editor.complete(base)).toEqual({ ok: 'U' });
    expect(editor.cacheWarmupMs).toBe(1500);
    await editor.complete(base);
    await editor.complete({ ...base, name: 'corrections-again', schemaName: 'corrections' });
    expect(sent).toEqual(['openai:m corrections']);
    await editor.complete({ ...base, user: 'U2' });
    await editor.complete({ ...base, system: 'S2' });
    await editor.complete({ ...base, schema: { type: 'array' } });
    await editor.complete({ ...base, schemaName: 'other' });
    await editor.complete({ ...base, effort: 'high' });
    await cachedLlm(llm('openai:other'), cache, 'refine').complete(base);
    expect(sent).toHaveLength(7);
  });
});

describe('provider settings in the request key', () => {
  const settingsOf = (role: 'text' | 'llm' | 'timing', provider: string, model: string, env: NodeJS.ProcessEnv) =>
    createProvider(role, { provider, model, id: `${provider}:${model}` }, env, { cwd: '/w' }).settings;

  it('fingerprint a custom server and name the request shape, never a key', () => {
    expect(settingsOf('llm', 'openai', 'gpt-6.1-sol', { OPENAI_API_KEY: 'sk-test-0123456789' })).toBeUndefined();
    const custom = settingsOf('llm', 'openai', 'qwen', { OPENAI_API_KEY: 'sk-test-0123456789', OPENAI_BASE_URL: 'http://localhost:1234/v1', OPENAI_RESPONSE_FORMAT: 'json_object' });
    expect(custom).toEqual({ server: expect.stringMatching(/^[0-9a-f]{12}$/), responseFormat: 'json_object' });
    const azure = (more: NodeJS.ProcessEnv = {}) => settingsOf('text', 'azure-openai', 'my-dep', { AZURE_OPENAI_ENDPOINT: 'https://a.openai.azure.com', AZURE_OPENAI_API_KEY: 'key-0123456789', ...more });
    expect(azure()).toEqual({ server: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(azure({ AZURE_OPENAI_ENDPOINT: 'https://b.openai.azure.com' })!.server).not.toBe(azure()!.server);
    expect(azure({ AZURE_OPENAI_TRANSCRIBE_MODEL: 'gpt-transcribe', AZURE_OPENAI_TRANSCRIBE_KEYWORDS: '1' })).toMatchObject({ underlyingModel: 'gpt-transcribe', keywords: true });
    expect(settingsOf('timing', 'azure-speech', 'fast', { AZURE_SPEECH_KEY: 'key-0123456789', AZURE_SPEECH_REGION: 'westeurope' })).toEqual({ profanity: 'none' });
    expect(settingsOf('llm', 'ollama', 'qwen3:8b', {})).toMatchObject({ server: expect.stringMatching(/^[0-9a-f]{12}$/), numCtx: expect.any(Number) });
    for (const s of [custom, azure()]) expect(JSON.stringify(s)).not.toMatch(/localhost|azure\.com|key-|sk-/);
  });
});

describe('usage line', () => {
  it('lists the requests answered from the cache after the ones sent, or alone', () => {
    const m = new UsageMeter();
    m.add({ id: 'openai:gpt-transcribe', role: 'text', audioSeconds: 6 });
    m.cached({ id: 'openai:gpt-transcribe', role: 'text' });
    m.cached({ id: 'openai:gpt-transcribe', role: 'text' });
    m.cached({ id: 'azure-speech:fast', role: 'timing' });
    expect(formatUsage(m.list())).toBe('usage: text openai:gpt-transcribe 1 request, 6.0 s audio, 2 from the cache · timing azure-speech:fast 1 request from the cache');
    expect(formatUsage(new UsageMeter().list())).toBeUndefined();
  });
});

describe('re-listen windows on a grid', () => {
  it('widens a window to the 0.25 s grid, so windows a few ms apart send the same audio', () => {
    expect(RELISTEN.grid).toBe(0.25);
    expect(snapWindow(0.5, 21.04, 30)).toEqual({ start: 0.5, end: 21.25 });
    expect(snapWindow(0.502, 21.042, 30)).toEqual({ start: 0.5, end: 21.25 });
    expect(snapWindow(7.61, 12.3, 30)).toEqual({ start: 7.5, end: 12.5 });
    // inside the media
    expect(snapWindow(0.1, 29.9, 29.95)).toEqual({ start: 0, end: 29.95 });
    expect(snapWindow(0, 30.2, 30)).toEqual({ start: 0, end: 30.2 });
  });
});

// ---- the pipeline: what a change re-sends

const said = (text: string, start: number, step = 0.3, speaker = 'S1'): TimedWord[] =>
  text.split(' ').map((t, i) => ({ text: t, start: +(start + i * step).toFixed(3), end: +(start + i * step + step * 0.8).toFixed(3), speaker }));

/** "Hello there." and "See you." heard by the timing provider; the shouting in between only when re-listened. */
const TEXT = 'Hello there. Go now, go! See you.';
const TIMING = [...said('Hello there.', 1), ...said('See you.', 20)];
const SHOUT = said('go now go', 8, 0.4);
const windowOfPath = (path: string): [number, number] => {
  const m = /region-(\d+)-(\d+)/.exec(path)!;
  return [Number(m[1]) / 1000, Number(m[2]) / 1000];
};

/** Fake providers that log every call: `text <path>`, `timing <path>`, `llm <name>`. */
function fakes(): Providers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    text: { id: 'fake:text', transcribe: async (chunk) => { calls.push(`text ${chunk.path.split('/').pop()}`); return { text: TEXT, language: 'en' }; } },
    timing: {
      id: 'fake:timing',
      align: async (audio) => {
        calls.push(`timing ${audio.path.split('/').pop()}`);
        if (!audio.path.includes('region-')) return { words: TIMING, language: 'en-US' };
        const [start, end] = windowOfPath(audio.path);
        return { words: SHOUT.filter((w) => w.start >= start && w.end <= end).map((w) => ({ ...w, start: +(w.start - start).toFixed(3), end: +(w.end - start).toFixed(3) })) };
      },
    },
    llm: {
      id: 'fake:llm',
      async complete<T>(req: LlmRequest): Promise<T> {
        calls.push(`llm ${req.name}`);
        if (req.name === 'corrections') return { edits: [], speakers: [] } as T;
        if (req.name === 'styling') return { styles: [] } as T;
        if (req.name === 'context') return { topic: 'A film.', names: [], terms: [] } as T;
        return { cueStarts: [], lineStarts: [] } as T;
      },
    },
  };
}

describe.skipIf(!hasFfmpeg)('pipeline: provider requests are cached, free steps run again', () => {
  const mutable = <T extends object>(o: T) => o as unknown as Record<keyof T, number>;
  const saved = { pad: RELISTEN.pad };
  afterEach(() => {
    mutable(RELISTEN).pad = saved.pad;
  });

  async function setup(flags: CliFlags = {}) {
    const dir = await tempDir('overtone-requests-pipe-');
    const file = join(dir, 'film.m4a');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=30', '-c:a', 'aac', file]);
    const config = (more: CliFlags = {}) => resolveConfig({ export: 'json', context: 'A film.', language: 'en', ...flags, ...more }, {}, { cwd: dir, configDir: dir });
    const deps = {
      cwd: dir,
      cutAudio: async (input: string, start: number, end: number) => input.replace(/\.wav$/, `.region-${Math.round(start * 1000)}-${Math.round(end * 1000)}.wav`),
    };
    return { file, config, deps };
  }

  it('changing a free step (the re-listen padding by 2 ms) sends no request again', async () => {
    const { file, config, deps } = await setup();
    const cfg = await config();
    const p = fakes();
    const first = await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers: p });
    expect(p.calls).toEqual(['text audio.mp3', 'timing audio.wav', 'timing audio.region-500-21250.wav', 'llm corrections', 'llm styling']);
    expect(first.doc.meta?.timingRetries).toEqual([expect.objectContaining({ provider: 'fake:timing', heard: 3, result: 'heard' })]);

    // the window moves by 2 ms (0.50–21.04 s → 0.502–21.038 s): same requests
    mutable(RELISTEN).pad = 0.498;
    p.calls.length = 0;
    const log = memoryLogger();
    const again = await runPipeline(file, cfg, { ...deps, log, providers: p });
    expect(p.calls).toEqual([]);
    expect(log.lines).toContain('info:   timing: 3 words in 1.54–20.00 s ("Go now, go!") have no timing words; asking fake:timing (timing provider) for 0.50–21.04 s');
    expect(again.doc.turns).toEqual(first.doc.turns);
    expect(again.usageLine).toBe('usage: text fake:text 1 request from the cache · timing fake:timing 2 requests from the cache · llm fake:llm 2 requests from the cache');
  });

  it('a changed context re-sends the requests that carry it, not the timing requests', async () => {
    const { file, config, deps } = await setup();
    const p = fakes();
    await runPipeline(file, await config(), { ...deps, log: memoryLogger(), providers: p });
    p.calls.length = 0;
    const res = await runPipeline(file, await config({ context: 'A short film.' }), { ...deps, log: memoryLogger(), providers: p });
    expect(p.calls).toEqual(['text audio.mp3', 'llm corrections', 'llm styling']);
    // (these fakes report no usage for the requests they answer, so only the cached ones are listed)
    expect(res.usageLine).toBe('usage: timing fake:timing 2 requests from the cache');
  });

  it('a changed effort re-sends only the LLM request it applies to', async () => {
    const { file, config, deps } = await setup();
    const p = fakes();
    const cfg = await config();
    await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers: p });
    p.calls.length = 0;
    await runPipeline(file, { ...cfg, effort: { ...cfg.effort, corrections: 'high' } }, { ...deps, log: memoryLogger(), providers: p });
    expect(p.calls).toEqual(['llm corrections']);
  });

  it('--no-cache sends every request again', async () => {
    const { file, config, deps } = await setup();
    const p = fakes();
    await runPipeline(file, await config(), { ...deps, log: memoryLogger(), providers: p });
    const n = p.calls.length;
    p.calls.length = 0;
    await runPipeline(file, await config({ cache: false }), { ...deps, log: memoryLogger(), providers: p });
    expect(p.calls).toHaveLength(n);
  });

  it('writes one file per request under requests/, with what the key was built from and never the audio itself', async () => {
    const { file, config, deps } = await setup();
    const cfg = await config();
    await runPipeline(file, cfg, { ...deps, log: memoryLogger(), providers: fakes() });
    const [hash] = await readdir(cfg.cacheDir);
    const dir = join(cfg.cacheDir, hash!, 'requests');
    const files = (await readdir(dir)).sort();
    expect(files.map((f) => f.split('-')[0])).toEqual(['llm', 'llm', 'text', 'timing', 'timing']);
    const text = JSON.parse(await readFile(join(dir, files[2]!), 'utf8'));
    expect(text).toMatchObject({ version: 1, role: 'text', provider: 'fake:text', stage: 'transcribe', request: { audio: expect.stringMatching(/^[0-9a-f]{64}$/), prompt: 'A film.', language: 'en' }, response: { text: TEXT } });
  });
});
