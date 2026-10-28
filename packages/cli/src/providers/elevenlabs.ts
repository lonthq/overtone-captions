import { openAsBlob } from 'node:fs';
import { basename, extname } from 'node:path';
import { UserError } from '../errors.js';
import type { Logger } from '../log.js';
import type { TimedWord } from '../types.js';
import { isTimeout, withDeadline, withRetry, type RetryOptions } from '../util/retry.js';
import { AUDIO_MIME_TYPES, audioTimeoutMs, defineProvider, envNumber, envString, httpErrorFrom, MIN_WORD_SECONDS, round3, speakerNumbering, type ProviderDescriptor, type UsageCallback } from './kit.js';
import { fromIso639_3, ISO639_3_TO_1, primaryCode, toIso639_3 } from './lang-codes.js';
import { ImplausibleTranscriptError, type AudioChunk, type AudioFile, type TextOptions, type TextProvider, type TextResult, type TimingOptions, type TimingProvider, type TimingResult } from './types.js';

/** Re-exported from types.ts. */
export { ImplausibleTranscriptError };

/*
 * ElevenLabs Speech to Text (Scribe), batch API. Sources as of 2026-10-17:
 * - https://elevenlabs.io/docs/api-reference/speech-to-text/convert: POST /v1/speech-to-text, header `xi-api-key`,
 *   multipart `model_id`, `file`, `language_code` (ISO 639-1 or 639-3; empty = detect), `diarize`, `num_speakers`
 *   (≤ 32), `timestamps_granularity` (word | character), `tag_audio_events`, `keyterms` (≤ 1000, < 50 characters
 *   and ≤ 5 words each, no < > { } [ ] \); file < 5 GB, ≥ 100 ms. Response: `language_code`,
 *   `language_probability`, `text`, `words[]` with `text`, `type` (word | spacing | audio_event), `start`/`end` in
 *   seconds (nullable), `speaker_id` (nullable), `logprob` (≤ 0).
 * - https://elevenlabs.io/docs/capabilities/speech-to-text: up to 10 hours per file (Overtone stops at 2), 90+
 *   languages, up to 32 speakers; files over 8 minutes are transcribed in parallel.
 * - https://elevenlabs.io/docs/api-reference/speech-to-text/get: GET /v1/speech-to-text/transcripts/{id} returns
 *   the POST's body.
 * - https://elevenlabs.io/docs/overview/models: `scribe_v2` is current; `scribe_v1` is deprecated.
 * Live behavior beyond the docs: `language_code` comes back as ISO 639-3 ("eng") even for "en"; `keyterms` is a
 * repeated multipart field (a JSON array in one field is one term, rejected); validation errors are HTTP 400 (docs:
 * 422) with `{ detail: { type, code, message, status, param } }`; a bad key is 401 with the same shape.
 */

export const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
export const DEFAULT_MODEL = 'scribe_v2';
/** Keyterm limits from the API reference. */
export const MAX_KEYTERMS = 1000;
const MAX_KEYTERM_CHARS = 49;
const MAX_KEYTERM_WORDS = 5;
const KEYTERM_FORBIDDEN = /[<>{}[\]\\]/;
/**
 * Request timing. Healthy calls take about 15–40 ms per audio second, upload included (measured 2026-10-17), but at
 * times about half the requests stall for 1–7 minutes, far below the concurrency limit; a repeat is then fine.
 *
 * A request is never sent twice: ElevenLabs finishes and bills a request the client aborted (as of 2026-10-26). Its
 * job API needs a workspace webhook (else HTTP 400 `no_webhooks_configured`), which a CLI cannot receive. So after
 * LOOKUP_AFTER (0.2 s per audio second, ~8× healthy, at least 60 s) the provider also polls the workspace's
 * transcript list every LOOKUP_INTERVAL_MS (findTranscript) and takes whichever arrives first. It gives up after
 * GIVE_UP_AFTER (1 s per audio second, at least 10 minutes) or ELEVENLABS_TIMEOUT_SECONDS.
 */
export const LOOKUP_AFTER = {
  minMs: 60_000,
  msPerAudioSecond: 200,
} as const;
export const GIVE_UP_AFTER = {
  minMs: 600_000,
  msPerAudioSecond: 1000,
} as const;
export const LOOKUP_INTERVAL_MS = 15_000;

