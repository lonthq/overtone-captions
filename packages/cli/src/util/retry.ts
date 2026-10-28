import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/** Anything with a case-insensitive `get`, like the fetch `Headers`. */
export interface HeaderLike { get(name: string): string | null | undefined }

/** An HTTP failure from a fetch-based provider. Pass `res.headers` so Retry-After is honored. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers?: HeaderLike) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Extra attempts after the first, unless `RetryOptions.retries` says otherwise. */
export const DEFAULT_RETRIES = 4;

export interface RetryOptions {
  /** Extra attempts after the first (default DEFAULT_RETRIES). */
  retries?: number;
  /** First delay in ms (default 1000); doubles per attempt. */
  baseMs?: number;
  /** Backoff cap in ms (default 30000). */
  maxMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0, 1); backoff is scaled by 0.75 + 0.5 × random(). */
  random?: () => number;
  /** Called before each wait; `attempt` is the upcoming retry, 1-based. */
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
  /** Veto on top of `isRetryable`: return false to stop retrying. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
}

/**
 * Retryable network failures. ENOTFOUND included: a short outage also returns it for a valid host, and a retry
 * costs only seconds.
 */
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'ENOTFOUND', 'ENETUNREACH',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
]);
const RETRYABLE_API_TYPES = new Set(['overloaded_error', 'api_error', 'rate_limit_error']);
const MAX_CAUSE_DEPTH = 4;
/** Longest Retry-After we wait for, unless `maxMs` is larger. */
const RETRY_AFTER_CLAMP_MS = 60_000;

/** 5xx statuses a retry cannot fix (method or HTTP version not supported). */
const PERMANENT_5XX = new Set([501, 505]);
/** OpenAI's 429 for an account without credit: waiting does not help. */
const PERMANENT_429_CODES = new Set(['insufficient_quota']);

type ErrLike = {
  status?: unknown; name?: unknown; code?: unknown; type?: unknown; cause?: unknown; headers?: unknown;
  error?: { error?: { type?: unknown; code?: unknown }; type?: unknown; code?: unknown } | null;
} | null | undefined;

/** A 429 for a used-up quota (OpenAI SDK: `code`/`type`; HttpError: in the message). */
function isQuotaExhausted(err: unknown): boolean {
  const e = err as ErrLike & { message?: unknown };
  const fields = [e?.code, e?.type, e?.error?.code, e?.error?.type, e?.error?.error?.code, e?.error?.error?.type];
  if (fields.some((f) => typeof f === 'string' && PERMANENT_429_CODES.has(f))) return true;
  return typeof e?.message === 'string' && /\binsufficient_quota\b/.test(e.message);
}

/** Connection failure codes: the retryable ones plus those a retry does not fix. */
const CONNECTION_CODES = new Set([...NETWORK_CODES, 'ENOTFOUND', 'EHOSTUNREACH']);

/** A network failure from the `cause` chain, with host and port when the error names them. */
export interface NetworkFailure { code: string; host?: string; port?: number }

/**
 * The first connection failure in the `cause` chain (fetch failed → undici error → errno), including an
 * AggregateError's `errors` (Node's fetch when every address refused). The host is `hostname` or `address`, never a
 * URL, so it carries no credentials.
 */
export function networkFailure(err: unknown): NetworkFailure | undefined {
  const queue: Array<{ e: unknown; depth: number }> = [{ e: err, depth: 0 }];
  while (queue.length > 0) {
    const { e, depth } = queue.shift()!;
    if (!e || typeof e !== 'object' || depth > MAX_CAUSE_DEPTH) continue;
    const x = e as { code?: unknown; hostname?: unknown; address?: unknown; port?: unknown; cause?: unknown; errors?: unknown };
    const host = typeof x.hostname === 'string' ? x.hostname : typeof x.address === 'string' ? x.address : undefined;
    // EPIPE without a host is usually a local tool (ffmpeg, whisper-cli) that exited while we wrote to it
    const connection = typeof x.code === 'string' && (x.code === 'EPIPE' ? host !== undefined : CONNECTION_CODES.has(x.code) || x.code.startsWith('UND_ERR_'));
    if (connection && typeof x.code === 'string') {
      // an AggregateError has the code; the address is on its errors
      const inner = !host && Array.isArray(x.errors) ? networkFailure(x.errors[0]) : undefined;
      return {
        code: x.code,
        ...(host ? { host } : inner?.host ? { host: inner.host } : {}),
        ...(typeof x.port === 'number' ? { port: x.port } : inner?.port !== undefined ? { port: inner.port } : {}),
      };
    }
    if (x.cause !== undefined) queue.push({ e: x.cause, depth: depth + 1 });
    if (Array.isArray(x.errors)) for (const sub of x.errors) queue.push({ e: sub, depth: depth + 1 });
  }
  return undefined;
}

