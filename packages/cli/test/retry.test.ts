import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { checkSchema, withSchemaValidation } from '../src/providers/structured.js';
import { LlmFormatError, type LlmProvider, type LlmRequest } from '../src/providers/types.js';
import { parseModelSpec } from '../src/config.js';
import { memoryLogger } from '../src/log.js';
import { createProvider, resolveSelection } from '../src/providers/registry.js';
import { HttpError, isRetryable, reportTimeouts, timeoutError, withRetry } from '../src/util/retry.js';

const noSleep = { sleep: async () => {}, baseMs: 1 };
/** random() = 0.5 means a jitter factor of exactly 1. */
const noJitter = () => 0.5;

describe('reportTimeouts', () => {
  it('calls onTimeout for each attempt that ran out of time, and for nothing else', async () => {
    const timedOut: unknown[] = [];
    let n = 0;
    const attempt = reportTimeouts(async () => {
      n++;
      if (n === 1) throw timeoutError(5000);
      if (n === 2) throw new HttpError(503, 'busy');
      return 'ok';
    }, (err) => timedOut.push(err));
    expect(await withRetry(attempt, { sleep: async () => {} })).toBe('ok');
    expect(n).toBe(3);
    expect(timedOut).toHaveLength(1);
    expect((timedOut[0] as Error).name).toBe('TimeoutError');
  });
});

describe('isRetryable', () => {
  it.each([
    [new HttpError(429, 'rate'), true],
    [new HttpError(503, 'down'), true],
    [new HttpError(408, 'timeout'), true],
    [new HttpError(400, 'bad'), false],
    [new HttpError(401, 'auth'), false],
    [new HttpError(409, 'conflict'), true],
    [new OpenAI.APIConnectionError({ message: 'x' }), true],
    [new OpenAI.APIConnectionTimeoutError(), true],
    [new Anthropic.APIConnectionError({ message: 'x' }), true],
    [new Anthropic.APIConnectionTimeoutError(), true],
    [new OpenAI.APIUserAbortError(), false],
    [new Anthropic.APIUserAbortError(), false],
    [Anthropic.APIError.generate(529, {}, 'overloaded', new Headers()), true],
    [Anthropic.APIError.generate(400, {}, 'bad', new Headers()), false],
    [OpenAI.APIError.generate(500, {}, 'ise', new Headers()), true],
    // Anthropic SSE error events carry no HTTP status
    [new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error' } }, undefined, new Headers(), 'overloaded_error'), true],
    [new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error' } }, undefined, new Headers()), true],
    [new Anthropic.APIError(undefined, { type: 'error', error: { type: 'api_error' } }, undefined, new Headers()), true],
    [new Anthropic.APIError(undefined, { type: 'error', error: { type: 'rate_limit_error' } }, undefined, new Headers()), true],
    [new Anthropic.APIError(undefined, { type: 'error', error: { type: 'invalid_request_error' } }, undefined, new Headers()), false],
    [Object.assign(new Error('x'), { code: 'ECONNRESET' }), true],
    // a host name that does not resolve: a typo, or a short network outage (seen live), so it is retried
    [Object.assign(new Error('x'), { code: 'ENOTFOUND' }), true],
    [Object.assign(new Error('x'), { code: 'ENETUNREACH' }), true],
    [Object.assign(new Error('x'), { code: 'UND_ERR_CONNECT_TIMEOUT' }), true],
    [Object.assign(new Error('x'), { code: 'UND_ERR_HEADERS_TIMEOUT' }), true],
    [Object.assign(new Error('x'), { code: 'UND_ERR_BODY_TIMEOUT' }), true],
    [Object.assign(new Error('x'), { code: 'EACCES' }), false],
    [new TypeError('fetch failed'), true],
    [new TypeError('terminated'), true],
    [new TypeError('other'), false],
    [new DOMException('timed out', 'TimeoutError'), true],
    [new DOMException('aborted', 'AbortError'), false],
    [new Error('logic'), false],
    [null, false],
    [undefined, false],
    [new HttpError(503, 'down', new Headers({ 'x-should-retry': 'false' })), false],
    [new HttpError(503, 'down', new Headers({ 'x-should-retry': 'true' })), true],
  ])('%s → %s', (err, expected) => {
    expect(isRetryable(err)).toBe(expected);
  });

  it('recognises connection errors from a second copy of an SDK by constructor name (their .name is "Error")', () => {
    class APIConnectionError extends Error {}
    class APIConnectionTimeoutError extends APIConnectionError {}
    class Other extends Error {}
    expect(new APIConnectionError('x').name).toBe('Error');
    expect(isRetryable(new APIConnectionError('x'))).toBe(true);
    expect(isRetryable(new APIConnectionTimeoutError('x'))).toBe(true);
    expect(isRetryable(new Other('x'))).toBe(false);
    expect(isRetryable(Object.create(null))).toBe(false);
  });

  it('x-should-retry: true forces a retry for a status that is normally not retried', () => {
    const yes = new Headers({ 'x-should-retry': 'true' });
    expect(isRetryable(new HttpError(400, 'bad', yes))).toBe(true);
    expect(isRetryable(new HttpError(404, 'gone', yes))).toBe(true);
    expect(isRetryable(new HttpError(400, 'bad', new Headers()))).toBe(false);
    expect(isRetryable(Anthropic.APIError.generate(400, {}, 'bad', yes))).toBe(true);
    // a user abort is still final
    const abort = new OpenAI.APIUserAbortError();
    (abort as unknown as { headers: Headers }).headers = yes;
    expect(isRetryable(abort)).toBe(false);
  });

  it('walks the cause chain (fetch failed → undici error → errno)', () => {
    const inner = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    const mid = new Error('mid', { cause: inner });
    expect(isRetryable(new TypeError('wrapped', { cause: mid }))).toBe(true);
    expect(isRetryable(new Error('wrapped', { cause: new TypeError('terminated') }))).toBe(true);
  });

  it('gives up on cause chains deeper than 4 levels and on cycles', () => {
    let deep: unknown = Object.assign(new Error('leaf'), { code: 'ECONNRESET' });
    for (let i = 0; i < 5; i++) deep = new Error(`l${i}`, { cause: deep });
    expect(isRetryable(deep)).toBe(false);
    const a = new Error('a') as Error & { cause?: unknown };
    a.cause = a;
    expect(isRetryable(a)).toBe(false);
  });
});

describe('withRetry', () => {
  it('retries retryable failures with exponential backoff', async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new HttpError(429, 'slow down');
        return 'ok';
      },
      { sleep: async (ms) => { delays.push(ms); }, baseMs: 100, random: noJitter },
    );
    expect(result).toBe('ok');
    expect(delays).toEqual([100, 200]);
  });

  it('does not retry client errors', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new HttpError(400, 'bad request'); }, noSleep)).rejects.toThrow('bad request');
    expect(calls).toBe(1);
  });

  it('lets shouldRetry veto a retryable error', async () => {
    let calls = 0;
    const shouldRetry = (_e: unknown, attempt: number) => attempt < 1;
    await expect(withRetry(async () => { calls++; throw new HttpError(500, 'boom'); }, { ...noSleep, shouldRetry })).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });

  it('gives up after the configured retries', async () => {
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw new HttpError(500, 'boom'); }, { ...noSleep, retries: 2 })).rejects.toThrow('boom');
    expect(calls).toBe(3);
  });

  it('caps the delay', async () => {
    const delays: number[] = [];
    await expect(
      withRetry(async () => { throw new HttpError(503, 'x'); }, { retries: 3, baseMs: 1000, maxMs: 1500, random: noJitter, sleep: async (ms) => { delays.push(ms); } }),
    ).rejects.toThrow();
    expect(delays).toEqual([1000, 1500, 1500]);
  });
});

