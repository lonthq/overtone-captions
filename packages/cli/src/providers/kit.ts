/**
 * The provider contract. A provider is one module exporting a `ProviderDescriptor`, listed in `registry.ts`. Start
 * from `_template.ts`.
 *
 * Roles:
 * - `text`:   audio → the best possible transcript (no times needed);
 * - `timing`: 16 kHz WAV → timed words with speaker ids (S1, S2, …);
 * - `llm`:    system + user prompt and a JSON schema → a matching JSON value.
 *
 * Guide: docs/contributing/providers.md (humans), docs/contributing/providers.agents.md (agents).
 */
import { createHash } from 'node:crypto';
import { UserError } from '../errors.js';
import type { Logger } from '../log.js';
import { describeNetworkFailure, HttpError, isTimeout, networkFailure, type RetryOptions } from '../util/retry.js';
import type { AnthropicLike } from './anthropic.js';
import type { OpenAILike } from './openai.js';
import type { LlmProvider, TextProvider, TimingProvider } from './types.js';

export type Role = 'text' | 'timing' | 'llm';
export const ROLES: readonly Role[] = ['text', 'timing', 'llm'];

/** An environment variable a provider reads, named `<PROVIDER>_<THING>` (OPENAI_API_KEY). */
export interface EnvVar {
  name: string;
  /** One line for `overtone providers` and the docs, with an example value. */
  description: string;
  /** A missing required variable stops the run before any work (default false). */
  required?: boolean;
  /** Not required when this variable is set (a region, when an endpoint is). */
  waivedBy?: string;
  /** A key or token: redacted from every error message. */
  secret?: boolean;
}

/** Usage of one call. Leave out what the service does not report. */
export interface Usage {
  /** Audio seconds sent, from the audio piece, not the bill. */
  audioSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Of inputTokens: read from the prompt cache. */
  cachedInputTokens?: number;
  /** Of outputTokens: reasoning ("thinking") tokens. */
  reasoningTokens?: number;
  /**
   * Timed out after sending (`isTimeout`): no answer, but the service may still bill it. Report with the audio
   * seconds sent (tokens are unknown).
   */
  timedOut?: boolean;
}
export type UsageCallback = (usage: Usage) => void;
/** Usage tagged with provider id and role, as the pipeline receives it. */
export interface UsageReport extends Usage { id: string; role: Role }

/** Test injection points (fake SDK clients, fetch). Real runs pass none. */
export interface ProviderDeps {
  openai?: (env: NodeJS.ProcessEnv) => OpenAILike;
  azureOpenai?: (env: NodeJS.ProcessEnv, deployment: string, role: 'text' | 'llm') => OpenAILike;
  anthropic?: (env: NodeJS.ProcessEnv) => AnthropicLike;
  /** For fetch-based providers and SDK clients that accept one. */
  fetch?: typeof fetch;
  retry?: RetryOptions;
}

/** What `create` gets besides env and model. */
export interface CreateDeps extends ProviderDeps {
  role: Role;
  /** `provider:model`; use as the instance's `id`. */
  id: string;
  /** Resolve relative paths in the model part against this. */
  cwd: string;
  log?: Logger;
  /** Report usage after each successful call (never part of a cache key). */
  usage?: UsageCallback;
}

/** Same as `create`'s, before any extraction or API call. */
export type PreflightDeps = CreateDeps;

export type AnyProvider = TextProvider | TimingProvider | LlmProvider;

