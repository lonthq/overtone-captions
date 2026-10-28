import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { STAGES, type Stage } from './config.js';
import type { LlmProvider, LlmRequest, TextOptions, TextProvider, TimingOptions, TimingProvider, TimingResult } from './providers/types.js';
import { writeFileViaTemp } from './util/temp-file.js';

/** SHA-256 of a file's bytes (streamed), hex. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** JSON with sorted object keys, so equal values serialize the same. Plain JSON data only (no Date/Map/Set/toJSON, no sparse arrays). */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Short SHA-256 of a value's stable JSON: a cache key. */
export function hashJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

interface Entry<T> { stage: Stage; key: string; createdAt: string; data: T }

/** May a cached result from this stage be used under --no-cache and --from-stage? */
function cacheAllows(opts: { useCache: boolean; fromStage?: Stage }, stage: Stage): boolean {
  if (!opts.useCache) return false;
  return opts.fromStage === undefined || STAGES.indexOf(stage) < STAGES.indexOf(opts.fromStage);
}

/**
 * Per-media stage cache: `<root>/<mediaHash>/<stage>.json`, reused when the key (hash of the stage's inputs) matches
 * and the stage comes before `--from-stage`. Only the extract stage uses it; provider calls have the RequestCache.
 */
export class StageCache {
  readonly dir: string;

  constructor(root: string, mediaHash: string, private readonly opts: { useCache: boolean; fromStage?: Stage }) {
    this.dir = join(root, mediaHash.slice(0, 16));
  }

  /** May this stage come from the cache under the current flags? */
  allows(stage: Stage): boolean {
    return cacheAllows(this.opts, stage);
  }

