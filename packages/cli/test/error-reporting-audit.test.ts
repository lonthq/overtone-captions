import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseModelSpec, resolveConfig } from '../src/config.js';
import { InternalError, UserError } from '../src/errors.js';
import { memoryLogger } from '../src/log.js';
import { openRun, type Run } from '../src/pipeline/run.js';
import type { PipelineConfig, PipelineDeps } from '../src/pipeline/types.js';
import { twoPassStep, type TwoPassInput } from '../src/pipeline/two-pass.js';
import { guarded } from '../src/program.js';
import { defineProvider, redactError } from '../src/providers/kit.js';
import { createProvider, preflight, registerProvider, resolveSelection } from '../src/providers/registry.js';
import type { AudioChunk, LlmProvider } from '../src/providers/types.js';
import { UsageMeter } from '../src/usage.js';
import { HttpError, isRetryable, networkFailure } from '../src/util/retry.js';
import { tempDir } from './tmp.js';

const SECRET = 'FAKE_SECRET_0123456789';
const env = { FAKE_LEAKY_KEY: SECRET };

const enotfound = (host = 'typo.example.com') =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND', hostname: host, syscall: 'getaddrinfo' }) });
const reset = () =>
  new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });

const removers: Array<() => void> = [];
afterEach(() => {
  while (removers.length > 0) removers.pop()!();
  process.exitCode = 0;
});

function leakyProvider(thrower: () => unknown) {
  return defineProvider({
    id: 'fake-leaky',
    description: 'throws errors whose causes hold the key',
    roles: ['llm'],
    env: [{ name: 'FAKE_LEAKY_KEY', description: 'a key', secret: true }],
    defaults: { llm: 'm' },
    preflight: async () => { throw thrower(); },
    create: () => ({ id: 'fake-leaky:m', complete: async () => { throw thrower(); } }),
  });
}

describe('secrets in the cause chain', () => {
  const nested = () => new TypeError('outer', { cause: new Error(`bad key ${SECRET}`) });

  it('a preflight error with the key in its cause prints no key through guarded', async () => {
    removers.push(registerProvider(leakyProvider(nested)));
    const spec = resolveSelection(parseModelSpec('fake-leaky'), 'llm');
    const log = memoryLogger();
    await guarded(log, async () => {
      await preflight({ text: spec, timing: spec, llm: spec }, env, { cwd: '/' });
      return 0;
    });
    expect(log.lines.join('\n')).toContain('caused by: Error: bad key [redacted]');
    expect(log.lines.join('\n')).not.toContain(SECRET);
  });

  it('a provider call whose error has the key deep in causes and an AggregateError prints no key', async () => {
    const deep = () => new Error('outer', {
      cause: new AggregateError([new Error(`first ${SECRET}`)], 'several', { cause: new Error('mid', { cause: `string ${SECRET}` }) }),
    });
    removers.push(registerProvider(leakyProvider(deep)));
    const llm = createProvider('llm', resolveSelection(parseModelSpec('fake-leaky'), 'llm'), env, { cwd: '/' }) as LlmProvider;
    const log = memoryLogger();
    let thrown: unknown;
    await guarded(log, async () => {
      try {
        await llm.complete({ name: 'n', system: '', user: '', schema: {} });
      } catch (err) {
        thrown = err;
        throw err;
      }
      return 0;
    });
    expect(log.lines.join('\n')).not.toContain(SECRET);
    const agg = (thrown as Error).cause as AggregateError;
    expect((agg.errors[0] as Error).message).toBe('first [redacted]');
    expect((agg.cause as Error).cause).toBe('string [redacted]');
  });

  it('replaces a frozen cause with a redacted copy (name, status kept) and survives a cycle', () => {
    const frozen = Object.freeze(Object.assign(new HttpError(401, `HTTP 401 for ${SECRET}`), { status: 401 }));
    const outer = new Error('outer', { cause: frozen });
    const out = redactError(outer, [SECRET]) as Error;
    expect(out).toBe(outer);
    const cause = out.cause as Error & { status?: number };
    expect(cause).not.toBe(frozen);
    expect(cause.message).toBe('HTTP 401 for [redacted]');
    expect(cause.name).toBe('HttpError');
    expect(cause.status).toBe(401);
    expect(String(cause.stack)).not.toContain(SECRET);

    const a = new Error(`a ${SECRET}`);
    const b = new Error(`b ${SECRET}`, { cause: a });
    (a as { cause?: unknown }).cause = b;
    redactError(a, [SECRET]);
    expect([a.message, b.message]).toEqual(['a [redacted]', 'b [redacted]']);
  });
});

