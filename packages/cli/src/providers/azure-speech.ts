import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { UserError } from '../errors.js';
import type { TimedWord } from '../types.js';
import { reportTimeouts, retryTimeoutsOnce, withRetry, type RetryOptions } from '../util/retry.js';
import { audioTimeoutMs, defineProvider, envEnum, envString, httpErrorFrom, MIN_WORD_SECONDS, round3, speakerNumbering, type ProviderDescriptor, type UsageCallback } from './kit.js';
import { primaryCode, toLocale } from './lang-codes.js';
import type { AudioFile, TimingOptions, TimingProvider, TimingResult } from './types.js';

/** Azure AI Speech Fast Transcription, GA api-version (verified 2026-10-07). */
export const FAST_TRANSCRIPTION_API_VERSION = '2025-10-15';
/** Diarization upper bound sent to Azure (documented range 2–35). */
export const MAX_SPEAKERS = 10;
/** Minimum per-request timeout: a long file can take several minutes. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Upper bound for the glossary sent as phraseList. */
export const MAX_PHRASES = 2000;

/**
 * `profanityFilterMode`, set with AZURE_SPEECH_PROFANITY. Azure defaults to `Masked` ("f***" → "****"); Overtone to
 * `none`, since captions should be verbatim and a masked word cannot match the text model's word.
 */
export const PROFANITY_MODES = ['none', 'masked', 'removed'] as const;
export type ProfanityMode = (typeof PROFANITY_MODES)[number];
const PROFANITY_API: Record<ProfanityMode, string> = { none: 'None', masked: 'Masked', removed: 'Removed' };

/** AZURE_SPEECH_PROFANITY: none (default), masked or removed, any case; else a user error. */
export function profanityFrom(env: NodeJS.ProcessEnv): ProfanityMode {
  return envEnum(env, 'AZURE_SPEECH_PROFANITY', PROFANITY_MODES) ?? 'none';
}

/** max(10 min, 0.5 s per audio second + 2 min). */
export function defaultTimeoutMs(durationSeconds?: number): number {
  return audioTimeoutMs(durationSeconds, { minMs: DEFAULT_TIMEOUT_MS, msPerAudioSecond: 500, extraMs: 120_000 });
}

/** Trims, drops empties, dedupes case-insensitively (first spelling wins), caps at MAX_PHRASES. */
export function cleanPhrases(phrases: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of phrases ?? []) {
    const p = raw.trim();
    const key = p.toLowerCase();
    if (!p || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= MAX_PHRASES) break;
  }
  return out;
}

/** Response of POST /speechtotext/transcriptions:transcribe (fields we use). */
export interface FastTranscriptionResponse {
  durationMilliseconds?: number;
  combinedPhrases?: Array<{ text: string }>;
  phrases?: Array<{
    speaker?: number;
    offsetMilliseconds: number;
    durationMilliseconds: number;
    text: string;
    locale?: string;
    confidence?: number;
    words?: Array<{ text: string; offsetMilliseconds: number; durationMilliseconds: number }>;
  }>;
}

/** Re-exported from lang-codes.ts. */
export { toLocale };

/**
 * Languages of Azure's multi-lingual model (no `locales`; reports a locale per phrase), per the Fast Transcription
 * docs as of 2026-10-17: de-DE, en-AU, en-CA, en-GB, en-IN, en-US, es-ES, es-MX, fr-CA, fr-FR, it-IT, ja-JP, ko-KR,
 * pt-BR, zh-CN.
 */
export const MULTILINGUAL_LANGUAGES: readonly string[] = ['de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt', 'zh'];

/**
 * Maps a Fast Transcription response to timed words, sorted by start. Azure's speaker numbers (0-based, unordered)
 * become "S1", "S2", … by first appearance; no speaker is "S1". The language is the most frequent phrase locale;
 * `languagesHeard` is phrase time per primary code (locales come in any case).
 */
