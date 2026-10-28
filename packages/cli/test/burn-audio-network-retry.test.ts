import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { audioArgs, burnArgs, containerOf, encode } from '../src/burn/encode.js';
import { parseModelSpec } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { guarded } from '../src/program.js';
import { explainNetworkError } from '../src/providers/kit.js';
import { createProvider, resolveSelection } from '../src/providers/registry.js';
import type { LlmProvider } from '../src/providers/types.js';
import { describeNetworkFailure, HttpError, isRetryable, networkFailure, timeoutError, withRetry } from '../src/util/retry.js';
import { tempDir } from './tmp.js';

const enotfound = (host = 'westeurope2.stt.speech.microsoft.com') =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', hostname: host, syscall: 'getaddrinfo' }) });

const refusedEverywhere = () => {
  const agg = Object.assign(new AggregateError([
    Object.assign(new Error('connect ECONNREFUSED ::1:11434'), { code: 'ECONNREFUSED', address: '::1', port: 11434 }),
    Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 11434 }),
  ]), { code: 'ECONNREFUSED' });
  return new TypeError('fetch failed', { cause: agg });
};

describe('burn: audio copy per container', () => {
  it('picks the container by extension, MP4 otherwise', () => {
    expect(containerOf('/a/b.MOV')).toBe('mov');
    expect(containerOf('x.m4v')).toBe('m4v');
    expect(containerOf('x.mp4')).toBe('mp4');
    expect(containerOf('x.partial-1.mkv')).toBe('mp4');
  });

  it.each([
    ['mp4', ['aac', 'mp3', 'opus', 'alac', 'ac3', 'eac3', 'flac'], ['pcm_s16le', 'vorbis']],
    ['mov', ['aac', 'mp3', 'alac', 'ac3', 'eac3'], ['opus', 'flac', 'pcm_s16le']],
    ['m4v', ['aac', 'alac', 'ac3'], ['mp3', 'eac3', 'opus', 'flac']],
  ] as const)('%s copies %j and re-encodes %j to AAC', (container, copied, reencoded) => {
    for (const c of copied) expect(audioArgs(c, container)).toEqual(['-c:a', 'copy']);
    for (const c of reencoded) expect(audioArgs(c, container)).toEqual(['-c:a', 'aac', '-b:a', '192k']);
    expect(audioArgs(undefined, container)).toEqual([]);
  });

  it('burnArgs decides by the container when given, else by the output name', () => {
    expect(burnArgs({ media: 'in.mkv', list: 'l', output: 'o.mov', audioCodec: 'opus' })).toContain('aac');
    expect(burnArgs({ media: 'in.mkv', list: 'l', output: 'o.mp4', audioCodec: 'opus' })).toContain('copy');
    // a temporary name without the final extension: the container passed in decides, not the name
    expect(burnArgs({ media: 'in.mkv', list: 'l', output: 'x.partial-123', audioCodec: 'eac3' })).toContain('copy');
    const m4v = burnArgs({ media: 'in.mkv', list: 'l', output: 'x.partial-123', audioCodec: 'eac3', container: 'm4v' });
    expect(m4v).toEqual(expect.arrayContaining(['-c:a', 'aac']));
    expect(m4v).not.toContain('copy');
    expect(burnArgs({ media: 'in.mkv', list: 'l', output: 'x.partial-123', audioCodec: 'opus', container: 'mov' })).toEqual(expect.arrayContaining(['-c:a', 'aac']));
  });

  it('encode writes the temporary file in the container of the final output', async () => {
    const dir = await tempDir('overtone-encode-container-');
    const output = join(dir, 'o.m4v');
    const calls: (readonly string[])[] = [];
    await encode({ media: '/in.mkv', list: '/l', output, audioCodec: 'eac3' }, async (_cmd, args) => {
      calls.push(args);
      await writeFile(args.at(-1)!, 'video');
      return { stdout: '', stderr: '' };
    });
    expect(calls).toHaveLength(1);
    const tmp = calls[0]!.at(-1)!;
    expect(tmp).not.toBe(output);
    // the same arguments as for the temporary name with the final output's container (m4v: E-AC-3 is re-encoded)
    expect(calls[0]).toEqual(burnArgs({ media: '/in.mkv', list: '/l', output: tmp, audioCodec: 'eac3', container: 'm4v' }));
    expect(calls[0]).not.toContain('copy');
    expect(await readFile(output, 'utf8')).toBe('video');
  });
});

