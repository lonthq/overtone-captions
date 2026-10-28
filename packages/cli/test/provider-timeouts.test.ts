import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseModelSpec } from '../src/config.js';
import { audioTimeoutMs, LLM_TIMEOUT_MS } from '../src/providers/kit.js';
import { OpenAITextProvider, OpenAITimingProvider, TRANSCRIPTION_TIMEOUT, type OpenAILike, type RequestOptions } from '../src/providers/openai.js';
import { createProvider, resolveSelection } from '../src/providers/registry.js';
import type { LlmProvider } from '../src/providers/types.js';
import { HttpError, isTimeout, retryTimeoutsOnce, withDeadline, withRetry } from '../src/util/retry.js';
import { tempDir } from './tmp.js';

const noSleep = { sleep: async () => {} };
const req = { name: 'corrections', system: 'sys', user: 'usr', schema: { type: 'object' } };

// Keep the SDK clients independent of the developer's environment.
beforeEach(() => {
  for (const name of ['OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) vi.stubEnv(name, undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** A fetch that never answers: it rejects only when its request is aborted. Counts the requests. */
function hangingFetch(): { fetch: typeof fetch; calls: () => number } {
  let n = 0;
  const f = (async (_url: string, init?: RequestInit) => {
    n++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new DOMException('aborted', 'AbortError')));
    });
  }) as unknown as typeof fetch;
  return { fetch: f, calls: () => n };
}

describe('isTimeout', () => {
  it.each([
    ['AbortSignal.timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), true],
    ['OpenAI SDK', new OpenAI.APIConnectionTimeoutError(), true],
    ['Anthropic SDK', new Anthropic.APIConnectionTimeoutError(), true],
    ['fetch: no headers in time', new TypeError('fetch failed', { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) }), true],
    ['fetch: body stalled', new TypeError('terminated', { cause: Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT' }) }), true],
    ['fetch: no connection (never sent)', new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }), false],
    ['SDK connection error', new OpenAI.APIConnectionError({ message: 'reset' }), false],
    ['HTTP 503', new HttpError(503, 'busy'), false],
  ])('%s → %s', (_name, err, want) => {
    expect(isTimeout(err)).toBe(want);
  });
});

describe('retryTimeoutsOnce', () => {
  it('retries a timeout once, other retryable errors the normal number of times, and keeps the caller\'s veto', async () => {
    let n = 0;
    const warned: unknown[] = [];
    await expect(withRetry(async () => { n++; throw new OpenAI.APIConnectionTimeoutError(); }, retryTimeoutsOnce(noSleep, (e) => warned.push(e)))).rejects.toThrow(OpenAI.APIConnectionTimeoutError);
    expect(n).toBe(2);
    expect(warned).toHaveLength(1);

    let m = 0;
    await expect(withRetry(async () => { m++; throw new HttpError(503, 'busy'); }, retryTimeoutsOnce(noSleep))).rejects.toThrow('busy');
    expect(m).toBe(5);

    let k = 0;
    const veto = retryTimeoutsOnce({ ...noSleep, shouldRetry: () => false });
    await expect(withRetry(async () => { k++; throw new OpenAI.APIConnectionTimeoutError(); }, veto)).rejects.toThrow();
    expect(k).toBe(1);
  });
});

describe('withDeadline', () => {
  it('turns whatever fetch throws after the deadline into a TimeoutError; extend() restarts the clock', async () => {
    vi.useFakeTimers();
    const { fetch: f } = hangingFetch();
    const late = withDeadline(1000, (signal) => f('x', { signal })).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1000);
    const err = await late;
    expect(isTimeout(err)).toBe(true);
    expect((err as Error).message).toBe('no answer within 1 s');

    let done = false;
    const kept = withDeadline(1000, async (_signal, extend) => {
      for (let i = 0; i < 3; i++) {
        await new Promise((r) => setTimeout(r, 900));
        extend();
      }
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2700);
    await kept;
    expect(done).toBe(true);
  });
});

describe('timeout policy', () => {
  it('scales transcription uploads with the audio length, with the LLM timeout as the floor', () => {
    expect(LLM_TIMEOUT_MS).toBe(300_000);
    expect(audioTimeoutMs(undefined, TRANSCRIPTION_TIMEOUT)).toBe(300_000);
    expect(audioTimeoutMs(-1, TRANSCRIPTION_TIMEOUT)).toBe(300_000);
    expect(audioTimeoutMs(60, TRANSCRIPTION_TIMEOUT)).toBe(300_000);
    expect(audioTimeoutMs(600, TRANSCRIPTION_TIMEOUT)).toBe(420_000);
    expect(audioTimeoutMs(1400, TRANSCRIPTION_TIMEOUT)).toBe(820_000);
  });
});

describe('a stalled request to an SDK-backed provider', () => {
  it('openai (llm): times out after LLM_TIMEOUT_MS and is sent once more only', async () => {
    vi.useFakeTimers();
    const { fetch: f, calls } = hangingFetch();
    const llm = createProvider('llm', resolveSelection(parseModelSpec('openai'), 'llm'), { OPENAI_API_KEY: 'sk-conformance-SECRET-fake' }, { cwd: '/', deps: { fetch: f, retry: noSleep } }) as LlmProvider;
    const result = llm.complete(req).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(LLM_TIMEOUT_MS - 1);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(LLM_TIMEOUT_MS);
    const err = await result;
    expect(isTimeout(err)).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * LLM_TIMEOUT_MS);
    expect(calls()).toBe(2);
  });

  it('anthropic (llm): a stream that does not start in time is sent once more only', async () => {
    vi.useFakeTimers();
    const { fetch: f, calls } = hangingFetch();
    const llm = createProvider('llm', resolveSelection(parseModelSpec('anthropic'), 'llm'), { ANTHROPIC_API_KEY: 'sk-conformance-SECRET-fake' }, { cwd: '/', deps: { fetch: f, retry: noSleep } }) as LlmProvider;
    const result = llm.complete(req).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(LLM_TIMEOUT_MS - 1);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(LLM_TIMEOUT_MS);
    const err = await result;
    expect(isTimeout(err)).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * LLM_TIMEOUT_MS);
    expect(calls()).toBe(2);
  });

  /** A fake client whose transcription calls time out like the SDK does; records each call's options. */
  function timingOut(): { client: OpenAILike; options: Array<RequestOptions | undefined> } {
    const options: Array<RequestOptions | undefined> = [];
    const client: OpenAILike = {
      audio: { transcriptions: { create: async (_p, o) => { options.push(o); throw new OpenAI.APIConnectionTimeoutError(); } } },
      chat: { completions: { create: async (_p, o) => { options.push(o); throw new OpenAI.APIConnectionTimeoutError(); } } },
    };
    return { client, options };
  }

  it('openai (text): passes a timeout for the chunk\'s length and retries a timeout once', async () => {
    const dir = await tempDir('ot-timeouts-');
    const path = join(dir, 'chunk-0.mp3');
    await writeFile(path, Buffer.from([1, 2, 3]));
    const { client, options } = timingOut();
    const p = new OpenAITextProvider('openai:gpt-transcribe', client, 'gpt-transcribe', noSleep);
    await expect(p.transcribe({ path, index: 0, start: 0, end: 600 }, {})).rejects.toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
    expect(options).toEqual([{ timeout: 420_000 }, { timeout: 420_000 }]);
  });

  it('openai (timing): passes a timeout for the piece\'s length to both calls and retries each timeout once', async () => {
    const dir = await tempDir('ot-timeouts-');
    const path = join(dir, 'audio.wav');
    await writeFile(path, Buffer.alloc(64));
    const { client, options } = timingOut();
    const p = new OpenAITimingProvider('openai:whisper-1+d', client, { words: 'whisper-1', diarize: 'd', retry: noSleep });
    await expect(p.align({ path, duration: 1000 }, {})).rejects.toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
    // words and diarization, each sent twice
    expect(options).toEqual(Array(4).fill({ timeout: 620_000 }));
  });

  it('openai (llm): passes LLM_TIMEOUT_MS', async () => {
    const { client, options } = timingOut();
    const createWith = createProvider('llm', resolveSelection(parseModelSpec('openai'), 'llm'), { OPENAI_API_KEY: 'k' }, { cwd: '/', deps: { openai: () => client, retry: noSleep } }) as LlmProvider;
    await expect(createWith.complete(req)).rejects.toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
    expect(options).toEqual([{ timeout: LLM_TIMEOUT_MS }, { timeout: LLM_TIMEOUT_MS }]);
  });
});