/** max(10 min, 1 s per audio second), in ms. */
export function defaultTimeoutMs(seconds: number): number {
  return audioTimeoutMs(seconds, GIVE_UP_AFTER);
}

/** When to start polling the transcript list: max(60 s, 0.2 s per audio second), in ms. */
export function lookupAfterMs(seconds: number): number {
  return audioTimeoutMs(seconds, LOOKUP_AFTER);
}

/** ELEVENLABS_TIMEOUT_SECONDS in ms; undefined when unset, a UserError unless positive. */
export function timeoutFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  const n = envNumber(env, 'ELEVENLABS_TIMEOUT_SECONDS', { above: 0, unit: 'seconds' });
  return n === undefined ? undefined : Math.round(n * 1000);
}

/**
 * Scribe codes without a two-letter equivalent (Cantonese, Filipino, Central Kurdish, …), sent as given (from the API's
 * list for an invalid `language_code`, as of 2026-10-17). The others are in ISO639_1_TO_3.
 */
const ISO3_ONLY = new Set([
  'ast', 'bas', 'bhr', 'ceb', 'ckb', 'cnh', 'dav', 'dyu', 'fil', 'hsb', 'kab', 'kea', 'kln', 'kmr', 'lij', 'ltg',
  'luo', 'mdf', 'mhr', 'mrj', 'myv', 'nan', 'nhi', 'nso', 'quy', 'sah', 'sat', 'skr', 'tig', 'tok', 'umb', 'vot',
  'vro', 'yue', 'zgh', 'zza',
]);

/** The `language_code` for 'nl', 'nl-BE', 'pt_BR', 'yue', …; undefined when Scribe does not list it (it then detects). */
export function toScribeLanguage(language: string | undefined): string | undefined {
  if (!language?.trim()) return undefined;
  const primary = primaryCode(language);
  const iso3 = toIso639_3(primary);
  if (iso3) return iso3;
  if (Object.hasOwn(ISO639_3_TO_1, primary) || ISO3_ONLY.has(primary)) return primary;
  return undefined;
}

/** "eng" → "en"; codes without a two-letter form stay ("yue"). */
export function fromScribeLanguage(code: string | undefined): string | undefined {
  const c = code?.trim().toLowerCase();
  if (!c) return undefined;
  return fromIso639_3(c) ?? (/^[a-z]{2,3}$/.test(c) ? c : undefined);
}

/** Glossary → keyterms: trimmed, deduplicated case-insensitively, within the documented limits; the rest dropped. */
export function keyterms(terms: readonly string[] | undefined): { keep: string[]; dropped: string[] } {
  const keep: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms ?? []) {
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    if (t.length > MAX_KEYTERM_CHARS || t.split(' ').length > MAX_KEYTERM_WORDS || KEYTERM_FORBIDDEN.test(t) || keep.length >= MAX_KEYTERMS) dropped.push(t);
    else keep.push(t);
  }
  return { keep, dropped };
}

/** POST /v1/speech-to-text response (fields we use). */
export interface ScribeResponse {
  transcription_id?: string;
  language_code?: string;
  language_probability?: number;
  text?: string;
  words?: Array<{
    text: string;
    type?: 'word' | 'spacing' | 'audio_event' | string;
    start?: number | null;
    end?: number | null;
    speaker_id?: string | null;
    logprob?: number | null;
  }>;
  audio_duration_secs?: number;
}

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Maps a Scribe response to timed words and text. Only `word` entries become words (`audio_event` is requested off and
 * dropped). A punctuation-only token ("...") joins the previous word (dropped at the start). Words without times are
 * dropped; a zero-length word gets MIN_WORD_SECONDS. Speakers become "S1", "S2", … by first appearance; a word
 * without one keeps the previous speaker. `confidence` is exp(logprob). Text is words and spacings as written,
 * whitespace collapsed.
 */