describe('network failures', () => {
  it('finds the code and the host in the cause chain, also inside an AggregateError', () => {
    expect(networkFailure(enotfound('a.example'))).toEqual({ code: 'ENOTFOUND', host: 'a.example' });
    expect(networkFailure(refusedEverywhere())).toEqual({ code: 'ECONNREFUSED', host: '::1', port: 11434 });
    expect(networkFailure(new OpenAI.APIConnectionError({ message: 'Connection error.', cause: enotfound('x.openai.azure.com') }))).toEqual({ code: 'ENOTFOUND', host: 'x.openai.azure.com' });
    expect(networkFailure(Object.assign(new Error('x'), { code: 'EACCES' }))).toBeUndefined();
    expect(describeNetworkFailure(enotfound('a.example'))).toBe('ENOTFOUND a.example: the host name does not resolve');
  });

  it('retries a host name that does not resolve (a network outage answers ENOTFOUND too), also under the SDK connection error', () => {
    expect(isRetryable(enotfound())).toBe(true);
    expect(isRetryable(new OpenAI.APIConnectionError({ message: 'Connection error.', cause: enotfound() }))).toBe(true);
    expect(isRetryable(refusedEverywhere())).toBe(true);
    expect(isRetryable(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'EAI_AGAIN' }) }))).toBe(true);
  });

  it('explainNetworkError appends the cause and the variables to check, keeping the class; leaves timeouts alone', () => {
    const sdk = new OpenAI.APIConnectionError({ message: 'Connection error.', cause: enotfound('typo.openai.azure.com') });
    const out = explainNetworkError(sdk, ['AZURE_OPENAI_ENDPOINT']);
    expect(out).toBe(sdk);
    expect(sdk.message).toBe('Connection error. (ENOTFOUND typo.openai.azure.com: the host name does not resolve; check AZURE_OPENAI_ENDPOINT)');
    const t = timeoutError(1000);
    expect((explainNetworkError(t) as Error).message).toBe('no answer within 1 s');
  });

  it('a provider built by the registry retries, then fails naming the host and the variable', async () => {
    let n = 0;
    const f = (async () => { n++; throw enotfound('olama.local'); }) as unknown as typeof fetch;
    const log = memoryLogger();
    const sel = resolveSelection(parseModelSpec('ollama'), 'llm');
    const llm = createProvider('llm', sel, {}, { cwd: '/', log, deps: { fetch: f, retry: { sleep: async () => {} } } }) as LlmProvider;
    await expect(llm.complete({ name: 'n', system: '', user: '', schema: {} }))
      .rejects.toThrow('fetch failed (ENOTFOUND olama.local: the host name does not resolve; check OLLAMA_BASE_URL)');
    expect(n).toBeGreaterThan(1);
  });

  it('guarded prints a network failure without a stack, and other errors with their cause chain', async () => {
    const log = memoryLogger();
    await guarded(log, async () => { throw enotfound('a.example'); });
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatch(/^error: fetch failed \(ENOTFOUND a\.example: the host name does not resolve\)\nCheck the provider's endpoint/);
    expect(log.lines[0]).not.toMatch(/\n\s+at /);
    const log2 = memoryLogger();
    await guarded(log2, async () => { throw new Error('outer', { cause: new Error('inner') }); });
    expect(log2.lines[0]).toMatch(/^error: Error: outer\n\s+at /);
    expect(log2.lines[0]).toMatch(/\ncaused by: Error: inner$/);
    process.exitCode = 0;
  });
});

describe('retry rules for permanent failures and message hints', () => {
  it('does not retry a used-up quota (429 insufficient_quota) nor 501/505', () => {
    const quota = OpenAI.APIError.generate(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }, undefined, new Headers());
    expect(isRetryable(quota)).toBe(false);
    expect(isRetryable(new HttpError(429, 'OpenAI returned HTTP 429: {"error":{"code":"insufficient_quota"}}'))).toBe(false);
    expect(isRetryable(OpenAI.APIError.generate(429, { error: { message: 'Rate limit', type: 'requests', code: 'rate_limit_exceeded' } }, undefined, new Headers()))).toBe(true);
    expect(isRetryable(new HttpError(501, 'not implemented'))).toBe(false);
    expect(isRetryable(new HttpError(505, 'version'))).toBe(false);
    expect(isRetryable(new HttpError(502, 'bad gateway'))).toBe(true);
  });

  it('waits as long as a 429 message says when there is no Retry-After header, clamped like Retry-After', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number) => { waits.push(ms); };
    const once = (err: Error) => { let n = 0; return async () => { if (n++ === 0) throw err; return 'ok'; }; };
    const opts = { sleep, baseMs: 1, random: () => 0.5 };
    await withRetry(once(new HttpError(429, 'Requests to the ChatCompletions_Create Operation have exceeded the rate limit. Please retry after 36 seconds.')), opts);
    await withRetry(once(new HttpError(429, 'Rate limit; retry after 1 second')), opts);
    await withRetry(once(new HttpError(429, 'retry after 600 seconds')), opts);
    // a header wins; a 503 message is not read
    await withRetry(once(new HttpError(429, 'retry after 36 seconds', new Headers({ 'retry-after': '2' }))), opts);
    await withRetry(once(new HttpError(503, 'retry after 36 seconds')), opts);
    expect(waits).toEqual([36_000, 1000, 60_000, 2000, 1]);
  });

  it('the retry warning of a timed-out request says it is sent again once, not "retry 1 of 4"', async () => {
    let n = 0;
    const f = (async () => {
      if (n++ === 0) throw timeoutError(1000);
      return new Response(`${JSON.stringify({ message: { content: '{"a":1}' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 })}\n`, { status: 200 });
    }) as unknown as typeof fetch;
    const log = memoryLogger();
    const sel = resolveSelection(parseModelSpec('ollama'), 'llm');
    const llm = createProvider('llm', sel, {}, { cwd: '/', log, deps: { fetch: f, retry: { sleep: async () => {}, random: () => 0.5 } } }) as LlmProvider;
    expect(await llm.complete({ name: 'n', system: '', user: '', schema: {} })).toEqual({ a: 1 });
    expect(log.lines.filter((l) => l.startsWith('warn: '))).toEqual([
      `warn: ${sel.id} (llm): no answer within 1 s; sending it again once (a timed-out request is sent again once at most) in 1.0 s`,
    ]);
  });
});