const NETWORK_WORDS: Readonly<Record<string, string>> = {
  ENOTFOUND: 'the host name does not resolve',
  EAI_AGAIN: 'the DNS lookup failed for now',
  ECONNREFUSED: 'the connection was refused',
  ECONNRESET: 'the connection was reset',
  ETIMEDOUT: 'the connection timed out',
  ENETUNREACH: 'the network is unreachable',
  EHOSTUNREACH: 'the host is unreachable',
  UND_ERR_CONNECT_TIMEOUT: 'the connection timed out',
};

/** E.g. "ENOTFOUND westeurope2.stt.speech.microsoft.com: the host name does not resolve"; undefined if none. */
export function describeNetworkFailure(err: unknown): string | undefined {
  const f = networkFailure(err);
  if (!f) return undefined;
  const where = f.host ? ` ${f.host}${f.port !== undefined ? `:${f.port}` : ''}` : '';
  const words = NETWORK_WORDS[f.code];
  return `${f.code}${where}${words ? `: ${words}` : ''}`;
}

function header(err: unknown, name: string): string | undefined {
  const headers = (err as ErrLike)?.headers as Partial<HeaderLike> | undefined;
  if (!headers || typeof headers.get !== 'function') return undefined;
  return headers.get(name) ?? undefined;
}

/** The HTTP status of an HttpError or an OpenAI/Anthropic SDK error, if any. */
export function httpStatus(err: unknown): number | undefined {
  const status = (err as ErrLike)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Node's fetch (undici) gave up waiting for the headers or the body. */
const UNDICI_TIMEOUT_CODES = new Set(['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);

/**
 * A request that timed out after it was sent, so the service may have processed and billed it: a TimeoutError, an
 * SDK APIConnectionTimeoutError or an undici header/body timeout in the first links of the `cause` chain. A connect
 * timeout does not count: the request never arrived.
 */
export function isTimeout(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur && typeof cur === 'object' && depth < MAX_CAUSE_DEPTH; depth++) {
    const e = cur as { name?: unknown; code?: unknown; cause?: unknown };
    if (e.name === 'TimeoutError') return true;
    if (cur instanceof OpenAI.APIConnectionTimeoutError || cur instanceof Anthropic.APIConnectionTimeoutError) return true;
    // a second copy of an SDK in node_modules, where instanceof fails (see isRetryable)
    if ((cur as object).constructor?.name === 'APIConnectionTimeoutError') return true;
    if (typeof e.code === 'string' && UNDICI_TIMEOUT_CODES.has(e.code)) return true;
    cur = e.cause;
  }
  return false;
}

/** A timeout error named TimeoutError, like AbortSignal.timeout's, so `isTimeout` sees it. */
export function timeoutError(ms: number): Error {
  const err = new Error(`no answer within ${ms / 1000} s`);
  err.name = 'TimeoutError';
  return err;
}

/**
 * Retries after a timeout. The service may have processed and billed the request anyway, so it is resent once at
 * most; other retryable errors keep the normal count.
 */
export const TIMEOUT_RETRIES = 1;

/**
 * `retry` with a veto that allows at most TIMEOUT_RETRIES retries after a timeout, on top of the caller's
 * `shouldRetry`. Make one per request (it counts that request's timeouts). `onTimeoutRetry` runs before such a retry,
 * to warn that the aborted request may still be billed. Every provider call with a timeout uses it.
 */
export function retryTimeoutsOnce(retry: RetryOptions = {}, onTimeoutRetry?: (err: unknown) => void): RetryOptions {
  let timeouts = 0;
  const veto = retry.shouldRetry;
  return {
    ...retry,
    shouldRetry: (err, attempt) => {
      if (veto?.(err, attempt) === false) return false;
      if (!isTimeout(err)) return true;
      if (++timeouts > TIMEOUT_RETRIES) return false;
      onTimeoutRetry?.(err);
      return true;
    },
  };
}

/**
 * Wraps one attempt so `onTimeout` runs when it times out after sending, then rethrows. The service may still bill
 * such a request, so providers report it as usage (`timedOut`) and the run's cost counts it.
 */
export function reportTimeouts<T>(fn: () => Promise<T>, onTimeout: (err: unknown) => void): () => Promise<T> {
  return async () => {
    try {
      return await fn();
    } catch (err) {
      if (isTimeout(err)) onTimeout(err);
      throw err;
    }
  };
}

/**
 * Runs one fetch-based attempt under a deadline of `ms` that also covers reading the body (unlike
 * AbortSignal.timeout around fetch), and whose timer tests can fake. `extend()` restarts the clock, for an idle
 * timeout on a stream. Any failure after the deadline becomes `timeoutError(ms)`.
 */
export async function withDeadline<T>(ms: number, fn: (signal: AbortSignal, extend: () => void) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const extend = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(timeoutError(ms)), ms);
  };
  extend();
  try {
    return await fn(ctrl.signal, extend);
  } catch (err) {
    throw ctrl.signal.aborted && !isTimeout(err) ? Object.assign(timeoutError(ms), { cause: err }) : err;
  } finally {
    clearTimeout(timer);
  }
}

