import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from './tmp.js';
import { parseModelSpec, resolveConfig } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { textPrompt } from '../src/pipeline.js';
import { AnthropicLlmProvider, createAnthropicClient, type AnthropicLike } from '../src/providers/anthropic.js';
import { AZURE_TRANSCRIBE_API_VERSION, OpenAILlmProvider, OpenAITextProvider, createAzureOpenAIClient, createOpenAIClient, isGptTranscribe, type OpenAILike } from '../src/providers/openai.js';
import { RecordedProvider } from '../src/providers/recorded.js';
import { createProvider, createProviders, missingEnv, missingEnvError, resolveSelection } from '../src/providers/registry.js';
import { LlmFormatError, type LlmProvider } from '../src/providers/types.js';
import { HttpError } from '../src/util/retry.js';

// Keep the tests independent of the developer's environment (SDK clients read these as defaults).
beforeEach(() => {
  for (const name of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_API_VERSION', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_API_VERSION', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
    vi.stubEnv(name, undefined);
  }
});
afterEach(() => vi.unstubAllEnvs());

async function audioFile(): Promise<string> {
  const dir = await tempDir('overtone-prov-');
  const p = join(dir, 'chunk-0.mp3');
  await writeFile(p, Buffer.from([1, 2, 3]));
  return p;
}

function fakeOpenAI(transcription: unknown, chat: unknown): OpenAILike & { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    audio: { transcriptions: { create: async (p) => { calls.push(p); return transcription; } } },
    chat: { completions: { create: async (p) => { calls.push(p); return chat; } } },
  };
}

describe('resolveSelection', () => {
  it.each([
    ['openai', 'text', 'openai:gpt-transcribe'],
    ['openai', 'llm', 'openai:gpt-6.1-sol'],
    ['anthropic', 'llm', 'anthropic:claude-opus-5-5'],
    ['azure-speech', 'timing', 'azure-speech:fast'],
    ['azure-openai:my-deploy', 'llm', 'azure-openai:my-deploy'],
    ['openai:gpt-4o-transcribe', 'text', 'openai:gpt-4o-transcribe'],
  ] as const)('%s as %s → %s', (spec, role, id) => {
    expect(resolveSelection(parseModelSpec(spec), role).id).toBe(id);
  });

  it.each([
    ['nope', 'text', /Unknown provider "nope"/],
    ['anthropic', 'text', /cannot be used for --text/],
    ['azure-openai', 'llm', /needs a model part: your deployment name/],
    ['azure-speech:batch', 'timing', /Unknown azure-speech mode "batch"/],
    ['same', 'timing', /resolved together with --text/],
    ['same', 'llm', /only valid for --timing/],
  ] as const)('rejects %s as %s', (spec, role, message) => {
    expect(() => resolveSelection(parseModelSpec(spec), role)).toThrow(message);
  });
});

describe('missingEnv', () => {
  it('lists only variables of selected providers, once', () => {
    const sel = [parseModelSpec('openai:a'), parseModelSpec('azure-speech:fast'), parseModelSpec('openai:b')];
    expect(missingEnv(sel, { AZURE_SPEECH_KEY: 'k' })).toEqual(['OPENAI_API_KEY (openai)', 'AZURE_SPEECH_REGION (azure-speech)']);
    expect(missingEnv([parseModelSpec('recorded:x')], {})).toEqual([]);
    expect(missingEnv([parseModelSpec('azure-openai:d')], {})).toEqual(['AZURE_OPENAI_ENDPOINT (azure-openai)', 'AZURE_OPENAI_API_KEY (azure-openai)']);
  });

  it('missingEnvError names the variables, points to .env.example and suggests --local', () => {
    const err = missingEnvError(['ANTHROPIC_API_KEY (anthropic)'], 'the nl editor (languages.nl.llm)');
    expect(err.name).toBe('UserError');
    const lines = err.message.split('\n');
    expect(lines.slice(0, 2)).toEqual(['Missing environment variables for the nl editor (languages.nl.llm):', '  ANTHROPIC_API_KEY (anthropic)']);
    expect(err.message).toContain('.env.example');
    expect(err.message).toContain('--local');
    expect(missingEnvError(['OPENAI_API_KEY (openai)']).message.split('\n')[0]).toBe('Missing environment variables for the selected providers:');
  });
});