async function openTestRun(useCache = true): Promise<{ run: Run; log: ReturnType<typeof memoryLogger> }> {
  const dir = await tempDir('overtone-run-errors-');
  const media = join(dir, 'clip.m4a');
  await writeFile(media, 'not really audio');
  const log = memoryLogger();
  const cfg = { cacheDir: join(dir, '.overtone'), useCache } as unknown as PipelineConfig;
  const run = await openRun(media, cfg, { cwd: dir, log } as unknown as PipelineDeps, {}, new UsageMeter());
  return { run, log };
}

async function stageError(run: Run, err: unknown): Promise<UserError> {
  const caught = await run.stage('transcribe', async () => { throw err; }).catch((e: unknown) => e);
  expect(caught).toBeInstanceOf(UserError);
  return caught as UserError;
}

describe('a stage that fails on the network', () => {
  it('a host name that does not resolve is a UserError with the host and no internal-error line', async () => {
    const { run, log } = await openTestRun();
    const err = await stageError(run, enotfound());
    expect(err.message).toMatch(/^Stage "transcribe" failed: fetch failed \(ENOTFOUND typo\.example\.com: the host name does not resolve\)\nCheck the provider's endpoint or region variable/);
    expect(log.lines.filter((l) => l.startsWith('error:'))).toEqual([]);
  });

  it('keeps the variable hint the provider wrapper added', async () => {
    const { run } = await openTestRun();
    const e = enotfound('westeurope2.stt.speech.microsoft.com');
    e.message = 'fetch failed (ENOTFOUND westeurope2.stt.speech.microsoft.com: the host name does not resolve; check AZURE_SPEECH_REGION)';
    const err = await stageError(run, e);
    expect(err.message).toContain('check AZURE_SPEECH_REGION');
  });

  it('a transient failure after the retries keeps the resume hint', async () => {
    const { run } = await openTestRun();
    const err = await stageError(run, reset());
    expect(err.message).toContain('ECONNRESET');
    expect(err.message).toContain('run the same command again to continue');
  });

  it('a TypeError that is no network failure is still reported as internal', async () => {
    const { run, log } = await openTestRun();
    const bug = new TypeError('x is not a function');
    await expect(run.stage('transcribe', async () => { throw bug; })).rejects.toBe(bug);
    expect(log.lines.some((l) => l.startsWith('error:') && l.includes('internal error'))).toBe(true);
  });
});

describe('the resume hint after a failed cache write', () => {
  async function failAfterAnAnswer(run: Run): Promise<UserError> {
    return stageError(run, await run.requests.run('transcribe', 'text', 'fake:p', { a: 1 }, async () => 'answer').then(() => new HttpError(503, 'HTTP 503 after retries')));
  }

  it('says the answers are cached when they were', async () => {
    const { run } = await openTestRun();
    expect((await failAfterAnAnswer(run)).message).toContain('Finished provider requests are cached in');
  });

  it.each([true, false])('does not claim they were when a write failed (useCache %s)', async (useCache) => {
    const { run, log } = await openTestRun(useCache);
    // a file where the requests folder should be: every cache write fails
    await mkdir(run.cache.dir, { recursive: true });
    await writeFile(run.requests.dir, 'in the way');
    const err = await failAfterAnAnswer(run);
    expect(log.lines.some((l) => l.startsWith('warn: Could not cache a provider answer'))).toBe(true);
    expect(err.message).not.toContain('Finished provider requests are cached');
    expect(err.message).not.toContain('were still cached');
    expect(err.message).toMatch(/some provider answers could not be cached/i);
  });
});

describe('--two-pass: bugs are not hidden behind the first pass', () => {
  async function setup(fail: Error) {
    const dir = await tempDir('overtone-two-pass-bug-');
    const log = memoryLogger();
    const pieces: AudioChunk[] = [0, 1].map((i) => ({ path: `/tmp/chunk-${i}.mp3`, index: i, start: i * 10, end: (i + 1) * 10 }));
    const words = [{ text: 'one', start: 1, end: 1.4, speaker: 'S1' }, { text: 'two', start: 11, end: 11.4, speaker: 'S1' }];
    const cfg = { ...(await resolveConfig({ export: 'json' }, {}, { cwd: dir, configDir: dir })), twoPass: true };
    const run = { cfg, deps: { cwd: dir, log }, log, step: async <T>(_p: string, _n: string, f: () => Promise<T>) => f() } as unknown as Run;
    const input: TwoPassInput = {
      plan: { sel: { timing: { same: false } } } as unknown as TwoPassInput['plan'],
      calls: {
        pieces,
        transcribe: async (_at: unknown, piece: AudioChunk) => {
          if (piece.index === 1) throw fail;
          return { index: piece.index, start: piece.start, end: piece.end, text: `second ${piece.index}` };
        },
      } as unknown as TwoPassInput['calls'],
      covered: { chunks: pieces.map((p, i) => ({ index: i, start: p.start, end: p.end, text: i === 0 ? 'one' : 'two' })), fallbacks: [], retries: [] } as unknown as TwoPassInput['covered'],
      hearings: { language: 'en', timing: { words }, engines: [{ id: 'fake:timing', words }] } as unknown as TwoPassInput['hearings'],
      context: { inferred: { topic: 'A talk.' }, inferredTerms: [] } as unknown as TwoPassInput['context'],
    };
    return { run, input, log };
  }

  it.each([new ReferenceError('chunk is not defined'), new InternalError('broken invariant'), new RangeError('Invalid array length')])('a %s stops the run', async (bug) => {
    const { run, input } = await setup(bug);
    await expect(twoPassStep(run, input)).rejects.toBe(bug);
  });

  it.each([new HttpError(503, 'HTTP 503 after retries'), enotfound(), reset()])('a provider failure (%s) keeps the first pass', async (failure) => {
    const { run, input, log } = await setup(failure);
    const res = await twoPassStep(run, input);
    expect(res.chunks.map((c) => c.text)).toEqual(['second 0', 'two']);
    expect(log.lines.some((l) => l.startsWith('warn: --two-pass: chunk 2/2'))).toBe(true);
  });
});

describe('a broken pipe', () => {
  it('to a local tool is no connection failure, so guarded prints no endpoint hint; it stays retryable over HTTP', async () => {
    const pipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write' });
    expect(networkFailure(pipe)).toBeUndefined();
    const log = memoryLogger();
    await guarded(log, async () => { throw new Error('whisper-cli stopped', { cause: pipe }); });
    expect(log.lines[0]).not.toMatch(/endpoint or region/);
    expect(isRetryable(new TypeError('fetch failed', { cause: pipe }))).toBe(true);
    expect(isRetryable(pipe)).toBe(true);
  });

  it('with a host is still a connection failure', () => {
    const pipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE', address: '10.0.0.1', port: 443 });
    expect(networkFailure(new TypeError('fetch failed', { cause: pipe }))).toEqual({ code: 'EPIPE', host: '10.0.0.1', port: 443 });
  });
});