describe('withRetry delays', () => {
  /** Fail once with `err`, then succeed; returns the one delay that was waited. */
  const delayFor = async (err: unknown, opts: Parameters<typeof withRetry>[1] = {}): Promise<number> => {
    const delays: number[] = [];
    let calls = 0;
    await withRetry(
      async () => { if (calls++ === 0) throw err; return 'ok'; },
      { baseMs: 1000, random: noJitter, sleep: async (ms) => { delays.push(ms); }, ...opts },
    );
    return delays[0]!;
  };

  it('applies ±25% jitter to the backoff', async () => {
    expect(await delayFor(new HttpError(500, 'x'), { random: () => 0 })).toBe(750);
    expect(await delayFor(new HttpError(500, 'x'), { random: () => 1 })).toBe(1250);
  });

  it('never jitters past maxMs', async () => {
    expect(await delayFor(new HttpError(500, 'x'), { random: () => 1, maxMs: 1000 })).toBe(1000);
  });

  it('honours retry-after in seconds when it is longer than the backoff', async () => {
    expect(await delayFor(new HttpError(429, 'x', new Headers({ 'retry-after': '7' })))).toBe(7000);
  });

  it('prefers retry-after-ms', async () => {
    expect(await delayFor(new HttpError(429, 'x', new Headers({ 'retry-after-ms': '2500', 'retry-after': '9' })))).toBe(2500);
  });

  it('honours retry-after as an HTTP date', async () => {
    const date = new Date(Date.now() + 10_000).toUTCString();
    const ms = await delayFor(new HttpError(429, 'x', new Headers({ 'retry-after': date })));
    expect(ms).toBeGreaterThan(7000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it('keeps the backoff when retry-after is shorter', async () => {
    expect(await delayFor(new HttpError(429, 'x', new Headers({ 'retry-after': '0.1' })))).toBe(1000);
  });

  it('ignores unparseable retry-after values', async () => {
    expect(await delayFor(new HttpError(429, 'x', new Headers({ 'retry-after': 'soon' })))).toBe(1000);
  });

  it('clamps retry-after to 60 s, or to maxMs when that is larger', async () => {
    const err = () => new HttpError(429, 'x', new Headers({ 'retry-after': '3600' }));
    expect(await delayFor(err())).toBe(60_000);
    expect(await delayFor(err(), { maxMs: 120_000 })).toBe(120_000);
  });

  it('reads retry-after from real SDK errors', async () => {
    const err = Anthropic.APIError.generate(429, {}, 'rl', new Headers({ 'retry-after': '2' }));
    expect(await delayFor(err)).toBe(2000);
  });

  it('does not retry when x-should-retry is false', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new HttpError(503, 'no', new Headers({ 'x-should-retry': 'false' })); }, noSleep),
    ).rejects.toThrow('no');
    expect(calls).toBe(1);
  });

  it('retries a status that is normally final when x-should-retry is true, within the attempt limit', async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls++; throw new HttpError(400, 'again', new Headers({ 'x-should-retry': 'true' })); }, { ...noSleep, retries: 2 }),
    ).rejects.toThrow('again');
    expect(calls).toBe(3);
  });

  it('retries real SDK connection errors', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      if (calls++ < 2) throw new OpenAI.APIConnectionError({ message: 'Connection error.' });
      return 'ok';
    }, noSleep);
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });
});

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['edits'],
  properties: {
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['first', 'reason'],
        properties: { first: { type: 'integer' }, reason: { type: 'string', enum: ['correction', 'style'] }, note: { type: ['string', 'null'] } },
      },
    },
  },
};