describe('missingEnv for azure-speech', () => {
  const sel = [parseModelSpec('azure-speech')];
  it('needs key and region, or key and endpoint', () => {
    expect(missingEnv(sel, {})).toEqual(['AZURE_SPEECH_KEY (azure-speech)', 'AZURE_SPEECH_REGION (azure-speech)']);
    expect(missingEnv(sel, { AZURE_SPEECH_KEY: 'k' })).toEqual(['AZURE_SPEECH_REGION (azure-speech)']);
    expect(missingEnv(sel, { AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'westeurope' })).toEqual([]);
    expect(missingEnv(sel, { AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_ENDPOINT: 'https://my.cognitiveservices.azure.com' })).toEqual([]);
    expect(missingEnv(sel, { AZURE_SPEECH_ENDPOINT: 'https://my.cognitiveservices.azure.com' })).toEqual(['AZURE_SPEECH_KEY (azure-speech)']);
    expect(missingEnv(sel, { AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_ENDPOINT: '  ' })).toEqual(['AZURE_SPEECH_REGION (azure-speech)']);
  });

  it('createProviders then calls the endpoint, without any region', async () => {
    const urls: string[] = [];
    const f = (async (url: string) => { urls.push(url); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const rec = resolveSelection(parseModelSpec('recorded:x'), 'text');
    const env = { AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_ENDPOINT: 'https://my.cognitiveservices.azure.com/' };
    const p = createProviders({ text: rec, timing: resolveSelection(parseModelSpec('azure-speech'), 'timing'), llm: { ...rec } }, env, { cwd: '/', deps: { fetch: f } });
    await p.timing.align({ path: await audioFile(), duration: 1 }, {});
    expect(urls[0]).toMatch(/^https:\/\/my\.cognitiveservices\.azure\.com\/speechtotext\//);
  });
});

describe('OpenAITextProvider', () => {
  it('sends languages, keywords and prompt to gpt-transcribe', async () => {
    const client = fakeOpenAI({ text: 'Hello world.', languages: [{ code: 'en' }] }, null);
    const p = new OpenAITextProvider('openai:gpt-transcribe', client, 'gpt-transcribe');
    const res = await p.transcribe({ path: await audioFile(), index: 0, start: 0, end: 10 }, { language: 'en', prompt: 'Ad for DriveCover.', keywords: ['DriveCover'] });
    expect(res).toEqual({ text: 'Hello world.', language: 'en' });
    const params = client.calls[0];
    expect(params).toMatchObject({ model: 'gpt-transcribe', response_format: 'json', languages: ['en'], keywords: ['DriveCover'], prompt: 'Ad for DriveCover.' });
    expect(params.language).toBeUndefined();
    expect((params.file as File).name).toBe('chunk-0.mp3');
  });

  it('sends every candidate language to gpt-transcribe, and only the main one to older models', async () => {
    const client = fakeOpenAI({ text: 'Hola, hello.' }, null);
    const opts = { language: 'en', languages: ['en', 'es'] };
    await new OpenAITextProvider('openai:gpt-transcribe', client, 'gpt-transcribe').transcribe({ path: await audioFile(), index: 0, start: 0, end: 1 }, opts);
    await new OpenAITextProvider('openai:gpt-4o-transcribe', client, 'gpt-4o-transcribe').transcribe({ path: await audioFile(), index: 0, start: 0, end: 1 }, opts);
    expect(client.calls[0]).toMatchObject({ languages: ['en', 'es'] });
    expect(client.calls[1]).toMatchObject({ language: 'en' });
    expect(client.calls[1].languages).toBeUndefined();
  });

  it('sends the singular language and no keywords to older models', async () => {
    const client = fakeOpenAI({ text: 'Hi.' }, null);
    const p = new OpenAITextProvider('openai:gpt-4o-transcribe', client, 'gpt-4o-transcribe');
    await p.transcribe({ path: await audioFile(), index: 0, start: 0, end: 1 }, { language: 'nl', keywords: ['X'] });
    expect(client.calls[0]).toMatchObject({ language: 'nl' });
    expect(client.calls[0].languages).toBeUndefined();
    expect(client.calls[0].keywords).toBeUndefined();
    expect(isGptTranscribe('my-gpt-transcribe-deploy')).toBe(true);
  });

  it('retries a 429 from the SDK', async () => {
    let n = 0;
    const client: OpenAILike = {
      audio: { transcriptions: { create: async () => { n++; if (n === 1) throw Object.assign(new Error('rate'), { status: 429 }); return { text: 'ok' }; } } },
      chat: { completions: { create: async () => ({}) } },
    };
    const p = new OpenAITextProvider('openai:x', client, 'x', { sleep: async () => {} });
    expect((await p.transcribe({ path: await audioFile(), index: 0, start: 0, end: 1 }, {})).text).toBe('ok');
    expect(n).toBe(2);
  });
});

describe('OpenAILlmProvider', () => {
  const req = { name: 'corrections', system: 'sys', user: 'usr', schema: { type: 'object' } };

  it('requests strict JSON-schema output and parses it', async () => {
    const client = fakeOpenAI(null, { choices: [{ message: { content: '{"edits":[]}' }, finish_reason: 'stop' }] });
    const p = new OpenAILlmProvider('openai:gpt-6.1-sol', client, 'gpt-6.1-sol');
    expect(await p.complete(req)).toEqual({ edits: [] });
    expect(client.calls[0]).toEqual({
      model: 'gpt-6.1-sol',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'usr' }],
      response_format: { type: 'json_schema', json_schema: { name: 'corrections', schema: { type: 'object' }, strict: true } },
    });
  });

  it('sends the effort as reasoning_effort (when enabled), the shared schema name, and reports cached and reasoning tokens', async () => {
    const usage: unknown[] = [];
    const answer = {
      choices: [{ message: { content: '{}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 2048 }, completion_tokens_details: { reasoning_tokens: 300 } },
    };
    const client = fakeOpenAI(null, answer);
    const on = new OpenAILlmProvider('azure-openai:x', client, 'x', {}, { reasoningEffort: true, usage: (u) => usage.push(u), cacheWarmupMs: 1500 });
    await on.complete({ ...req, name: 'linebreaks-vertical', schemaName: 'linebreaks', effort: 'low' });
    expect(client.calls[0]).toMatchObject({ reasoning_effort: 'low', response_format: { json_schema: { name: 'linebreaks' } } });
    expect(usage).toEqual([{ inputTokens: 3000, outputTokens: 500, cachedInputTokens: 2048, reasoningTokens: 300 }]);
    expect(on.cacheWarmupMs).toBe(1500);
    const off = new OpenAILlmProvider('openai:x', client, 'x');
    await off.complete({ ...req, effort: 'low' });
    expect(client.calls[1]).not.toHaveProperty('reasoning_effort');
  });

  it('sends no reasoning_effort again once a model without reasoning rejected it', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client: OpenAILike = {
      audio: { transcriptions: { create: async () => ({}) } },
      chat: {
        completions: {
          create: async (p: Record<string, unknown>) => {
            calls.push(p);
            if ('reasoning_effort' in p) throw new HttpError(400, "400 Unsupported parameter: 'reasoning_effort' is not supported with this model.");
            return { choices: [{ message: { content: '{"ok":1}' }, finish_reason: 'stop' }] };
          },
        },
      },
    } as unknown as OpenAILike;
    const log = memoryLogger();
    const p = new OpenAILlmProvider('openai:gpt-4.1', client, 'gpt-4.1', {}, { reasoningEffort: true, log });
    expect(await p.complete({ ...req, effort: 'low' })).toEqual({ ok: 1 });
    expect(await p.complete({ ...req, effort: 'high' })).toEqual({ ok: 1 });
    expect(calls.map((c) => 'reasoning_effort' in c)).toEqual([true, false, false]);
    expect(log.lines).toEqual(['info:   openai:gpt-4.1 takes no reasoning_effort (a model without reasoning); sending its requests without it']);
    // any other 400 stays an error
    const other = new OpenAILlmProvider('openai:x', { ...client, chat: { completions: { create: async () => { throw new HttpError(400, '400 bad schema'); } } } } as OpenAILike, 'x', {}, { reasoningEffort: true });
    await expect(other.complete({ ...req, effort: 'low' })).rejects.toThrow('400 bad schema');
  });

  it('enables reasoning_effort for OpenAI itself and Azure OpenAI, not for other OpenAI-compatible servers', async () => {
    const sent = async (id: string, env: NodeJS.ProcessEnv) => {
      const client = fakeOpenAI(null, { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
      const sel = resolveSelection(parseModelSpec(id), 'llm');
      const p = createProvider('llm', sel, env, { cwd: '/', deps: { openai: () => client, azureOpenai: () => client } }) as LlmProvider;
      await p.complete({ ...req, effort: 'medium' });
      return client.calls[0].reasoning_effort;
    };
    expect(await sent('openai', { OPENAI_API_KEY: 'k' })).toBe('medium');
    expect(await sent('openai', { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://localhost:1234/v1' })).toBeUndefined();
    expect(await sent('azure-openai:dep', { AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com' })).toBe('medium');
  });

  it('turns bad output into errors', async () => {
    const bad = new OpenAILlmProvider('x', fakeOpenAI(null, { choices: [{ message: { content: 'not json' } }] }), 'm');
    await expect(bad.complete(req)).rejects.toBeInstanceOf(LlmFormatError);
    const cut = new OpenAILlmProvider('x', fakeOpenAI(null, { choices: [{ message: { content: '{' }, finish_reason: 'length' }] }), 'm');
    await expect(cut.complete(req)).rejects.toThrow(/cut off/);
    const refused = new OpenAILlmProvider('x', fakeOpenAI(null, { choices: [{ message: { content: null, refusal: 'no' } }] }), 'm');
    await expect(refused.complete(req)).rejects.toThrow(/refused: no/);
  });
});

describe('AnthropicLlmProvider', () => {
  const req = { name: 'styling', system: 'sys', user: 'usr', schema: { type: 'object' } };
  const fake = (message: { stop_reason?: string; content: Array<{ type: string; text?: string }> }) => {
    const calls: Array<Record<string, unknown>> = [];
    const client: AnthropicLike = { messages: { stream: (p) => { calls.push(p); return { finalMessage: async () => message }; } } };
    return { client, calls };
  };

  it('uses output_config.format and reads the text block', async () => {
    const { client, calls } = fake({ stop_reason: 'end_turn', content: [{ type: 'thinking' }, { type: 'text', text: '{"styles":[]}' }] });
    const p = new AnthropicLlmProvider('anthropic:claude-opus-5-5', client, 'claude-opus-5-5');
    expect(await p.complete(req)).toEqual({ styles: [] });
    expect(calls[0]).toEqual({
      model: 'claude-opus-5-5',
      max_tokens: 64000,
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'usr' }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: { type: 'object' } } },
    });
  });

  it('maps the effort hint to output_config.effort, and sends medium without one', async () => {
    for (const [effort, want] of [['low', 'low'], ['medium', 'medium'], ['high', 'high']] as const) {
      const { client, calls } = fake({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] });
      await new AnthropicLlmProvider('a', client, 'm').complete({ ...req, effort });
      expect((calls[0].output_config as { effort: string }).effort).toBe(want);
    }
    const { client, calls } = fake({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] });
    await new AnthropicLlmProvider('a', client, 'm').complete(req);
    expect((calls[0].output_config as { effort: string }).effort).toBe('medium');
  });

  it('reports usage: input with cache writes and reads, cache reads, output and thinking tokens', async () => {
    const usage = { input_tokens: 720, cache_creation_input_tokens: 2845, cache_read_input_tokens: 0, output_tokens: 486, output_tokens_details: { thinking_tokens: 349 } };
    const client: AnthropicLike = { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage }) }) } };
    const reports: unknown[] = [];
    await new AnthropicLlmProvider('a', client, 'm', {}, (u) => reports.push(u)).complete(req);
    expect(reports).toEqual([{ inputTokens: 3565, cachedInputTokens: 0, outputTokens: 486, reasoningTokens: 349 }]);
    // older models report no details: no reasoning count
    const old: AnthropicLike = { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 5, output_tokens: 2, output_tokens_details: null } }) }) } };
    await new AnthropicLlmProvider('a', old, 'm', {}, (u) => reports.push(u)).complete(req);
    expect(reports[1]).toEqual({ inputTokens: 5, outputTokens: 2 });
  });

  it('reports refusals and truncation', async () => {
    await expect(new AnthropicLlmProvider('a', fake({ stop_reason: 'refusal', content: [] }).client, 'm').complete(req)).rejects.toThrow(/declined/);
    await expect(new AnthropicLlmProvider('a', fake({ stop_reason: 'max_tokens', content: [] }).client, 'm').complete(req)).rejects.toBeInstanceOf(LlmFormatError);
  });
});