export function mapFastTranscription(res: FastTranscriptionResponse): TimingResult {
  const phrases = [...(res.phrases ?? [])].sort((a, b) => a.offsetMilliseconds - b.offsetMilliseconds);
  const speakerOf = speakerNumbering<number>();
  const locales = new Map<string, number>();
  const heard = new Map<string, number>();
  const words: TimedWord[] = [];
  for (const p of phrases) {
    const speaker = typeof p.speaker === 'number' ? speakerOf(p.speaker) : 'S1';
    if (p.locale) {
      locales.set(p.locale, (locales.get(p.locale) ?? 0) + 1);
      const code = primaryCode(p.locale);
      heard.set(code, (heard.get(code) ?? 0) + Math.max(0, p.durationMilliseconds || 0));
    }
    for (const w of p.words ?? []) {
      const text = w.text.trim();
      if (!text) continue;
      const start = w.offsetMilliseconds / 1000;
      words.push({
        text,
        start,
        // a word Azure gives no duration still lasts a moment (start < end, as for every provider)
        end: Math.max((w.offsetMilliseconds + w.durationMilliseconds) / 1000, round3(start + MIN_WORD_SECONDS)),
        speaker,
        ...(typeof p.confidence === 'number' ? { confidence: p.confidence } : {}),
      });
    }
  }
  words.sort((a, b) => a.start - b.start);
  const language = [...locales.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const total = [...heard.values()].reduce((a, b) => a + b, 0);
  const languagesHeard = total > 0
    ? Object.fromEntries([...heard.entries()].sort((a, b) => b[1] - a[1]).map(([code, ms]) => [code, Math.round((ms / total) * 100) / 100]))
    : undefined;
  return { words, ...(language ? { language } : {}), ...(languagesHeard ? { languagesHeard } : {}) };
}

export interface AzureSpeechConfig {
  key: string;
  region: string;
  /** Host override, e.g. `https://<name>.cognitiveservices.azure.com`. */
  endpoint?: string;
  fetch?: typeof fetch;
  retry?: RetryOptions;
  /** Per-attempt timeout in ms; default `defaultTimeoutMs`. A timeout is retried at most once. */
  timeoutMs?: number;
  /** Non-fatal notices (e.g. an unknown language code, left for Azure to detect). */
  warn?: (message: string) => void;
  /** Audio seconds of each successful request. */
  usage?: UsageCallback;
  /** Default `none`: words as spoken. */
  profanity?: ProfanityMode;
  /** `deps.id`; default `azure-speech:<mode>`. */
  id?: string;
}

export class AzureSpeechTimingProvider implements TimingProvider {
  readonly id: string;
  /** In the cache key: a masked result is never reused for an unmasked run. */
  readonly settings: Record<string, unknown>;
  constructor(private readonly cfg: AzureSpeechConfig, mode = 'fast') {
    this.id = cfg.id ?? `azure-speech:${mode}`;
    this.settings = { profanity: cfg.profanity ?? 'none' };
  }

  /**
   * The multipart `definition`. No locale means auto-detection (also for a language without a known locale, with a
   * warning). Several candidates: if the multi-lingual model covers all, no `locales` (it switches per phrase); else
   * all as `locales`, from which Azure picks ONE language for the whole file.
   */
  static definition(opts: TimingOptions, warn?: (message: string) => void, profanity?: ProfanityMode): Record<string, unknown> {
    const phrases = cleanPhrases(opts.phrases);
    let locales: string[] = [];
    if (opts.languages && opts.languages.length > 1) {
      if (!opts.languages.every((l) => MULTILINGUAL_LANGUAGES.includes(primaryCode(l)))) {
        for (const l of opts.languages) {
          const locale = toLocale(l);
          if (locale) locales.push(locale);
          else warn?.(`no Azure locale known for '${l}'; leaving it out of the candidate locales`);
        }
        if (locales.length > 1) warn?.(`Azure's multi-lingual model does not cover all of ${opts.languages.join(', ')}; Azure picks one main language from ${locales.join(', ')} for the whole file`);
      }
    } else {
      const locale = opts.language ? toLocale(opts.language) : undefined;
      if (opts.language && !locale) warn?.(`no Azure locale known for '${opts.language}'; letting Azure detect the language`);
      if (locale) locales = [locale];
    }
    return {
      ...(locales.length > 0 ? { locales } : {}),
      diarization: { enabled: true, maxSpeakers: MAX_SPEAKERS },
      ...(phrases.length > 0 ? { phraseList: { phrases } } : {}),
      ...(profanity ? { profanityFilterMode: PROFANITY_API[profanity] } : {}),
    };
  }

  async align(audio: AudioFile, opts: TimingOptions): Promise<TimingResult> {
    const host = (this.cfg.endpoint ?? `https://${this.cfg.region}.api.cognitive.microsoft.com`).replace(/\/+$/, '');
    const url = `${host}/speechtotext/transcriptions:transcribe?api-version=${FAST_TRANSCRIPTION_API_VERSION}`;
    // disk-backed Blob: the WAV (up to ~230 MB) is streamed per attempt, not held in memory
    const blob = await openAsBlob(audio.path, { type: 'audio/wav' });
    const doFetch = this.cfg.fetch ?? fetch;
    const timeoutMs = this.cfg.timeoutMs ?? defaultTimeoutMs(audio.duration);
    const definition = JSON.stringify(AzureSpeechTimingProvider.definition(opts, this.cfg.warn, this.cfg.profanity ?? 'none'));
    // a timed-out attempt may have been billed: one re-upload at most
    const json = await withRetry(reportTimeouts(async () => {
      const form = new FormData();
      form.append('audio', blob, basename(audio.path));
      form.append('definition', definition);
      const res = await doFetch(url, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': this.cfg.key },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      // redact the key even if the service echoes it
      if (!res.ok) throw await httpErrorFrom(res, 'Azure Speech', [this.cfg.key]);
      return (await res.json()) as FastTranscriptionResponse;
    }, () => this.cfg.usage?.({ audioSeconds: audio.duration, timedOut: true })), retryTimeoutsOnce(this.cfg.retry));
    this.cfg.usage?.({ audioSeconds: audio.duration });
    return mapFastTranscription(json);
  }
}

/** Word times and diarization in one request per file. */
export const azureSpeechProvider: ProviderDescriptor = defineProvider({
  id: 'azure-speech',
  description: 'Azure AI Speech Fast Transcription (word timings + diarization, up to 10 speakers)',
  roles: ['timing'],
  env: [
    { name: 'AZURE_SPEECH_KEY', description: 'Speech resource key', required: true, secret: true },
    // the host comes from AZURE_SPEECH_ENDPOINT when set; the region only builds the default host
    { name: 'AZURE_SPEECH_REGION', description: 'resource region, e.g. westeurope', required: true, waivedBy: 'AZURE_SPEECH_ENDPOINT' },
    { name: 'AZURE_SPEECH_ENDPOINT', description: 'custom host instead of the region, e.g. https://<name>.cognitiveservices.azure.com' },
    { name: 'AZURE_SPEECH_PROFANITY', description: 'none (default: words as spoken), masked (f*** as ****) or removed' },
  ],
  defaults: { timing: 'fast' },
  normalizeModel(model) {
    const mode = model.toLowerCase();
    if (mode !== 'fast') throw new UserError(`Unknown azure-speech mode "${model}"; v1 supports "fast".`);
    return mode;
  },
  create(env, model, deps) {
    const profanity = profanityFrom(env);
    return new AzureSpeechTimingProvider({
      id: deps.id,
      key: envString(env, 'AZURE_SPEECH_KEY')!,
      region: envString(env, 'AZURE_SPEECH_REGION') ?? '',
      endpoint: envString(env, 'AZURE_SPEECH_ENDPOINT'),
      fetch: deps.fetch,
      retry: deps.retry,
      warn: deps.log ? (m) => deps.log!.warn(m) : undefined,
      usage: deps.usage,
      profanity,
    }, model);
  },
});
