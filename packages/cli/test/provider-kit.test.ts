import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runProviders } from '../src/commands/providers.js';
import { parseModelSpec, resolveConfig, type CliFlags } from '../src/config.js';
import { languageDataHash, resetLanguageDataHash } from '../src/lang/fingerprint.js';
import { en } from '../src/lang/en.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { runPipeline } from '../src/pipeline.js';
import { recordingFetch } from '../src/providers/http-record.js';
import { defineProvider, redact, secretValues, type ProviderDescriptor } from '../src/providers/kit.js';
import { OpenAILlmProvider, createOpenAIClient } from '../src/providers/openai.js';
import { BUILTIN_PROVIDERS, createProvider, createProviders, getProvider, missingEnv, registerProvider, resolveSelection, resolveSelections } from '../src/providers/registry.js';
import type { LlmRequest, TextProvider } from '../src/providers/types.js';
import { formatUsage, UsageMeter } from '../src/usage.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const spec = parseModelSpec;

describe('provider descriptors', () => {
  it.each(BUILTIN_PROVIDERS.map((d) => [d.id, d] as const))('%s is well-formed', (_id, d) => {
    expect(d.id).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    expect(d.description.length).toBeGreaterThan(10);
    expect(d.roles.length).toBeGreaterThan(0);
    for (const role of Object.keys(d.defaults)) expect(d.roles).toContain(role);
    const names = d.env.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const v of d.env) {
      expect(v.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(v.description.length).toBeGreaterThan(5);
      if (v.waivedBy) expect(names).toContain(v.waivedBy);
      if (/_(KEY|TOKEN|SECRET)$/.test(v.name)) expect(v.secret, `${v.name} holds a secret`).toBe(true);
    }
    if (d.wordTimings) expect(d.roles).toContain('text');
    expect(getProvider(d.id)).toBe(d);
  });

  it('an id that is not registered is unknown, including prototype names', () => {
    expect(getProvider('constructor')).toBeUndefined();
    expect(() => resolveSelection(spec('nope'), 'llm')).toThrow(/known: openai, azure-openai, anthropic, azure-speech, azure-mai, elevenlabs, whisper-cpp, ollama, recorded/);
  });

  it('registerProvider adds a provider and the returned function removes it again', () => {
    const remove = registerProvider(defineProvider({ id: 'fake-x', description: 'a test provider', roles: ['llm'], env: [], defaults: { llm: 'm' }, create: () => ({ id: 'x', complete: async () => ({}) as never }) }));
    expect(resolveSelection(spec('fake-x'), 'llm').id).toBe('fake-x:m');
    remove();
    expect(getProvider('fake-x')).toBeUndefined();
    expect(() => registerProvider({ ...getProvider('openai')!, id: 'Bad Id' })).toThrow(/lowercase/);
  });

  it('createProvider refuses a descriptor whose create returns no implementation for the role', () => {
    const remove = registerProvider(defineProvider({ id: 'fake-broken', description: 'returns nothing usable', roles: ['text'], env: [], defaults: { text: 'm' }, create: () => ({ id: 'x' }) as never }));
    try {
      expect(() => createProvider('text', resolveSelection(spec('fake-broken'), 'text'), {}, { cwd: '/' })).toThrow(/no text implementation/);
    } finally {
      remove();
    }
  });
});

describe('secret redaction', () => {
  const SECRET = 'sk-redaction-test-0123456789';
  const leaky = () => ({
    audio: { transcriptions: { create: async () => ({}) } },
    chat: { completions: { create: async () => { throw Object.assign(new Error(`401 Incorrect API key provided: ${SECRET}`), { status: 401 }); } } },
  });
  const req: LlmRequest = { name: 'n', system: '', user: '', schema: { type: 'object' } };

  it('a provider on its own would leak an echoed key; through the registry the key is redacted', async () => {
    const raw = (await new OpenAILlmProvider('openai:m', leaky(), 'm').complete(req).catch((e: unknown) => e)) as Error;
    expect(raw.message).toContain(SECRET);
    const wrapped = createProvider('llm', resolveSelection(spec('openai'), 'llm'), { OPENAI_API_KEY: SECRET }, { cwd: '/', deps: { openai: leaky } }) as { complete: (r: LlmRequest) => Promise<unknown> };
    const err = (await wrapped.complete(req).catch((e: unknown) => e)) as Error & { status: number };
    expect(err.message).toBe('401 Incorrect API key provided: [redacted]');
    expect(err.stack).not.toContain(SECRET);
    expect(err.status).toBe(401); // retry logic still sees the status
  });

  it('redact replaces every occurrence', () => {
    expect(redact('a KEY b KEY', ['KEY'])).toBe('a [redacted] b [redacted]');
  });
});