describe('RecordedProvider', () => {
  it('replays text, timing and llm responses', async () => {
    const dir = await tempDir('overtone-rec-');
    await writeFile(join(dir, 'text.json'), JSON.stringify({ chunks: [{ text: 'Hello.', language: 'en' }] }));
    await writeFile(join(dir, 'timing.json'), JSON.stringify({ phrases: [{ speaker: 0, offsetMilliseconds: 0, durationMilliseconds: 500, text: 'Hello.', words: [{ text: 'Hello.', offsetMilliseconds: 0, durationMilliseconds: 500 }] }] }));
    await writeFile(join(dir, 'llm.json'), JSON.stringify({ corrections: [{ n: 1 }, { n: 2 }] }));
    const p = new RecordedProvider(dir);
    expect(await p.transcribe({ path: 'x', index: 0, start: 0, end: 1 })).toEqual({ text: 'Hello.', language: 'en' });
    expect((await p.align({ path: 'x', duration: 1 })).words).toEqual([{ text: 'Hello.', start: 0, end: 0.5, speaker: 'S1' }]);
    const req = { name: 'corrections', system: '', user: '', schema: {} };
    expect(await p.complete(req)).toEqual({ n: 1 });
    expect(await p.complete(req)).toEqual({ n: 2 });
    expect(await p.complete(req)).toEqual({ n: 2 });
    await expect(p.complete({ ...req, name: 'styling' })).rejects.toThrow(/no responses for "styling"/);
    await expect(p.transcribe({ path: 'x', index: 3, start: 0, end: 1 })).rejects.toThrow(/no chunk 3/);
  });
});