export interface ProviderDescriptor {
  /** Lowercase id for selections (`--llm <id>:<model>`): letters, digits, '-'. */
  id: string;
  /** One line for `overtone providers`. */
  description: string;
  roles: readonly Role[];
  env: readonly EnvVar[];
  /** Per-role model when the selection has none. A role without a default needs a model part. */
  defaults: Partial<Record<Role, string>>;
  /** What the model part means, for errors ("the deployment name, e.g. azure-openai:my-gpt"). */
  modelHint?: string;
  /** Checks and normalizes the model part (after defaults); throws a UserError if invalid. */
  normalizeModel?(model: string, role: Role): string;
  /**
   * The text role also returns word times, so `--timing same` works: `true` for every model, or the models that do
   * (openai: whisper-1).
   */
  wordTimings?: boolean | readonly string[];
  /** Checks before any work (binaries, model files, local server); throw a UserError with the fix. No paid calls. */
  preflight?(env: NodeJS.ProcessEnv, model: string, deps: PreflightDeps): Promise<void>;
  /** Roles with the same key share one instance (recorded: one per directory). Default: one per role. */
  shareKey?(model: string, deps: CreateDeps): string;
  /**
   * Builds the provider for `deps.role`, implementing `transcribe`, `align` or `complete`. Use `deps.id` as id,
   * `withRetry(…, deps.retry)` for network calls and `deps.usage` for usage.
   */
  create(env: NodeJS.ProcessEnv, model: string, deps: CreateDeps): AnyProvider;
}

/**
 * Per-attempt LLM timeout: a non-streamed answer must arrive (OpenAI family), a stream must start (Anthropic) or send
 * its next piece (Ollama) within it. About 4× the slowest healthy request measured (66–75 s, LLM line cutting). Node's
 * fetch gives up after 5 minutes without data anyway. SDK clients get it as `timeout` (their default: 10 minutes).
 */
export const LLM_TIMEOUT_MS = 5 * 60_000;

/** Per-attempt upload timeout: max(minMs, extraMs + msPerAudioSecond × audio seconds). */
export interface AudioTimeoutPolicy {
  minMs: number;
  msPerAudioSecond: number;
  /** Fixed upload and service overhead (default 0). */
  extraMs?: number;
}

/**
 * Per-attempt timeout in ms for `seconds` of audio; an unknown duration gets the minimum. Pair with
 * `retryTimeoutsOnce`: a timed-out upload may have been billed.
 */
export function audioTimeoutMs(seconds: number | undefined, policy: AudioTimeoutPolicy): number {
  const s = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  return Math.max(policy.minMs, Math.round(s * policy.msPerAudioSecond) + (policy.extraMs ?? 0));
}

/** Does `d`'s text role with `model` return word times (`--timing same`)? */
export function hasWordTimings(d: ProviderDescriptor | undefined, model: string | undefined): boolean {
  if (!d?.wordTimings) return false;
  return d.wordTimings === true || (model !== undefined && d.wordTimings.includes(model));
}

/** Merges `settings` into the provider's CacheTraits.settings (part of every cache key); drops undefined values. */
export function withSettings<P extends AnyProvider>(provider: P, settings: Record<string, unknown>): P {
  const merged = Object.fromEntries(Object.entries({ ...provider.settings, ...settings }).filter(([, v]) => v !== undefined));
  if (Object.keys(merged).length === 0) return provider;
  Object.defineProperty(provider, 'settings', { value: merged, enumerable: true, configurable: true });
  return provider;
}

/**
 * A server address fingerprint for `settings`: another server may serve another model under the same name. The
 * address itself is not stored (it may hold credentials).
 */
export function serverTag(url: string | undefined): string | undefined {
  const u = url?.trim();
  return u ? createHash('sha256').update(u).digest('hex').slice(0, 12) : undefined;
}

/** Identity helper that type-checks a descriptor. */
export function defineProvider(d: ProviderDescriptor): ProviderDescriptor {
  return d;
}

// ---- environment variables: every provider reads them through these helpers, so the rules are the same everywhere

/** Flag values, any case. Anything else is a UserError. */
export const FLAG_VALUES = { true: ['1', 'true', 'yes', 'on'], false: ['0', 'false', 'no', 'off'] } as const;

/** Trimmed value; unset, empty and blank give undefined. */
export function envString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}

/** FLAG_VALUES (any case) as a boolean; undefined otherwise. */
export function flagValue(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase() ?? '';
  if ((FLAG_VALUES.true as readonly string[]).includes(v)) return true;
  if ((FLAG_VALUES.false as readonly string[]).includes(v)) return false;
  return undefined;
}