/** Network-level failure at any depth of the `cause` chain (fetch failed → undici error → errno). */
function hasNetworkCause(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && cur && typeof cur === 'object'; depth++) {
    const e = cur as ErrLike & { message?: unknown };
    if (typeof e!.code === 'string' && NETWORK_CODES.has(e!.code)) return true;
    if (e!.name === 'TimeoutError') return true;
    if (cur instanceof TypeError && /fetch failed|^terminated$/i.test(String(e!.message))) return true;
    cur = e!.cause;
  }
  return false;
}

/**
 * Retryable: 408/409/429/5xx (not a used-up quota 429, nor 501/505), SDK connection and timeout errors, statusless
 * errors with an overloaded/api/rate-limit type (Anthropic SSE error events), and network failures.
 * `x-should-retry` overrides these rules; a user abort is always final.
 */
export function isRetryable(err: unknown): boolean {
  const e = err as ErrLike;
  if (!e || typeof e !== 'object') return false;
  if (err instanceof OpenAI.APIUserAbortError || err instanceof Anthropic.APIUserAbortError) return false;
  const hint = header(err, 'x-should-retry');
  if (hint === 'false') return false;
  if (hint === 'true') return true;
  if (typeof e.status === 'number') {
    if (e.status === 429) return !isQuotaExhausted(err);
    return e.status === 408 || e.status === 409 || (e.status >= 500 && !PERMANENT_5XX.has(e.status));
  }
  if (err instanceof OpenAI.APIConnectionError || err instanceof Anthropic.APIConnectionError) return true;
  // a second SDK copy in node_modules breaks instanceof, and its errors are all named 'Error': check the class name
  const className = (err as object).constructor?.name;
  if (className === 'APIConnectionError' || className === 'APIConnectionTimeoutError') return true;
  const apiType = e.type ?? e.error?.error?.type;
  if (typeof apiType === 'string' && RETRYABLE_API_TYPES.has(apiType)) return true;
  return hasNetworkCause(err);
}

/**
 * The server-requested wait from `retry-after-ms` or `retry-after` (seconds or HTTP date). For a 429 without them,
 * from the message (Azure OpenAI: "Please retry after 36 seconds").
 */
function retryAfterMs(err: unknown): number | undefined {
  const ms = header(err, 'retry-after-ms');
  if (ms !== undefined && ms.trim() !== '' && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const ra = header(err, 'retry-after');
  if (ra === undefined || ra.trim() === '') return httpStatus(err) === 429 ? messageRetryAfterMs(err) : undefined;
  if (Number.isFinite(Number(ra))) return Math.max(0, Number(ra) * 1000);
  const date = Date.parse(ra);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** "retry after N second(s)" in the error's message, in ms. */
function messageRetryAfterMs(err: unknown): number | undefined {
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message !== 'string') return undefined;
  const m = /\bretry after (\d+(?:\.\d+)?) seconds?\b/i.exec(message);
  return m ? Number(m[1]) * 1000 : undefined;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs `fn`, retrying retryable failures with exponential backoff (1 s, 2 s, 4 s, … capped, ±25 % jitter).
 * A longer Retry-After wins (clamped to 60 s, or `maxMs` if larger).
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const base = opts.baseMs ?? 1000;
  const max = opts.maxMs ?? 30_000;
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err) || opts.shouldRetry?.(err, attempt) === false) throw err;
      const backoff = Math.min(max, base * 2 ** attempt * (0.75 + 0.5 * random()));
      const hint = Math.min(retryAfterMs(err) ?? 0, Math.max(RETRY_AFTER_CLAMP_MS, max));
      const delay = Math.max(backoff, hint);
      opts.onRetry?.(attempt + 1, err, delay);
      await sleep(delay);
    }
  }
}