export function mapScribeResponse(res: ScribeResponse): { text: string; words: TimedWord[]; language?: string } {
  const raw: Array<TimedWord & { key: string }> = [];
  let text = '';
  let lastSpeaker: string | undefined;
  for (const w of res.words ?? []) {
    if (w.type === 'spacing') { text += w.text; continue; }
    if (w.type !== undefined && w.type !== 'word') continue;
    const word = w.text.trim();
    if (!word || typeof w.start !== 'number' || !Number.isFinite(w.start)) { text += w.text; continue; }
    // no letters or digits ("...", "-"): punctuation, joins the previous word without moving its times
    if (!HAS_WORD_CHAR.test(word)) {
      const prev = raw[raw.length - 1];
      if (prev) { prev.text += word; text = text.trimEnd() + word; }
      continue;
    }
    text += w.text;
    const key = w.speaker_id ?? lastSpeaker ?? 'speaker_0';
    lastSpeaker = key;
    const start = round3(Math.max(0, w.start));
    const end = typeof w.end === 'number' && Number.isFinite(w.end) ? round3(w.end) : start;
    const confidence = typeof w.logprob === 'number' && Number.isFinite(w.logprob) ? round3(Math.min(1, Math.max(0, Math.exp(w.logprob)))) : undefined;
    raw.push({ key, text: word, start, end: Math.max(end, round3(start + MIN_WORD_SECONDS)), ...(confidence !== undefined ? { confidence } : {}) });
  }
  // stable sort keeps the service's order for equal starts; speakers are numbered in this order
  raw.sort((a, b) => a.start - b.start);
  const speakerOf = speakerNumbering<string>();
  const words: TimedWord[] = raw.map(({ key, ...w }) => ({ ...w, speaker: speakerOf(key) }));
  const language = fromScribeLanguage(res.language_code);
  return { text: text.replace(/\s+/g, ' ').trim(), words, ...(language ? { language } : {}) };
}

/**
 * Scribe can answer HTTP 200 with garbage: for a clean 3.3-minute clip it once returned 12 random multilingual words
 * ("нада dáng 崎lichem …") at mean confidence 0.007, two of them 108 s and 31 s long; a retry was fine. Calibrated on
 * 18 healthy responses (meetings, audiobook, read Dutch, NASA clips, a film with music): mean word confidence
 * 0.958–0.999, longest word 1.6 s.
 */
export const SCRIBE_SANITY = {
  /** The mean confidence (exp(logprob)) of the words is implausible below this … */
  minMeanConfidence: 0.5,
  /** … when there are at least this many words with a logprob. */
  minWords: 5,
  /** A word longer than this many seconds is implausible … */
  longWordSeconds: 10,
  /** … and words that long covering more than this share of the audio make the answer implausible. */
  maxLongWordShare: 0.25,
} as const;

/**
 * Why a Scribe answer cannot be a transcript (SCRIBE_SANITY), or undefined. Audio length: `audio_duration_secs`, else
 * `sent`.
 */
export function implausibleScribe(res: ScribeResponse, sent: number): string | undefined {
  const seconds = typeof res.audio_duration_secs === 'number' && res.audio_duration_secs > 0 ? res.audio_duration_secs : sent;
  const words = (res.words ?? []).filter((w) => (w.type === undefined || w.type === 'word') && HAS_WORD_CHAR.test(w.text));
  const reasons: string[] = [];
  const probs = words.flatMap((w) => (typeof w.logprob === 'number' && Number.isFinite(w.logprob) ? [Math.exp(Math.min(0, w.logprob))] : []));
  const mean = probs.reduce((a, b) => a + b, 0) / Math.max(1, probs.length);
  if (probs.length >= SCRIBE_SANITY.minWords && mean < SCRIBE_SANITY.minMeanConfidence) reasons.push(`mean word confidence ${mean.toFixed(3)}`);
  const long = words.flatMap((w) => {
    const d = typeof w.start === 'number' && typeof w.end === 'number' ? w.end - w.start : 0;
    return d > SCRIBE_SANITY.longWordSeconds ? [d] : [];
  });
  const share = long.reduce((a, b) => a + b, 0) / Math.max(seconds, 1e-9);
  if (seconds > 0 && share > SCRIBE_SANITY.maxLongWordShare) reasons.push(`${long.length} word${long.length === 1 ? '' : 's'} longer than ${SCRIBE_SANITY.longWordSeconds} s covering ${Math.round(share * 100)}% of the audio`);
  return reasons.length > 0 ? `${words.length} words; ${reasons.join(', ')}` : undefined;
}