/** A flag variable (FLAG_VALUES); `fallback` when unset, UserError for other values. */
export function envFlag(env: NodeJS.ProcessEnv, name: string, fallback = false): boolean {
  const raw = envString(env, name);
  if (raw === undefined) return fallback;
  const v = flagValue(raw);
  if (v === undefined) throw new UserError(`${name} must be one of ${[...FLAG_VALUES.true, ...FLAG_VALUES.false].join(', ')} (got "${raw}").`);
  return v;
}

export interface EnvNumberOptions {
  /** Whole numbers only. */
  integer?: boolean;
  /** Minimum, inclusive. */
  min?: number;
  /** Minimum, exclusive. */
  above?: number;
  /** For the error: "a number of <unit>". */
  unit?: string;
}

/** Undefined when unset; a non-number or out-of-range value is a UserError. */
export function envNumber(env: NodeJS.ProcessEnv, name: string, opts: EnvNumberOptions = {}): number | undefined {
  const raw = envString(env, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  const ok = Number.isFinite(n) && (!opts.integer || Number.isInteger(n)) && (opts.min === undefined || n >= opts.min) && (opts.above === undefined || n > opts.above);
  if (ok) return n;
  const what = opts.integer ? 'an integer' : `a number${opts.unit ? ` of ${opts.unit}` : ''}`;
  const limits = [opts.min !== undefined ? `of at least ${opts.min}` : '', opts.above !== undefined ? `above ${opts.above}` : ''].filter(Boolean).join(' and ');
  throw new UserError(`${name} must be ${what}${limits ? ` ${limits}` : ''} (got "${raw}").`);
}

/** An integer of at least `min` (default 1); undefined when unset, else a UserError. */
export function envInt(env: NodeJS.ProcessEnv, name: string, min = 1): number | undefined {
  return envNumber(env, name, { integer: true, min });
}

/** One of `values`, any case (returns the listed spelling); undefined when unset, else a UserError. */
export function envEnum<T extends string>(env: NodeJS.ProcessEnv, name: string, values: readonly T[]): T | undefined {
  const raw = envString(env, name);
  if (raw === undefined) return undefined;
  const hit = values.find((v) => v.toLowerCase() === raw.toLowerCase());
  if (hit === undefined) throw new UserError(`${name} must be one of ${values.join(', ')} (got "${raw}").`);
  return hit;
}

/** Strips credentials for display (http://user:token@host → http://host). Print env server addresses only through this. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = '';
    u.password = '';
    return u.href.endsWith('/') && !url.endsWith('/') ? u.href.slice(0, -1) : u.href;
  } catch {
    // not a URL: drop everything up to an "@" after the scheme
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
  }
}

// ---- secrets

/** Shorter secrets are not redacted: tiny test values ("k") would mangle every message. */
export const MIN_SECRET_LENGTH = 8;

/**
 * Set values of the secret variables, plus any password in an endpoint variable (raw and decoded; createRaw refuses
 * such URLs, this is the safety net). Only values of at least MIN_SECRET_LENGTH.
 */
export function secretValues(d: ProviderDescriptor, env: NodeJS.ProcessEnv): string[] {
  const passwords = endpointVars(d).flatMap((name) => {
    const password = urlOf(env[name])?.password ?? '';
    return password ? [password, safeDecode(password)] : [];
  });
  const values = [...d.env.filter((v) => v.secret).map((v) => env[v.name]?.trim() ?? ''), ...passwords];
  return [...new Set(values)].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

/**
 * Endpoint variables with credentials ("https://user:token@host"). Node's fetch refuses such a URL and repeats it,
 * password included, in its error.
 */
export function credentialedEndpointVars(d: ProviderDescriptor, env: NodeJS.ProcessEnv): string[] {
  return endpointVars(d).filter((name) => {
    const u = urlOf(env[name]);
    return u !== undefined && (u.username !== '' || u.password !== '');
  });
}

function urlOf(value: string | undefined): URL | undefined {
  try {
    return value?.trim() ? new URL(value.trim()) : undefined;
  } catch {
    return undefined;
  }
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Max characters of a service's error body in an HttpError message. */
export const HTTP_ERROR_CHARS = 500;

/**
 * The HttpError for a failed response: redacts the body, takes the service's message with `extract` (default: the
 * whole body), then cuts to HTTP_ERROR_CHARS, so no key straddles the cut. Keeps status and headers for the retry
 * logic. Use: `if (!res.ok) throw await httpErrorFrom(res, 'Deepgram', [cfg.key])`.
 */
export async function httpErrorFrom(
  res: Response,
  label: string,
  secrets: readonly (string | undefined)[],
  extract?: (body: string) => string | undefined,
): Promise<HttpError> {
  const keep = secrets.map((s) => s?.trim() ?? '').filter((s) => s.length >= MIN_SECRET_LENGTH);
  const body = redact(await res.text().catch(() => ''), keep);
  let message = body;
  if (extract) {
    try {
      message = extract(body) ?? body;
    } catch {
      // keep the body
    }
  }
  return new HttpError(res.status, `${label} returned HTTP ${res.status}: ${message.slice(0, HTTP_ERROR_CHARS)}`, res.headers);
}

/** For `httpErrorFrom`: a JSON body's `error` (`"…"` or `{ "message": "…" }`). */
export function jsonErrorField(body: string): string | undefined {
  const e = (JSON.parse(body) as { error?: unknown } | null)?.error;
  if (typeof e === 'string') return e;
  const m = (e as { message?: unknown } | null | undefined)?.message;
  return typeof m === 'string' ? m : undefined;
}

/** Replaces every secret in `text` with "[redacted]". */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join('[redacted]');
  return out;
}

/** How deep `redactError` follows `cause` and AggregateError `errors`. */
const REDACT_DEPTH = 8;

/** A redacted copy of an immutable error: same name, status and code; `cause` if given. */
function redactedCopy(err: unknown, secrets: readonly string[], cause?: unknown): unknown {
  if (!err || typeof err !== 'object') return typeof err === 'string' ? redact(err, secrets) : err;
  const e = err as { message?: unknown; name?: unknown; status?: unknown; code?: unknown };
  let message: string;
  try {
    message = typeof e.message === 'string' ? e.message : String(err);
  } catch {
    message = 'error';
  }
  const copy = new Error(redact(message, secrets), cause === undefined ? undefined : { cause }) as Error & { status?: number; code?: string };
  try {
    if (typeof e.name === 'string') copy.name = e.name;
    if (typeof e.status === 'number') copy.status = e.status;
    if (typeof e.code === 'string') copy.code = e.code;
  } catch {
    // keep the plain copy
  }
  return copy;
}

/**
 * Redacts secrets in place from an error's message and stack (keeping class, status and headers for retries) and from
 * its `cause` chain and AggregateError `errors`, since the CLI prints causes. An immutable error is replaced by a
 * redacted copy.
 */
export function redactError(err: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return err;
  const seen = new Set<object>();
  const visit = (cur: unknown, depth: number): unknown => {
    if (typeof cur === 'string') return redact(cur, secrets);
    if (!cur || typeof cur !== 'object') return cur;
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const e = cur as { message?: unknown; stack?: unknown; cause?: unknown; errors?: unknown };
    try {
      if (typeof e.message === 'string') {
        const m = redact(e.message, secrets);
        if (m !== e.message) e.message = m;
        if (e.message !== m) throw new Error('read-only message');
      }
      if (typeof e.stack === 'string') {
        const s = redact(e.stack, secrets);
        if (s !== e.stack) e.stack = s;
        if (e.stack !== s) throw new Error('read-only stack');
      }
    } catch {
      // frozen or getter-only: replace it
      return redactedCopy(cur, secrets);
    }
    if (depth >= REDACT_DEPTH) {
      // too deep: drop the rest rather than print it unredacted
      try {
        if (e.cause !== undefined) e.cause = undefined;
      } catch {
        return redactedCopy(cur, secrets);
      }
      return cur;
    }
    if (e.cause !== undefined) {
      const c = visit(e.cause, depth + 1);
      if (c !== e.cause) {
        try {
          e.cause = c;
          if (e.cause !== c) throw new Error('read-only cause');
        } catch {
          return redactedCopy(cur, secrets, c);
        }
      }
    }
    if (Array.isArray(e.errors)) {
      const list = e.errors as unknown[];
      for (let i = 0; i < list.length; i++) {
        const sub = visit(list[i], depth + 1);
        if (sub === list[i]) continue;
        try {
          list[i] = sub;
          if (list[i] !== sub) throw new Error('read-only errors');
        } catch {
          return redactedCopy(cur, secrets);
        }
      }
    }
    return cur;
  };
  return visit(err, 0);
}

// ---- network failures

/** Variables that locate the service (region, endpoint, host, URL), for error hints. */
export function endpointVars(d: ProviderDescriptor): string[] {
  return d.env.filter((v) => !v.secret && /(REGION|ENDPOINT|HOST|URL)$/.test(v.name)).map((v) => v.name);
}

/** Codes where the address itself is the likely mistake. */
const CHECK_ADDRESS_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH']);

/**
 * "fetch failed" and the SDKs' "Connection error." hide the cause. Appends code, host and a hint from the `cause`
 * chain to the message in place ("fetch failed (ENOTFOUND <host>: the host name does not resolve; check
 * AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT)"), keeping class, `cause` and stack. Timeouts and non-network errors
 * pass through.
 */
export function explainNetworkError(err: unknown, vars: readonly string[] = []): unknown {
  if (!err || typeof err !== 'object' || isTimeout(err)) return err;
  const failure = networkFailure(err);
  const what = describeNetworkFailure(err);
  if (!failure || !what) return err;
  const e = err as { message?: unknown };
  const message = typeof e.message === 'string' ? e.message : String(err);
  if (message.includes(failure.code)) return err; // already says it
  const hint = CHECK_ADDRESS_CODES.has(failure.code) && vars.length > 0 ? `; check ${vars.join(' or ')}` : '';
  const explained = `${message} (${what}${hint})`;
  try {
    e.message = explained;
    if (e.message === explained) return err;
  } catch {
    // frozen or getter-only: wrap it below
  }
  return new Error(explained, { cause: err });
}

const METHOD: Record<Role, 'transcribe' | 'align' | 'complete'> = { text: 'transcribe', timing: 'align', llm: 'complete' };

/** Wraps a provider so its errors are redacted and explained (`explainNetworkError`). Keeps `id` and `input`. */
export function withRedaction<P extends AnyProvider>(provider: P, role: Role, secrets: readonly string[], vars: readonly string[] = []): P {
  // nothing to add for providers without secrets or address variables (whisper.cpp, recorded)
  if (secrets.length === 0 && vars.length === 0) return provider;
  const method = METHOD[role];
  const inner = (provider as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[method]!;
  const wrapped = Object.create(provider) as Record<string, unknown>;
  wrapped[method] = async (...args: unknown[]) => {
    try {
      return await inner.apply(provider, args);
    } catch (err) {
      throw redactError(explainNetworkError(err, vars), secrets);
    }
  };
  return wrapped as unknown as P;
}

/** Rounds to 3 decimals: times in seconds (stored as ms) and confidences. */
export const round3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Minimum word length (s), so a zero-length word still has start < end. */
export const MIN_WORD_SECONDS = 0.01;

/** `{ inputTokens, outputTokens }` with only finite numbers. */
export function tokenUsage(input: unknown, output: unknown): { inputTokens?: number; outputTokens?: number } {
  return {
    ...(typeof input === 'number' && Number.isFinite(input) ? { inputTokens: input } : {}),
    ...(typeof output === 'number' && Number.isFinite(output) ? { outputTokens: output } : {}),
  };
}

/** Audio upload media types by extension. */
export const AUDIO_MIME_TYPES: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

/** Whisper keeps at most 224 prompt tokens (whisper-1, whisper.cpp): about this many characters. */
export const WHISPER_PROMPT_CHARS = 600;

/** Maps a service's speaker keys to "S1", "S2", … by first appearance; pass keys in time order. */
export function speakerNumbering<K>(): (key: K) => string {
  const ids = new Map<K, string>();
  return (key) => {
    let id = ids.get(key);
    if (id === undefined) {
      id = `S${ids.size + 1}`;
      ids.set(key, id);
    }
    return id;
  };
}

export function implementsRole(p: unknown, role: Role): boolean {
  return typeof (p as Record<string, unknown> | null)?.[METHOD[role]] === 'function';
}