describe('--timing same', () => {
  it('resolves to the text selection when the text provider has word timings', () => {
    const sel = resolveSelections({ text: spec('whisper-cpp:base'), timing: spec('same'), llm: spec('anthropic') });
    expect(sel.timing).toEqual({ provider: 'whisper-cpp', model: 'base', id: 'whisper-cpp:base', same: true });
    expect(sel.text.same).toBeUndefined();
  });

  it.each([
    [{ text: 'openai', timing: 'same' }, /the text provider "openai:gpt-transcribe" returns no word timings; use one that does \(openai:whisper-1, azure-mai, elevenlabs, whisper-cpp\)/],
    [{ text: 'whisper-cpp', timing: 'same:x' }, /takes no model part/],
    [{ text: 'same', timing: 'azure-speech' }, /only valid for --timing/],
  ])('rejects %j', (s, message) => {
    expect(() => resolveSelections({ text: spec(s.text), timing: spec(s.timing), llm: spec('openai') })).toThrow(message);
  });

  it('createProviders makes no timing provider of its own', async () => {
    const sel = resolveSelections({ text: spec('whisper-cpp:base'), timing: spec('same'), llm: spec('recorded:x') });
    const p = createProviders(sel, {}, { cwd: '/' });
    expect(p.timing.id).toBe('whisper-cpp:base');
    await expect(p.timing.align({ path: 'x', duration: 1 }, {})).rejects.toThrow(/come from the text stage/);
  });
});

describe('missingEnv with descriptors', () => {
  it('local providers need no variables; ollama needs no key', () => {
    expect(missingEnv([spec('whisper-cpp'), spec('ollama')], {})).toEqual([]);
  });
});

describe('usage', () => {
  it('sums reports per provider and role and formats one line', () => {
    const m = new UsageMeter();
    m.add({ id: 'openai:gpt-6.1-sol', role: 'llm', inputTokens: 1000, outputTokens: 20 });
    m.add({ id: 'openai:gpt-6.1-sol', role: 'llm', inputTokens: 4210, outputTokens: 1012 });
    m.add({ id: 'azure-speech:fast', role: 'timing', audioSeconds: 18.04 });
    m.add({ id: 'openai:gpt-transcribe', role: 'text', audioSeconds: 12.5, inputTokens: 100 });
    m.add({ id: 'openai:gpt-transcribe', role: 'text', audioSeconds: 5.5 });
    expect(formatUsage(m.list())).toBe(
      'usage: text openai:gpt-transcribe 2 requests, 18.0 s audio, 100 in / 0 out tokens · timing azure-speech:fast 1 request, 18.0 s audio · llm openai:gpt-6.1-sol 2 requests, 5,210 in / 1,032 out tokens',
    );
    expect(formatUsage([])).toBeUndefined();
  });
});

describe('--local', () => {
  const resolve = async (flags: CliFlags, file = {}) => {
    const dir = await tempDir('overtone-local-');
    const cfg = await resolveConfig(flags, file, { cwd: dir, configDir: dir });
    return [cfg.text.id, cfg.timing.id, cfg.llm.id];
  };

  it('selects whisper.cpp for text and timing and Ollama for the editor', async () => {
    expect(await resolve({ local: true })).toEqual(['whisper-cpp:large-v3-turbo', 'same', 'ollama']);
    expect(resolveSelections({ text: spec('whisper-cpp:large-v3-turbo'), timing: spec('same'), llm: spec('ollama') }).llm.id).toBe('ollama:qwen3:8b');
  });

  it('explicit flags win over --local, and --local over the config file', async () => {
    expect(await resolve({ local: true, llm: 'anthropic', text: 'whisper-cpp:base' })).toEqual(['whisper-cpp:base', 'same', 'anthropic']);
    expect(await resolve({ local: true }, { text: 'openai', llm: 'openai' })).toEqual(['whisper-cpp:large-v3-turbo', 'same', 'ollama']);
    expect(await resolve({}, { local: true, llm: 'anthropic' })).toEqual(['whisper-cpp:large-v3-turbo', 'same', 'anthropic']);
  });
});