export interface ElevenLabsConfig {
  key: string;
  baseUrl: string;
  model: string;
  fetch: typeof fetch;
  retry?: RetryOptions;
  usage?: UsageCallback;
  log?: Logger;
  /** Give-up time in ms (ELEVENLABS_TIMEOUT_SECONDS). Default: defaultTimeoutMs. */
  timeoutMs?: number;
}

/**
 * GET /v1/speech-to-text/transcripts (undocumented; as of 2026-10-26): `{ transcripts: [{ id, created_at }], cursor }`,
 * newest first, 20 per page. Only finished transcripts are listed; `created_at` is about when they finished.
 */
interface TranscriptList {
  transcripts?: Array<{ id?: unknown; created_at?: unknown }>;
}

/** Tolerance when matching a listed transcript's `audio_duration_secs` to the audio sent (5.8940625 vs 5.894063 s). */
const SAME_AUDIO_SECONDS = 0.05;
/** Clock-skew margin: transcripts finished earlier than this before sending are not ours. */
const CLOCK_SLACK_MS = 60_000;

/** Resolves after `ms`; rejects when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', stop, { once: true });
  });
}

/** For httpErrorFrom: `{ detail: { message } }` or `{ detail: "…" }`. */
function errorMessage(body: string): string | undefined {
  const d = (JSON.parse(body) as { detail?: unknown } | null)?.detail as { message?: unknown; status?: unknown } | string | undefined;
  if (typeof d === 'string') return d;
  if (d && typeof d.message === 'string') return typeof d.status === 'string' ? `${d.message} (${d.status})` : d.message;
  return undefined;
}

/**
 * The forced language as a Scribe code. None with several candidates, so Scribe follows language switches (a forced
 * code would transcribe everything as the main language).
 */
export function scribeLanguage(opts: { language?: string; languages?: string[] }): string | undefined {
  return detectsLanguage(opts) ? undefined : toScribeLanguage(opts.language);
}

/** Several candidates: send no code and let Scribe detect. */
const detectsLanguage = (opts: { languages?: string[] }): boolean => (opts.languages?.length ?? 0) > 1;

/** CacheTraits.cacheInputs: language code and keyterms. No prompt is sent; text and timing send the same request. */
export function scribeRequestInputs(role: 'text' | 'timing', opts: TextOptions | TimingOptions): Record<string, unknown> {
  const terms = role === 'text' ? (opts as TextOptions).keywords : (opts as TimingOptions).phrases;
  const { keep } = keyterms(terms);
  return { languageCode: scribeLanguage(opts), ...(keep.length > 0 ? { keyterms: keep } : {}) };
}