  async read<T>(stage: Stage, key: string): Promise<T | undefined> {
    if (!this.allows(stage)) return undefined;
    try {
      const entry = JSON.parse(await readFile(join(this.dir, `${stage}.json`), 'utf8')) as Entry<T>;
      return entry.key === key ? entry.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Drop a stage's entry (before re-running a stage whose files are overwritten in place). */
  async remove(stage: Stage): Promise<void> {
    await rm(join(this.dir, `${stage}.json`), { force: true });
  }

  async write<T>(stage: Stage, key: string, data: T): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entry: Entry<T> = { stage, key, createdAt: new Date().toISOString(), data };
    // via a temporary file, so readers never see a half-written entry
    await writeFileViaTemp(join(this.dir, `${stage}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  }
}

/**
 * Version of the request cache's entries. Bump it when every provider's answers change shape; one provider changes its
 * own keys with `settings` (e.g. `{ format: 2 }`). The cache holds the provider's mapped answer, so a fix to that
 * mapping reaches cached media only with such a bump.
 */
export const REQUEST_CACHE_VERSION = 1;

export type RequestRole = 'text' | 'timing' | 'llm';

/**
 * `answerErrors`: error names that are the provider's answer, not a failure (Scribe hearing no plausible transcript in
 * music). They are cached and thrown again on a hit; other errors are never cached.
 */
export interface RequestOptions {
  answerErrors?: readonly string[];
  /**
   * Key and file the request under this name instead of its role, so text and timing share one answer (set for
   * providers with `sameRequestForTextAndTiming`).
   */
  keyAs?: string;
}

/** Key name of speech requests shared by the text and timing roles. */
export const SHARED_SPEECH_KEY = 'speech';

interface RequestEntry<T> {
  version: number;
  role: RequestRole;
  provider: string;
  /** The stage that sent it, for `--from-stage`. */
  stage: Stage;
  createdAt: string;
  /** What the key was built from (the audio as its SHA-256). */
  request: Record<string, unknown>;
  response?: T;
  error?: { name: string; message: string };
}

/** Requests of this run: sent, or answered from the cache. */
export interface RequestCounts { sent: number; cached: number }

/**
 * The provider request cache: `<media folder>/requests/<role>-<key>.json`, one file per paid or slow call. The key
 * hashes exactly what the provider gets: its id, `settings`, the audio's SHA-256 and the request options (for the LLM:
 * prompts, schema, schema name, effort), plus REQUEST_CACHE_VERSION. Everything after the call (alignment, checks,
 * cutting) runs again from the cached answers, so changing it never repeats a paid request.
 *
 * Answers are reused when the cache is on and the stage comes before `--from-stage`, and written either way.
 * Identical requests in flight are sent once. A file's mtime is its last use, so tools (bench/run.mjs) can find the
 * last run's answers.
 */
export class RequestCache {
  readonly dir: string;
  readonly counts: RequestCounts = { sent: 0, cached: 0 };
  private readonly inflight = new Map<string, Promise<{ data: unknown; cached: boolean }>>();
  private readonly hashes = new Map<string, Promise<string>>();

  constructor(
    mediaDir: string,
    private readonly opts: {
      useCache: boolean;
      fromStage?: Stage;
      onHit?: (role: RequestRole, provider: string) => void;
      /** An answer could not be written (full disk, no permission): the run goes on, uncached. */
      onWriteError?: (file: string, err: unknown) => void;
    },
  ) {
    this.dir = join(mediaDir, 'requests');
  }

  /** May a request sent in this stage be answered from the cache under the current flags? */
  allows(stage: Stage): boolean {
    return cacheAllows(this.opts, stage);
  }

  /**
   * SHA-256 of an audio file's bytes, computed once per file version (path, size and modification time) in a run.
   * A file that cannot be read is keyed by its name (test doubles that never read the audio); a real provider call
   * with it fails and is not cached.
   */
  async audio(path: string): Promise<string> {
    const s = await stat(path).catch(() => undefined);
    if (!s?.isFile()) return `unreadable:${basename(path)}`;
    const id = `${path}\0${s.size}\0${s.mtimeMs}`;
    let hash = this.hashes.get(id);
    if (!hash) {
      hash = hashFile(path);
      this.hashes.set(id, hash);
    }
    return hash;
  }

  /** The answer to `request` from the cache, or `call()`'s answer (then cached). */
  async run<T>(stage: Stage, role: RequestRole, provider: string, request: Record<string, unknown>, call: () => Promise<T>, opts: RequestOptions = {}): Promise<T> {
    const keyRole = opts.keyAs ?? role;
    const key = hashJson({ version: REQUEST_CACHE_VERSION, role: keyRole, provider, request });
    const file = join(this.dir, `${keyRole}-${key}.json`);
    const reuse = this.allows(stage);
    const pending = reuse ? this.inflight.get(key) : undefined;
    if (pending) {
      const { data } = await pending;
      this.hit(role, provider);
      return structuredClone(data) as T;
    }
    const task = (async (): Promise<{ data: unknown; cached: boolean }> => {
      if (reuse) {
        const entry = await readEntry<T>(file);
        if (entry?.error) throw answerError(entry.error);
        if (entry && entry.response !== undefined) {
          const now = new Date();
          await utimes(file, now, now).catch(() => undefined);
          return { data: entry.response, cached: true };
        }
      }
      this.counts.sent++;
      const base = { version: REQUEST_CACHE_VERSION, role, provider, stage, createdAt: new Date().toISOString(), request };
      let data: T;
      try {
        data = await call();
      } catch (err) {
        const name = (err as Error | undefined)?.name;
        if (name && opts.answerErrors?.includes(name)) await this.write(file, { ...base, error: { name, message: (err as Error).message } });
        throw err;
      }
      await this.write(file, { ...base, response: data });
      return { data, cached: false };
    })();
    if (reuse) this.inflight.set(key, task);
    try {
      const { data, cached } = await task;
      if (cached) this.hit(role, provider);
      return data as T;
    } finally {
      if (this.inflight.get(key) === task) this.inflight.delete(key);
    }
  }

  /** Writes an answer; a failure never costs the answer itself (the provider was paid for it). */
  private async write(file: string, entry: RequestEntry<unknown>): Promise<void> {
    try {
      await writeEntry(this.dir, file, entry);
    } catch (err) {
      this.opts.onWriteError?.(file, err);
    }
  }

  private hit(role: RequestRole, provider: string): void {
    this.counts.cached++;
    this.opts.onHit?.(role, provider);
  }
}

function answerError(e: { name: string; message: string }): Error {
  const err = new Error(e.message);
  err.name = e.name;
  return err;
}

async function readEntry<T>(file: string): Promise<RequestEntry<T> | undefined> {
  try {
    const entry = JSON.parse(await readFile(file, 'utf8')) as RequestEntry<T> | null;
    return entry && entry.version === REQUEST_CACHE_VERSION ? entry : undefined;
  } catch {
    return undefined;
  }
}

async function writeEntry(dir: string, file: string, entry: RequestEntry<unknown>): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFileViaTemp(file, `${JSON.stringify(entry, null, 2)}\n`);
}

/** Left out when empty, so an absent option and an undefined one share a key. */
const settingsOf = (p: { settings?: Record<string, unknown> }) => (p.settings && Object.keys(p.settings).length > 0 ? { settings: p.settings } : {});

/**
 * How a speech request is keyed: by its options, or by what the provider sends (CacheTraits.cacheInputs), under one
 * name for both roles when they send the same request.
 */
function speechKey(p: TextProvider | TimingProvider, role: 'text' | 'timing', o: TextOptions | TimingOptions, all: Record<string, unknown>, opts: RequestOptions): { fields: Record<string, unknown>; opts: RequestOptions } {
  if (!p.cacheInputs) return { fields: all, opts };
  return { fields: p.cacheInputs(role, o), opts: p.sameRequestForTextAndTiming ? { ...opts, keyAs: SHARED_SPEECH_KEY } : opts };
}

/** A text provider answered from the request cache when the same audio and options were sent before. */
export function cachedText(p: TextProvider, cache: RequestCache, stage: Stage, opts: RequestOptions = {}): TextProvider {
  if (p.uncached) return p;
  return {
    id: p.id,
    ...(p.input ? { input: p.input } : {}),
    ...settingsOf(p),
    transcribe: async (audio, o) => {
      const key = speechKey(p, 'text', o, { language: o.language, languages: o.languages, prompt: o.prompt, keywords: o.keywords }, opts);
      return cache.run(stage, 'text', p.id, {
        ...settingsOf(p),
        audio: await cache.audio(audio.path),
        ...key.fields,
      }, () => p.transcribe(audio, o), key.opts);
    },
  };
}

/** A timing provider answered from the request cache when the same audio and options were sent before. */
export function cachedTiming(p: TimingProvider, cache: RequestCache, stage: Stage, opts: RequestOptions = {}): TimingProvider {
  if (p.uncached) return p;
  return {
    id: p.id,
    ...settingsOf(p),
    align: async (audio, o) => {
      const key = speechKey(p, 'timing', o, { language: o.language, languages: o.languages, phrases: o.phrases }, opts);
      const res = await cache.run(stage, 'timing', p.id, {
        ...settingsOf(p),
        audio: await cache.audio(audio.path),
        ...key.fields,
      }, () => p.align(audio, o), key.opts);
      // an answer shared with the text role carries the text; the timing role drops it
      if (!p.sameRequestForTextAndTiming) return res;
      const { text: _text, ...timing } = res as TimingResult & { text?: string };
      return timing;
    },
  };
}

/**
 * An LLM answered from the request cache when the same request was sent before (`name` only labels it). The
 * prompt-cache warm-up applies only once this stage actually sent a request.
 */
export function cachedLlm(p: LlmProvider, cache: RequestCache, stage: Stage): LlmProvider {
  if (p.uncached) return p;
  let sent = false;
  return {
    id: p.id,
    ...settingsOf(p),
    get cacheWarmupMs() {
      return sent ? p.cacheWarmupMs : 0;
    },
    complete: <T>(req: LlmRequest) => cache.run<T>(stage, 'llm', p.id, {
      ...settingsOf(p),
      system: req.system, user: req.user, schema: req.schema, schemaName: req.schemaName ?? req.name, effort: req.effort,
    }, () => {
      sent = true;
      return p.complete<T>(req);
    }),
  };
}