describe('language data hash', () => {
  afterEach(() => resetLanguageDataHash());

  it('is stable, differs per pack, and changes when a pack list changes', () => {
    const before = languageDataHash('en');
    expect(languageDataHash('en-US')).toBe(before);
    expect(languageDataHash('nl')).not.toBe(before);
    expect(languageDataHash('xx')).toBe(languageDataHash('und')); // both neutral
    const articles = en.lineCutting!.articles as string[];
    articles.push('yon');
    try {
      resetLanguageDataHash();
      expect(languageDataHash('en')).not.toBe(before);
    } finally {
      articles.pop();
      resetLanguageDataHash();
    }
    expect(languageDataHash('en')).toBe(before);
  });
});

describe('OVERTONE_RECORD_HTTP', () => {
  it('records exchanges with the secrets redacted and without request headers', async () => {
    const dir = await tempDir('overtone-rec-http-');
    const SECRET = 'sk-record-0123456789abcdef';
    const inner = (async () => new Response(JSON.stringify({ echo: `key ${SECRET}`, choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const f = recordingFetch(dir, 'openai-llm', [SECRET], inner);
    const client = createOpenAIClient({ OPENAI_API_KEY: SECRET, OPENAI_BASE_URL: 'https://api.example.com/v1' }, f);
    await new OpenAILlmProvider('openai:m', client, 'm').complete({ name: 'n', system: 's', user: 'u', schema: { type: 'object' } });
    const files = await readdir(dir);
    expect(files).toEqual(['001-openai-llm.json']);
    const text = await readFile(join(dir, files[0]!), 'utf8');
    expect(text).not.toContain(SECRET);
    const ex = JSON.parse(text) as { request: { url: string; body: { model: string } }; response: { status: number; body: { echo: string } } };
    expect(ex.request.url).toBe('https://api.example.com/v1/chat/completions');
    expect(ex.request.body.model).toBe('m');
    expect(ex.response.body.echo).toBe('key [redacted]');
    expect(text).not.toMatch(/authorization/i);
  });
});

describe('OVERTONE_RECORD_HTTP numbering', () => {
  it('numbers the exchanges of every recorder in a folder in one sequence, so a second provider object overwrites nothing', async () => {
    const dir = await tempDir('overtone-rec-http-');
    const inner = (async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    await recordingFetch(dir, 'ollama-llm', [], inner)('https://h/api/tags'); // the preflight's provider
    await recordingFetch(dir, 'ollama-llm', [], inner)('https://h/api/chat', { method: 'POST', body: '{}' }); // the run's
    expect((await readdir(dir)).sort()).toEqual(['001-ollama-llm.json', '002-ollama-llm.json']);
  });
});

describe('Ollama request settings', () => {
  it('give OLLAMA_THINK=default its own cache key: unset sends think from the effort, default sends none', () => {
    const settings = (env: NodeJS.ProcessEnv) => (createProvider('llm', resolveSelection(parseModelSpec('ollama'), 'llm'), env, { cwd: '/' }) as { settings?: Record<string, unknown> }).settings;
    expect(settings({})?.think).toBeUndefined();
    expect(settings({ OLLAMA_THINK: 'default' })?.think).toBe('default');
    expect(settings({ OLLAMA_THINK: 'true' })?.think).toBe(true);
  });
});

describe('overtone providers', () => {
  it('lists every provider, and the environment of one', () => {
    const log = memoryLogger();
    expect(runProviders(undefined, log)).toBe(0);
    expect(log.lines.some((l) => /^out: whisper-cpp\s+text, timing\s+text large-v3-turbo/.test(l))).toBe(true);
    const one = memoryLogger();
    runProviders('ollama', one);
    expect(one.lines).toContain('out:   llm: default model qwen3:8b');
    expect(one.lines.some((l) => l.startsWith('out:   OLLAMA_NUM_CTX (optional)'))).toBe(true);
    expect(() => runProviders('nope', memoryLogger())).toThrow(/Unknown provider "nope"/);
  });
});

// ---- the pipeline with a fake provider that returns text and word timings in one call

/** A dual provider: text + word timings per chunk, counted. Times are relative to the chunk, as the contract says. */
function fakeDual(calls: string[]): ProviderDescriptor {
  return defineProvider({
    id: 'fake-dual',
    description: 'test provider with word timings',
    roles: ['text', 'timing'],
    env: [],
    defaults: { text: 'm', timing: 'm' },
    wordTimings: true,
    create: (_env, _model, deps): TextProvider => ({
      id: deps.id,
      async transcribe(chunk) {
        calls.push(`text ${chunk.index}`);
        deps.usage?.({ audioSeconds: chunk.end - chunk.start });
        return {
          text: 'Hello there. Hi Maya!',
          language: 'en',
          words: [
            { text: 'Hello', start: 0.5, end: 0.9 },
            { text: 'there.', start: 1.0, end: 1.4 },
            { text: 'Hi', start: 2.0, end: 2.3, speaker: 'S1' },
            { text: 'Maya!', start: 2.4, end: 2.9, speaker: 'S1' },
          ],
        };
      },
    }),
  });
}
function fakeLlm(calls: string[]): ProviderDescriptor {
  return defineProvider({
    id: 'fake-llm',
    description: 'test LLM that reports tokens',
    roles: ['llm'],
    env: [],
    defaults: { llm: 'm' },
    create: (_env, _model, deps) => ({
      id: deps.id,
      async complete<T>(req: LlmRequest): Promise<T> {
        calls.push(req.name);
        deps.usage?.({ inputTokens: 100, outputTokens: 10 });
        if (req.name === 'corrections') return { edits: [], speakers: [] } as T;
        if (req.name === 'styling') return { styles: [] } as T;
        if (req.name === 'context') return { topic: 'A greeting.', names: [], terms: [] } as T;
        return { cueStarts: [], lineStarts: [] } as T;
      },
    }),
  });
}

describe.skipIf(!hasFfmpeg)('pipeline with --timing same', () => {
  let removers: Array<() => void> = [];
  afterEach(() => {
    for (const r of removers) r();
    removers = [];
    resetLanguageDataHash();
    vi.restoreAllMocks();
  });

  async function setup() {
    const dir = await tempDir('overtone-same-');
    const file = join(dir, 'clip.m4a');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=4', '-c:a', 'aac', file]);
    const calls: string[] = [];
    removers.push(registerProvider(fakeDual(calls)), registerProvider(fakeLlm(calls)));
    const cfg = await resolveConfig({ text: 'fake-dual', timing: 'same', llm: 'fake-llm', export: 'json' }, {}, { cwd: dir, configDir: dir });
    return { dir, file, cfg, calls };
  }

  it('takes the timings from the text call: no timing call, every word exact, usage reported', async () => {
    const { dir, file, cfg, calls } = await setup();
    const log = memoryLogger();
    const res = await runPipeline(file, cfg, { log, cwd: dir, env: {} });
    expect(calls.filter((c) => c.startsWith('text'))).toEqual(['text 0']);
    const words = res.doc.turns.flatMap((t) => t.words);
    expect(words.map((w) => [w.text, w.start, w.end, w.match])).toEqual([
      ['Hello', 0.5, 0.9, 'exact'], ['there.', 1, 1.4, 'exact'], ['Hi', 2, 2.3, 'exact'], ['Maya!', 2.4, 2.9, 'exact'],
    ]);
    expect(res.doc.meta?.models).toEqual({ text: 'fake-dual:m', timing: 'fake-dual:m', llm: 'fake-llm:m' });
    expect(res.usageLine).toBe('usage: text fake-dual:m 1 request, 4.0 s audio · llm fake-llm:m 3 requests, 300 in / 30 out tokens');
    // usage never reaches the document or the cache
    const cacheFiles = await readdir(cfg.cacheDir, { recursive: true });
    for (const f of cacheFiles.filter((n) => String(n).endsWith('.json'))) {
      expect(await readFile(join(cfg.cacheDir, String(f)), 'utf8')).not.toMatch(/inputTokens|audioSeconds/);
    }
    expect(JSON.stringify(res.doc)).not.toMatch(/inputTokens|usage/);

    // a second run: every request answered from the cache, no calls; the usage line says so
    calls.length = 0;
    const again = await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, env: {} });
    expect(calls).toEqual([]);
    expect(again.usageLine).toBe('usage: text fake-dual:m 1 request from the cache · llm fake-llm:m 3 requests from the cache');
  });

  it('a language pack edit re-runs align and refine, but sends no request whose content it does not change', async () => {
    const { dir, file, cfg, calls } = await setup();
    await runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, env: {} });
    const articles = en.lineCutting!.articles as string[];
    articles.push('yon');
    try {
      resetLanguageDataHash();
      calls.length = 0;
      const log = memoryLogger();
      await runPipeline(file, cfg, { log, cwd: dir, env: {} });
      expect(log.lines).toContain('info: [4/6] align …');
      expect(log.lines).toContain('info: [5/6] refine …');
      // an article list shapes the line cutting, not the LLM prompts
      expect(calls).toEqual([]);
    } finally {
      articles.pop();
    }
  });

  it('fails clearly when the text provider returned no words', async () => {
    const { dir, file, cfg } = await setup();
    removers.push(registerProvider({
      ...fakeDual([]),
      create: (_e, _m, deps) => ({ id: deps.id, transcribe: async () => ({ text: 'Hello there.' }) }),
    }));
    await expect(runPipeline(file, cfg, { log: memoryLogger(), cwd: dir, env: {} })).rejects.toThrow(/--timing same: fake-dual:m returned no word timings/);
  });
});

describe('pipeline preflight of local providers', () => {
  it('stops before extraction when whisper-cli is missing, with the install command', async () => {
    const dir = await tempDir('overtone-pre-');
    const file = join(dir, 'x.wav');
    await writeFile(file, 'x');
    const cfg = await resolveConfig({ text: 'whisper-cpp:base', timing: 'same', llm: 'recorded:x' }, {}, { cwd: dir, configDir: dir });
    let probed = false;
    const err = await runPipeline(file, cfg, {
      log: memoryLogger(), cwd: dir, env: { PATH: dir }, checkBinaries: async () => [],
      probeDuration: async () => { probed = true; return 1; },
    }).then(() => new Error('no error'), (e: unknown) => e as Error);
    expect(err.message).toMatch(/^whisper-cli \(whisper\.cpp\) not found on PATH\.\nInstall whisper\.cpp:\n {2}macOS \(Homebrew\): {2}brew install whisper-cpp/);
    expect(probed).toBe(false);
  });
});

describe('endpoint URLs with credentials', () => {
  const secret = 'gateway-token-123456';
  const cases: Array<[string, string]> = [['openai:gpt-6.1', 'OPENAI_BASE_URL'], ['anthropic', 'ANTHROPIC_BASE_URL'], ['ollama', 'OLLAMA_BASE_URL']];

  it.each(cases)('%s: a user name or password in %s is refused, naming the variable but not the value', (spec, name) => {
    const env = { OPENAI_API_KEY: 'sk-fake-key-1234', ANTHROPIC_API_KEY: 'sk-ant-fake-1234', [name]: `http://alice:${secret}@localhost:1234/v1` };
    const build = () => createProvider('llm', resolveSelection(parseModelSpec(spec), 'llm'), env, { cwd: '/' });
    expect(build).toThrow(`${name} contains a user name or password ("https://user:password@host"), which cannot be sent in a URL; remove it from ${name}.`);
    try {
      build();
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(secret);
    }
  });

  it('redacts the password (as written and decoded) from errors as a safety net', () => {
    const env = { OPENAI_BASE_URL: 'http://localhost:1234/v1' };
    const d = getProvider('openai')!;
    expect(secretValues(d, { ...env, OPENAI_BASE_URL: `http://alice:${secret}%21@localhost/v1` })).toEqual([`${secret}%21`, `${secret}!`]);
    expect(secretValues(d, env)).toEqual([]);
  });
});