describe('createProviders', () => {
  it('builds providers from selections with injected clients', async () => {
    const client = fakeOpenAI({ text: 'x' }, { choices: [{ message: { content: '{}' } }] });
    const env = { OPENAI_API_KEY: 'k', AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'westeurope' };
    const p = createProviders(
      { text: resolveSelection(parseModelSpec('openai'), 'text'), timing: resolveSelection(parseModelSpec('azure-speech'), 'timing'), llm: resolveSelection(parseModelSpec('openai'), 'llm') },
      env,
      { cwd: '/', deps: { openai: () => client } },
    );
    expect(p.text.id).toBe('openai:gpt-transcribe');
    expect(p.timing.id).toBe('azure-speech:fast');
    expect(p.llm.id).toBe('openai:gpt-6.1-sol');
    expect(await p.llm.complete({ name: 'n', system: '', user: '', schema: { type: 'object' } })).toEqual({});
  });

  it('routes the Azure Speech locale warning to the logger', async () => {
    const lines: string[] = [];
    const log = { out() {}, info() {}, error() {}, debug() {}, warn: (m: string) => { lines.push(m); } };
    const f = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const sel = resolveSelection(parseModelSpec('azure-speech'), 'timing');
    const rec = resolveSelection(parseModelSpec('recorded:x'), 'text');
    const p = createProviders({ text: rec, timing: sel, llm: { ...rec } }, { AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'r' }, { cwd: '/', log, deps: { fetch: f } });
    await p.timing.align({ path: await audioFile(), duration: 1 }, { language: 'xx' });
    expect(lines).toEqual(["no Azure locale known for 'xx'; letting Azure detect the language"]);
  });

  it('shares one recorded provider per directory', () => {
    const rec = resolveSelection(parseModelSpec('recorded:fixtures/x'), 'text');
    const p = createProviders({ text: rec, timing: { ...rec }, llm: { ...rec } }, {}, { cwd: '/tmp' });
    expect(p.text).toBe(p.timing);
    expect(p.text.id).toBe('recorded:fixtures/x');
  });
});