describe('retries of a provider created by the registry', () => {
  it('are logged, so a wait of up to a minute does not look stuck', async () => {
    let n = 0;
    const f = (async () => (n++ === 0
      ? new Response('busy', { status: 503 })
      : new Response(`${JSON.stringify({ message: { content: '{"a":1}' }, done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 })}\n`, { status: 200 }))) as unknown as typeof fetch;
    const log = memoryLogger();
    const sel = resolveSelection(parseModelSpec('ollama'), 'llm');
    const llm = createProvider('llm', sel, {}, { cwd: '/', log, deps: { fetch: f, retry: { sleep: async () => {}, random: () => 0.5 } } }) as LlmProvider;
    expect(await llm.complete({ name: 'n', system: '', user: '', schema: {} })).toEqual({ a: 1 });
    expect(log.lines.filter((l) => l.startsWith('warn: '))).toEqual([`warn: ${sel.id} (llm): HTTP 503; retry 1 of 4 in 1.0 s`]);
  });
});

describe('checkSchema', () => {
  it('accepts a matching value', () => {
    expect(checkSchema(SCHEMA, { edits: [{ first: 1, reason: 'style', note: null }] })).toEqual([]);
  });
  it.each([
    [[], ['$: expected object']],
    [{}, ['$.edits: missing']],
    [{ edits: [{ first: 1.5, reason: 'style' }] }, ['$.edits[0].first: expected integer']],
    [{ edits: [{ first: 1, reason: 'other' }] }, ['$.edits[0].reason: must be one of ["correction","style"]']],
    [{ edits: [], extra: 1 }, ['$.extra: unexpected property']],
  ])('reports %j', (value, issues) => {
    expect(checkSchema(SCHEMA, value)).toEqual(issues);
  });
});