describe('a stalled Ollama answer', () => {
  const ollama = (f: typeof fetch) => createProvider('llm', resolveSelection(parseModelSpec('ollama'), 'llm'), {}, { cwd: '/', deps: { fetch: f, retry: noSleep } }) as LlmProvider;
  const final = `${JSON.stringify({ message: { content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 })}\n`;

  it('is aborted after LLM_TIMEOUT_MS without data and sent once more only', async () => {
    vi.useFakeTimers();
    const { fetch: f, calls } = hangingFetch();
    const result = ollama(f).complete(req).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(LLM_TIMEOUT_MS - 1);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(LLM_TIMEOUT_MS);
    expect(isTimeout(await result)).toBe(true);
    await vi.advanceTimersByTimeAsync(10 * LLM_TIMEOUT_MS);
    expect(calls()).toBe(2);
  });

  it('may take longer in total while it keeps sending pieces', async () => {
    vi.useFakeTimers();
    let n = 0;
    const pieces = ['{"a"', ':', '1}'];
    const f = (async () => {
      n++;
      const body = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          for (const content of pieces) {
            await new Promise((r) => setTimeout(r, LLM_TIMEOUT_MS - 1000));
            ctrl.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { content }, done: false })}\n`));
          }
          ctrl.enqueue(new TextEncoder().encode(final));
          ctrl.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const result = ollama(f).complete(req);
    await vi.advanceTimersByTimeAsync(3 * LLM_TIMEOUT_MS);
    expect(await result).toEqual({ a: 1 });
    expect(n).toBe(1);
  });
});