describe('retry hooks and truncation flag', () => {
  const req = { name: 'n', system: '', user: '', schema: { type: 'object' } };

  it('marks cut-off responses as truncated', async () => {
    const cut = new OpenAILlmProvider('x', fakeOpenAI(null, { choices: [{ message: { content: '{' }, finish_reason: 'length' }] }), 'm');
    await expect(cut.complete(req)).rejects.toMatchObject({ name: 'LlmFormatError', truncated: true });
    const client: AnthropicLike = { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'max_tokens', content: [] }) }) } };
    await expect(new AnthropicLlmProvider('a', client, 'm').complete(req)).rejects.toMatchObject({ truncated: true });
  });

  it('does not mark other format errors as truncated', async () => {
    const bad = new OpenAILlmProvider('x', fakeOpenAI(null, { choices: [{ message: { content: 'not json' } }] }), 'm');
    await expect(bad.complete(req)).rejects.toMatchObject({ truncated: false });
  });

  it('a truncated answer is not retried by the schema wrapper', async () => {
    let calls = 0;
    const client: AnthropicLike = { messages: { stream: () => { calls++; return { finalMessage: async () => ({ stop_reason: 'max_tokens', content: [] }) }; } } };
    const wrapped = createProviders(
      { text: resolveSelection(parseModelSpec('recorded:x'), 'text'), timing: resolveSelection(parseModelSpec('recorded:x'), 'timing'), llm: resolveSelection(parseModelSpec('anthropic'), 'llm') },
      { ANTHROPIC_API_KEY: 'k' },
      { cwd: '/', deps: { anthropic: () => client } },
    ).llm;
    await expect(wrapped.complete(req)).rejects.toThrow(/token limit/);
    expect(calls).toBe(1);
  });

  it('keeps SDK-level retries off so withRetry is the only retry layer', () => {
    const retries = (c: unknown) => (c as { maxRetries: number }).maxRetries;
    expect(retries(createOpenAIClient({ OPENAI_API_KEY: 'k' }))).toBe(0);
    expect(retries(createAzureOpenAIClient({ AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com/', AZURE_OPENAI_API_KEY: 'k' }, 'd'))).toBe(0);
    expect(retries(createAzureOpenAIClient({ AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_API_VERSION: '2025-04-01-preview' }, 'd'))).toBe(0);
    expect(retries(createAnthropicClient({ ANTHROPIC_API_KEY: 'k' }))).toBe(0);
  });

  it('the Anthropic client takes its server and credentials only from the env it is given', () => {
    // set by gateways and Claude Code: the SDK would read them from process.env on its own
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://gateway.example');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'gateway-token');
    const client = createAnthropicClient({ ANTHROPIC_API_KEY: 'k' }) as unknown as { baseURL: string; authToken: string | null };
    expect(client.baseURL).toBe('https://api.anthropic.com');
    expect(client.authToken).toBeNull();
    const declared = createAnthropicClient({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://proxy.example' }) as unknown as { baseURL: string };
    expect(declared.baseURL).toBe('https://proxy.example');
  });

  it('another Anthropic server gets its own cache entries', () => {
    const sel = resolveSelection(parseModelSpec('anthropic'), 'llm');
    const settings = (env: NodeJS.ProcessEnv) => createProvider('llm', sel, env, { cwd: '/', deps: { anthropic: () => ({ messages: { stream: () => { throw new Error('unused'); } } }) } }).settings;
    expect(settings({ ANTHROPIC_API_KEY: 'k' })).toBeUndefined();
    expect(settings({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://proxy.example' })).toEqual({ server: expect.stringMatching(/^[0-9a-f]{12}$/) });
  });

  it('honours Retry-After from SDK error headers', async () => {
    const delays: number[] = [];
    let n = 0;
    const client: OpenAILike = {
      audio: { transcriptions: { create: async () => { n++; if (n === 1) throw Object.assign(new Error('rate'), { status: 429, headers: new Headers({ 'retry-after': '7' }) }); return { text: 'ok' }; } } },
      chat: { completions: { create: async () => ({}) } },
    };
    const p = new OpenAITextProvider('openai:x', client, 'x', { sleep: async (ms) => { delays.push(ms); } });
    await p.transcribe({ path: await audioFile(), index: 0, start: 0, end: 1 }, {});
    expect(delays).toEqual([7000]);
  });
});

describe('registry ids match parseModelSpec', () => {
  it('accepts upper case and padded provider ids', () => {
    expect(resolveSelection(parseModelSpec('  OpenAI '), 'llm').id).toBe('openai:gpt-6.1-sol');
    expect(resolveSelection(parseModelSpec('Azure-OpenAI: My-Deploy '), 'llm').id).toBe('azure-openai:My-Deploy');
    expect(resolveSelection(parseModelSpec('Azure-Speech:Fast'), 'timing').id).toBe('azure-speech:fast');
    expect(missingEnv([parseModelSpec('ANTHROPIC')], {})).toEqual(['ANTHROPIC_API_KEY (anthropic)']);
  });

  it('treats object prototype names as unknown providers', () => {
    expect(() => resolveSelection(parseModelSpec('constructor'), 'llm')).toThrow(/Unknown provider "constructor"/);
    expect(() => resolveSelection(parseModelSpec('__proto__'), 'llm')).toThrow(/Unknown provider/);
    expect(missingEnv([parseModelSpec('toString')], {})).toEqual([]);
  });
});

/** A fake fetch that records `METHOD url` and answers every call with a valid JSON body for both endpoints. */
function recordingFetch(): { fetch: typeof fetch; seen: string[]; auth: string[] } {
  const seen: string[] = [];
  const auth: string[] = [];
  const f = (async (url: unknown, init?: RequestInit) => {
    // The SDK probes multipart support with a `data:,` request before the first upload; that is not an API call.
    if (String(url) !== 'data:,') {
      seen.push(String(url));
      const h = new Headers(init?.headers);
      auth.push(h.has('api-key') ? 'api-key' : h.has('authorization') ? 'authorization' : 'none');
    }
    return new Response(JSON.stringify({ text: 'x', choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: f, seen, auth };
}

async function callBoth(client: OpenAILike, deployment: string): Promise<void> {
  const { toFile } = await import('openai');
  await client.audio.transcriptions.create({ file: await toFile(Buffer.from([1]), 'a.mp3'), model: deployment, response_format: 'json' });
  await client.chat.completions.create({ model: deployment, messages: [{ role: 'user', content: 'x' }] });
}

describe('Azure OpenAI client URLs', () => {
  const base = { AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com/', AZURE_OPENAI_API_KEY: 'k' };

  it('classic API with AZURE_OPENAI_API_VERSION uses the deployments path, even when OPENAI_BASE_URL is set', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.example.com/v1');
    const rec = recordingFetch();
    const env = { ...base, AZURE_OPENAI_API_VERSION: '2025-04-01-preview' };
    for (const role of ['text', 'llm'] as const) await callBoth(createAzureOpenAIClient(env, 'dep', role, rec.fetch), 'dep');
    expect(rec.seen).toEqual([
      'https://x.openai.azure.com/openai/deployments/dep/audio/transcriptions?api-version=2025-04-01-preview',
      'https://x.openai.azure.com/openai/deployments/dep/chat/completions?api-version=2025-04-01-preview',
      'https://x.openai.azure.com/openai/deployments/dep/audio/transcriptions?api-version=2025-04-01-preview',
      'https://x.openai.azure.com/openai/deployments/dep/chat/completions?api-version=2025-04-01-preview',
    ]);
    expect(new Set(rec.auth)).toEqual(new Set(['api-key']));
  });

  it('without AZURE_OPENAI_API_VERSION: text role uses the classic deployments path with the default api-version, llm role stays plain v1', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://proxy.example.com/v1');
    const text = recordingFetch();
    await callBoth(createAzureOpenAIClient(base, 'dep', 'text', text.fetch), 'dep');
    expect(AZURE_TRANSCRIBE_API_VERSION).toBe('2025-04-01-preview');
    expect(text.seen[0]).toBe('https://x.openai.azure.com/openai/deployments/dep/audio/transcriptions?api-version=2025-04-01-preview');
    expect(new Set(text.auth)).toEqual(new Set(['api-key']));
    const llm = recordingFetch();
    await callBoth(createAzureOpenAIClient(base, 'dep', 'llm', llm.fetch), 'dep');
    expect(llm.seen[1]).toBe('https://x.openai.azure.com/openai/v1/chat/completions');
    expect(llm.seen[0]).toBe('https://x.openai.azure.com/openai/v1/audio/transcriptions');
  });

  it('AZURE_OPENAI_ENDPOINT may end in slashes, /openai or /openai/v1 (any case): the request URLs stay the same', async () => {
    const forms = ['https://x.openai.azure.com', 'https://x.openai.azure.com/', 'https://x.openai.azure.com//', 'https://x.openai.azure.com/openai', 'https://x.openai.azure.com/openai/', 'https://x.openai.azure.com/openai/v1', 'https://x.openai.azure.com/openai/v1/', 'https://x.openai.azure.com/OpenAI/V1/', 'https://x.openai.azure.com/OPENAI'];
    for (const version of [undefined, '2025-04-01-preview']) {
      const urls: string[][] = [];
      for (const endpoint of forms) {
        const env = { AZURE_OPENAI_ENDPOINT: endpoint, AZURE_OPENAI_API_KEY: 'k', ...(version ? { AZURE_OPENAI_API_VERSION: version } : {}) };
        const seen: string[] = [];
        for (const role of ['text', 'llm'] as const) {
          const rec = recordingFetch();
          await callBoth(createAzureOpenAIClient(env, 'dep', role, rec.fetch), 'dep');
          seen.push(...rec.seen);
        }
        urls.push(seen);
      }
      for (const u of urls) expect(u).toEqual(urls[0]);
      expect(urls[0]![0]).toMatch(/^https:\/\/x\.openai\.azure\.com\/openai\/(v1|deployments)\//);
    }
  });

  it('the openai provider still honours OPENAI_BASE_URL', async () => {
    const rec = recordingFetch();
    const client = createOpenAIClient({ OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'https://proxy.example.com/v1' }, rec.fetch);
    await callBoth(client, 'm');
    expect(rec.seen[1]).toBe('https://proxy.example.com/v1/chat/completions');
  });
});

describe('Azure OpenAI transcription request shape', () => {
  const chunk = async () => ({ path: await audioFile(), index: 0, start: 0, end: 1 });
  const opts = { language: 'nl', prompt: 'Ad for DriveCover.', keywords: ['DriveCover', 'CarCover'] };

  it('sends the prompt as given (the glossary comes from textPrompt) and a singular language, whatever the deployment is called', async () => {
    const client = fakeOpenAI({ text: 'x' }, null);
    for (const dep of ['my-gpt-transcribe', 'prod-asr']) {
      await new OpenAITextProvider(`azure-openai:${dep}`, client, dep, {}, { azure: true }).transcribe(await chunk(), opts);
    }
    for (const params of client.calls) {
      expect(params).toMatchObject({ language: 'nl', prompt: 'Ad for DriveCover.' });
      expect(params.languages).toBeUndefined();
      expect(params.keywords).toBeUndefined();
    }
  });

  it('sends languages and keywords only with gpt-transcribe as underlying model AND the opt-in', async () => {
    const client = fakeOpenAI({ text: 'x' }, null);
    await new OpenAITextProvider('a', client, 'dep', {}, { azure: true, underlyingModel: 'gpt-transcribe' }).transcribe(await chunk(), opts);
    await new OpenAITextProvider('a', client, 'dep', {}, { azure: true, underlyingModel: 'gpt-4o-transcribe', keywords: true }).transcribe(await chunk(), opts);
    await new OpenAITextProvider('a', client, 'dep', {}, { azure: true, underlyingModel: 'gpt-transcribe', keywords: true }).transcribe(await chunk(), opts);
    expect(client.calls[0].keywords).toBeUndefined();
    expect(client.calls[1].keywords).toBeUndefined();
    expect(client.calls[2]).toMatchObject({ languages: ['nl'], keywords: ['DriveCover', 'CarCover'], prompt: 'Ad for DriveCover.' });
    expect(client.calls[2].language).toBeUndefined();
  });

  it('the glossary reaches an Azure request exactly once: via the prompt textPrompt builds, not appended again', async () => {
    const dir = await tempDir('overtone-prov-');
    const cfg = await resolveConfig({ context: 'Ad for the insurer.' }, { glossary: ['DriveCover', 'CarCover'] }, { cwd: dir, configDir: dir });
    const client = fakeOpenAI({ text: 'x' }, null);
    const p = new OpenAITextProvider('azure-openai:asr', client, 'asr', {}, { azure: true });
    await p.transcribe(await chunk(), { language: 'nl', prompt: textPrompt(cfg), keywords: cfg.glossary });
    const prompt = client.calls[0].prompt as string;
    expect(prompt).toContain('DriveCover');
    expect(prompt.split('DriveCover').length - 1).toBe(1);
    expect(prompt.split('CarCover').length - 1).toBe(1);
    expect(prompt).not.toContain('Glossary:');
    expect(client.calls[0].keywords).toBeUndefined();
  });

  it('passes no prompt when there is none', async () => {
    const client = fakeOpenAI({ text: 'x' }, null);
    await new OpenAITextProvider('a', client, 'dep', {}, { azure: true }).transcribe(await chunk(), { keywords: ['K'] });
    expect(client.calls[0].prompt).toBeUndefined();
  });

  it('createProviders reads AZURE_OPENAI_TRANSCRIBE_MODEL / _KEYWORDS and passes the role to the client factory', async () => {
    const client = fakeOpenAI({ text: 'x' }, { choices: [{ message: { content: '{}' } }] });
    const roles: string[] = [];
    const env = { AZURE_OPENAI_ENDPOINT: 'e', AZURE_OPENAI_API_KEY: 'k', AZURE_OPENAI_TRANSCRIBE_MODEL: 'gpt-transcribe', AZURE_OPENAI_TRANSCRIBE_KEYWORDS: '1', AZURE_SPEECH_KEY: 'k', AZURE_SPEECH_REGION: 'r' };
    const p = createProviders(
      { text: resolveSelection(parseModelSpec('azure-openai:asr'), 'text'), timing: resolveSelection(parseModelSpec('azure-speech'), 'timing'), llm: resolveSelection(parseModelSpec('azure-openai:chat'), 'llm') },
      env,
      { cwd: '/', deps: { azureOpenai: (_e, _d, role) => { roles.push(String(role)); return client; } } },
    );
    await p.text.transcribe({ path: await audioFile(), index: 0, start: 0, end: 1 }, { language: 'en', keywords: ['K'] });
    expect(roles).toEqual(['text', 'llm']);
    expect(client.calls[0]).toMatchObject({ model: 'asr', languages: ['en'], keywords: ['K'] });
  });
});

describe('OpenAI provider edge cases', () => {
  const req = { name: 'n', system: '', user: '', schema: { type: 'object' } };

  it('sanitizes the json_schema name', async () => {
    const client = fakeOpenAI(null, { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    const p = new OpenAILlmProvider('x', client, 'm');
    const long = `line-breaks:${'profile/très long id '.repeat(8)}`;
    await p.complete({ ...req, name: long });
    await p.complete({ ...req, name: long.replace('profile', 'other') });
    await p.complete({ ...req, name: 'ok_name-1' });
    await p.complete({ ...req, name: '' });
    const names = client.calls.map((c) => (c.response_format as { json_schema: { name: string } }).json_schema.name);
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(names[0]).toHaveLength(64);
    expect(names[0]).not.toBe(names[1]);
    expect(names[2]).toBe('ok_name-1');
  });

  it('derives the upload content type from the extension', async () => {
    const client = fakeOpenAI({ text: 'x' }, null);
    const p = new OpenAITextProvider('x', client, 'm');
    const dir = await tempDir('overtone-ct-');
    for (const [name, type] of [['a.mp3', 'audio/mpeg'], ['a.m4a', 'audio/mp4'], ['a.wav', 'audio/wav']]) {
      const path = join(dir, name!);
      await writeFile(path, Buffer.from([1]));
      await p.transcribe({ path, index: 0, start: 0, end: 1 }, {});
      expect((client.calls.at(-1)!.file as File).type).toBe(type);
    }
  });

  it('reports a content-filter block clearly and does not treat it as a format error', async () => {
    const blocked = new OpenAILlmProvider('x', fakeOpenAI(null, { choices: [{ message: { content: null }, finish_reason: 'content_filter' }] }), 'm');
    const err = await blocked.complete(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(LlmFormatError);
    expect((err as Error).message).toMatch(/blocked by the content filter/);
  });
});

describe('Anthropic and recorded edge cases', () => {
  const req = { name: 'n', system: '', user: '', schema: { type: 'object' } };

  it('treats a full context window like max_tokens', async () => {
    const client: AnthropicLike = { messages: { stream: () => ({ finalMessage: async () => ({ stop_reason: 'model_context_window_exceeded', content: [] }) }) } };
    await expect(new AnthropicLlmProvider('a', client, 'm').complete(req)).rejects.toMatchObject({ name: 'LlmFormatError', truncated: true });
  });

  it('recorded llm lookup ignores inherited object properties', async () => {
    const dir = await tempDir('overtone-rec-');
    await writeFile(join(dir, 'llm.json'), JSON.stringify({ styling: [{ a: 1 }] }));
    const p = new RecordedProvider(dir);
    await expect(p.complete({ ...req, name: 'constructor' })).rejects.toThrow(/no responses for "constructor"/);
    await expect(p.complete({ ...req, name: 'toString' })).rejects.toThrow(/no responses for "toString"/);
  });
});