export class ElevenLabsProvider implements TextProvider, TimingProvider {
  /** The whole WAV in one call (Scribe takes up to 10 hours), so diarization covers the whole file. */
  readonly input = 'wav' as const;
  /** Cache by what is sent (no prompt), once for both roles. */
  readonly cacheInputs = scribeRequestInputs;
  readonly sameRequestForTextAndTiming = true;
  private warned = new Set<string>();
  /** Transcripts already received or recovered: never the answer to another request. */
  private claimed = new Set<string>();
  /** Audio length of listed transcripts already fetched (each once). */
  private listedSeconds = new Map<string, number | undefined>();
  constructor(readonly id: string, private readonly cfg: ElevenLabsConfig) {}

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.cfg.log?.warn(message);
  }

  /** scribeLanguage, warning when Scribe does not list the forced language. */
  private language(opts: { language?: string; languages?: string[] }): string | undefined {
    const code = scribeLanguage(opts);
    if (!code && opts.language && !detectsLanguage(opts)) this.warnOnce(`ElevenLabs Scribe does not list the language '${opts.language}'; letting it detect the language`);
    return code;
  }

  private async call(path: string, seconds: number, opts: { language?: string; terms?: readonly string[] }): Promise<ScribeResponse> {
    const blob = await openAsBlob(path, { type: AUDIO_MIME_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' });
    const { keep, dropped } = keyterms(opts.terms);
    if (dropped.length > 0) this.warnOnce(`ElevenLabs keyterms: left out ${dropped.length} glossary term(s) over ${MAX_KEYTERM_WORDS} words or ${MAX_KEYTERM_CHARS} characters, with < > { } [ ] \\, or beyond ${MAX_KEYTERMS}`);
    const timeoutMs = this.cfg.timeoutMs ?? defaultTimeoutMs(seconds);
    const lookupMs = Math.min(lookupAfterMs(seconds), timeoutMs);
    const name = basename(path);
    const retry = this.cfg.retry ?? {};
    try {
      // HTTP errors are retried; a timed-out request is never resent (see LOOKUP_AFTER)
      const json = await withRetry(() => withDeadline(timeoutMs, async (signal) => {
        const form = new FormData();
        form.append('model_id', this.cfg.model);
        form.append('file', blob, name);
        if (opts.language) form.append('language_code', opts.language);
        form.append('diarize', 'true');
        form.append('timestamps_granularity', 'word');
        form.append('tag_audio_events', 'false');
        for (const t of keep) form.append('keyterms', t);
        // stops the request when the transcript is found in the list, and the lookup when the answer comes
        const done = new AbortController();
        const sentAt = Date.now();
        try {
          // withDeadline rather than AbortSignal.timeout, so the limit covers reading the body too and tests can fake it
          const answer = (async () => {
            const res = await this.cfg.fetch(`${this.cfg.baseUrl}/v1/speech-to-text`, {
              method: 'POST',
              headers: { 'xi-api-key': this.cfg.key },
              body: form,
              signal: AbortSignal.any([signal, done.signal]),
            });
            if (!res.ok) throw await httpErrorFrom(res, 'ElevenLabs', [this.cfg.key], errorMessage);
            return (await res.json()) as ScribeResponse;
          })();
          const lookup = (async () => {
            await pause(lookupMs, AbortSignal.any([signal, done.signal]));
            this.cfg.log?.info(`ElevenLabs has not answered within ${waitText(lookupMs)} for ${name}; waiting up to ${waitText(timeoutMs)} and looking for the finished transcript meanwhile`);
            for (;;) {
              const found = await this.findTranscript(sentAt, seconds);
              if (found) {
                this.cfg.log?.info(`ElevenLabs: took the finished transcript ${found.transcription_id} of ${name} from the transcript list`);
                return found;
              }
              await pause(LOOKUP_INTERVAL_MS, AbortSignal.any([signal, done.signal]));
            }
          })();
          return await Promise.race([answer, lookup]);
        } finally {
          done.abort();
        }
      }), { ...retry, shouldRetry: (err, attempt) => !isTimeout(err) && retry.shouldRetry?.(err, attempt) !== false });
      if (json.transcription_id) this.claimed.add(json.transcription_id);
      return json;
    } catch (err) {
      if (!isTimeout(err)) throw err;
      // the request may still finish and be billed
      this.cfg.usage?.({ audioSeconds: seconds, timedOut: true });
      throw new Error(`ElevenLabs did not answer within ${waitText(timeoutMs)} for ${name}, and its transcript did not show up in the transcript list. The request may still finish (and be billed) at ElevenLabs. This is usually a slowdown on the service's side: run the command again later, raise ELEVENLABS_TIMEOUT_SECONDS, or use another provider.`, { cause: err });
    }
  }

  /**
   * Finds this request's transcript in the list: listed since `sentAt`, unclaimed, same audio length. Undefined when
   * none yet or on any read failure (a fallback, so failures are not errors). Another client of the workspace sending
   * audio of the same length at the same time could be mistaken for this request.
   */
  private async findTranscript(sentAt: number, seconds: number): Promise<ScribeResponse | undefined> {
    const get = async (path: string): Promise<unknown> => {
      const res = await this.cfg.fetch(`${this.cfg.baseUrl}${path}`, { headers: { 'xi-api-key': this.cfg.key }, signal: AbortSignal.timeout(LOOKUP_INTERVAL_MS) });
      return res.ok ? res.json() : undefined;
    };
    try {
      const list = (await get('/v1/speech-to-text/transcripts')) as TranscriptList | undefined;
      for (const t of list?.transcripts ?? []) {
        if (typeof t.id !== 'string' || typeof t.created_at !== 'string' || this.claimed.has(t.id)) continue;
        if (!(Date.parse(t.created_at) >= sentAt - CLOCK_SLACK_MS)) continue;
        if (this.listedSeconds.has(t.id) && !sameAudio(this.listedSeconds.get(t.id), seconds)) continue;
        const json = (await get(`/v1/speech-to-text/transcripts/${encodeURIComponent(t.id)}`)) as ScribeResponse | undefined;
        if (!json) continue;
        this.listedSeconds.set(t.id, json.audio_duration_secs);
        if (!sameAudio(json.audio_duration_secs, seconds)) continue;
        this.claimed.add(t.id);
        return { ...json, transcription_id: t.id };
      }
    } catch {
      // retried at the next interval; the request is still awaited
    }
    return undefined;
  }

  /** One transcription checked with implausibleScribe: an implausible (still billed) answer is requested once more. */
  private async transcript(path: string, seconds: number, opts: { language?: string; terms?: readonly string[] }): Promise<ScribeResponse> {
    for (let attempt = 1; ; attempt++) {
      const json = await this.call(path, seconds, opts);
      this.cfg.usage?.({ audioSeconds: seconds });
      const problem = implausibleScribe(json, seconds);
      if (!problem) return json;
      if (attempt >= 2) {
        throw new ImplausibleTranscriptError(`ElevenLabs Scribe returned no plausible transcript for ${basename(path)}, twice (${problem}). This is a fault on the service's side: run the command again later, or use another provider.`);
      }
      this.cfg.log?.warn(`ElevenLabs Scribe returned an implausible transcript for ${basename(path)} (${problem}); requesting it once more`);
    }
  }

  /** Scribe takes no prompt: only the glossary is sent, as keyterms. */
  async transcribe(audio: AudioChunk, opts: TextOptions): Promise<TextResult> {
    const seconds = Math.max(0, audio.end - audio.start);
    const json = await this.transcript(audio.path, seconds, { language: this.language(opts), terms: opts.keywords });
    const res = mapScribeResponse(json);
    return { text: res.text, words: res.words, ...(res.language ? { language: res.language } : {}) };
  }

  /** Same request as `transcribe`; the answer also carries the text. */
  async align(audio: AudioFile, opts: TimingOptions): Promise<TimingResult> {
    const json = await this.transcript(audio.path, audio.duration, { language: this.language(opts), terms: opts.phrases });
    const res = mapScribeResponse(json);
    return { words: res.words, ...(res.language ? { language: res.language } : {}), text: res.text };
  }
}

/** `ms` as "60 s" or "10 min". */
function waitText(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return s >= 120 && s % 60 === 0 ? `${s / 60} min` : `${s} s`;
}

/** Within SAME_AUDIO_SECONDS of the audio sent? */
function sameAudio(listed: number | undefined, sent: number): boolean {
  return typeof listed === 'number' && Math.abs(listed - sent) <= SAME_AUDIO_SECONDS;
}

/** Text, word times and diarization in one request per file. */
export const elevenlabsProvider: ProviderDescriptor = defineProvider({
  id: 'elevenlabs',
  description: 'ElevenLabs Speech to Text (Scribe): text, word timings + diarization in one call (--timing same)',
  roles: ['text', 'timing'],
  env: [
    { name: 'ELEVENLABS_API_KEY', description: 'API key (speech-to-text permission is enough)', required: true, secret: true },
    { name: 'ELEVENLABS_BASE_URL', description: `another host, e.g. https://api.eu.residency.elevenlabs.io (default ${ELEVENLABS_BASE_URL})` },
    { name: 'ELEVENLABS_TIMEOUT_SECONDS', description: 'seconds to wait for a request before giving up; it is never sent twice (default: 1 s per audio second, at least 600)' },
  ],
  defaults: { text: DEFAULT_MODEL, timing: DEFAULT_MODEL },
  modelHint: 'a Scribe model id such as scribe_v2',
  wordTimings: true,
  normalizeModel(model) {
    const m = model.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_.-]*$/.test(m)) throw new UserError(`Invalid ElevenLabs model "${model}"; expected a model id such as ${DEFAULT_MODEL}.`);
    return m;
  },
  /** The settings are valid (no network call). */
  async preflight(env) {
    timeoutFromEnv(env);
  },
  create(env, model, deps) {
    const timeoutMs = timeoutFromEnv(env);
    return new ElevenLabsProvider(deps.id, {
      key: envString(env, 'ELEVENLABS_API_KEY')!,
      baseUrl: (envString(env, 'ELEVENLABS_BASE_URL') ?? ELEVENLABS_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/, ''),
      model,
      fetch: deps.fetch ?? fetch,
      retry: deps.retry,
      usage: deps.usage,
      log: deps.log,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    });
  },
});