describe('checkSchema hardening', () => {
  const OBJ = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'integer' } } };

  it('does not mistake inherited Object.prototype keys for present or declared properties', () => {
    expect(checkSchema(OBJ, JSON.parse('{"a":1,"constructor":5}'))).toEqual(['$.constructor: unexpected property']);
    expect(checkSchema(OBJ, JSON.parse('{"a":1,"__proto__":5}'))).toEqual(['$.__proto__: unexpected property']);
    expect(checkSchema({ type: 'object', required: ['toString'], properties: { toString: { type: 'string' } } }, {})).toEqual(['$.toString: missing']);
  });

  it('validates properties that are named like Object.prototype members', () => {
    const schema = { type: 'object', required: ['constructor'], properties: { constructor: { type: 'string' } } };
    expect(checkSchema(schema, JSON.parse('{"constructor":"x"}'))).toEqual([]);
    expect(checkSchema(schema, JSON.parse('{"constructor":1}'))).toEqual(['$.constructor: expected string']);
  });

  it.each([
    [{ type: 'integer', minimum: 0 }, 'minimum'],
    [{ type: 'string', pattern: '^a' }, 'pattern'],
    [{ anyOf: [{ type: 'string' }] }, 'anyOf'],
    [{ type: 'object', properties: { a: { type: 'array', items: { type: 'string', format: 'uri' } } } }, 'format'],
  ])('throws on unsupported keyword in %j', (schema, keyword) => {
    expect(() => checkSchema(schema, 1)).toThrow(new RegExp(`unsupported schema keyword "${keyword}"`));
  });

  it('throws on unsupported types, even in parts the value never reaches', () => {
    expect(() => checkSchema({ type: 'object', properties: { a: { type: 'tuple' } } }, {})).toThrow(/unsupported schema type "tuple" at \$\.a/);
  });

  it('throws when additionalProperties is a schema', () => {
    expect(() => checkSchema({ type: 'object', additionalProperties: { type: 'string' } }, {})).toThrow(/additionalProperties/);
  });

  it('accepts description and title', () => {
    expect(checkSchema({ type: 'string', description: 'd', title: 't' }, 'x')).toEqual([]);
  });
});

describe('withSchemaValidation', () => {
  const req: LlmRequest = { name: 'corrections', system: 's', user: 'u', schema: SCHEMA };
  const fake = (answers: Array<unknown | Error>): LlmProvider & { users: string[] } => {
    const users: string[] = [];
    return {
      id: 'fake',
      users,
      async complete<T>(r: LlmRequest): Promise<T> {
        users.push(r.user);
        const a = answers.shift();
        if (a instanceof Error) throw a;
        return a as T;
      },
    };
  };

  it('passes valid responses through', async () => {
    const llm = fake([{ edits: [] }]);
    expect(await withSchemaValidation(llm).complete(req)).toEqual({ edits: [] });
    expect(llm.users).toHaveLength(1);
  });

  it('retries once with the issues appended', async () => {
    const llm = fake([{ nope: true }, { edits: [] }]);
    const log = memoryLogger();
    expect(await withSchemaValidation(llm, log).complete(req)).toEqual({ edits: [] });
    expect(llm.users[1]).toMatch(/Your previous answer was invalid: \$\.edits: missing/);
    expect(log.lines[0]).toMatch(/^warn: corrections: response did not match the schema/);
  });

  it('treats unparseable JSON like a mismatch', async () => {
    const llm = fake([new LlmFormatError('response is not valid JSON'), { edits: [] }]);
    expect(await withSchemaValidation(llm).complete(req)).toEqual({ edits: [] });
  });

  it('fails after the retry', async () => {
    const llm = fake([{}, {}]);
    await expect(withSchemaValidation(llm).complete(req)).rejects.toThrow(/does not match the schema after one retry: \$\.edits: missing/);
  });

  it('fails fast, without a retry, when the response was cut off', async () => {
    const llm = fake([new LlmFormatError('response was cut off (max tokens)'), { edits: [] }]);
    await expect(withSchemaValidation(llm).complete(req)).rejects.toThrow(/corrections: .*cut off.*did not fit the token limit.*lower reasoning effort/s);
    expect(llm.users).toHaveLength(1);
  });

  it('keeps the provider\'s own advice when it names a limit to raise (Ollama)', async () => {
    const llm = fake([new LlmFormatError('the prompt and the answer filled the whole context window (16384 tokens), so the prompt was cut; raise OLLAMA_NUM_CTX', { truncated: true })]);
    const err = (await withSchemaValidation(llm).complete(req).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/raise OLLAMA_NUM_CTX; the answer did not fit the token limit, so retrying would not help\.$/);
  });

  it('fails fast for a truncated LlmFormatError flag', async () => {
    const llm = fake([new LlmFormatError('stopped early', { truncated: true }), { edits: [] }]);
    await expect(withSchemaValidation(llm).complete(req)).rejects.toThrow(/did not fit the token limit, so retrying would not help/);
    expect(llm.users).toHaveLength(1);
  });

  it('throws a developer error for unsupported schemas before calling the model', async () => {
    const llm = fake([{}]);
    await expect(withSchemaValidation(llm).complete({ ...req, schema: { type: 'integer', minimum: 1 } })).rejects.toThrow(/unsupported schema keyword/);
    expect(llm.users).toHaveLength(0);
  });

  it('does not retry other errors', async () => {
    const llm = fake([new Error('HTTP 401')]);
    await expect(withSchemaValidation(llm).complete(req)).rejects.toThrow('HTTP 401');
    expect(llm.users).toHaveLength(1);
  });
});
