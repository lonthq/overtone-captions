import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { UserError } from '../errors.js';
import { reportTimeouts, retryTimeoutsOnce, withDeadline, withRetry, type RetryOptions } from '../util/retry.js';
import { cleanPhrases, defaultTimeoutMs, FAST_TRANSCRIPTION_API_VERSION, mapFastTranscription, type FastTranscriptionResponse } from './azure-speech.js';
import { defineProvider, envString, httpErrorFrom, type ProviderDescriptor, type UsageCallback } from './kit.js';
import { primaryCode } from './lang-codes.js';
import type { AudioChunk, AudioFile, TextOptions, TextProvider, TextResult, TimingOptions, TimingProvider, TimingResult } from './types.js';

/**
 * Microsoft MAI-Transcribe via Azure Speech Fast Transcription with `enhancedMode` (same endpoint and api-version as
 * azure-speech). Lowercase here; the API wants the `MAI_API_NAMES` spelling.
 * https://learn.microsoft.com/azure/ai-services/speech-service/mai-transcribe (verified 2026-10-26).
 */
export const MAI_MODELS = ['mai-transcribe-2'] as const;
const MAI_API_NAMES: Record<string, string> = { 'mai-transcribe-2': 'MAI-Transcribe-2' };
export const DEFAULT_MODEL = 'mai-transcribe-2';

/**
 * Languages MAI-Transcribe-2 lists (ISO 639-1, plus `fil` and `yue`), per the page above as of 2026-10-26. `locales`
 * takes one of these; without it the model detects the language.
 */
export const MAI_LANGUAGES: readonly string[] = [
  'af', 'ar', 'as', 'az', 'bg', 'bn', 'bs', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fa', 'fi', 'fil', 'fr',
  'gl', 'gu', 'he', 'hi', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'kk', 'kn', 'ko', 'lt', 'lv', 'mk', 'ml', 'mr', 'ms',
  'nb', 'ne', 'nl', 'or', 'pa', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'uk', 'ur',
  'vi', 'yue', 'zh',
];

/**
 * The forced language if MAI lists it. None with several candidates, so the model detects and follows switches (the
 * docs advise `locales` only for a known language).
 */
export function maiLanguage(opts: { language?: string; languages?: string[] }): string | undefined {
  if (opts.languages && opts.languages.length > 1) return undefined;
  if (!opts.language) return undefined;
  const code = opts.language.trim().toLowerCase();
  if (MAI_LANGUAGES.includes(code)) return code;
  const primary = primaryCode(code);
  return MAI_LANGUAGES.includes(primary) ? primary : undefined;
}

/**
 * CacheTraits.cacheInputs: language code and phrase list. No prompt is sent; text and timing send the same request.
 */
export function maiRequestInputs(role: 'text' | 'timing', opts: TextOptions | TimingOptions): Record<string, unknown> {
  const terms = role === 'text' ? (opts as TextOptions).keywords : (opts as TimingOptions).phrases;
  const phrases = cleanPhrases(terms);
  return { locale: maiLanguage(opts), ...(phrases.length > 0 ? { phrases } : {}) };
}

/**
 * The multipart `definition`: enhanced mode, word timestamps, diarization, verbatim style (fillers and false starts
 * kept, like the other engines), glossary as `phraseList`, at most one locale.
 */
export function maiDefinition(model: string, inputs: { locale?: string; phrases?: string[] }): Record<string, unknown> {
  return {
    ...(inputs.locale ? { locales: [inputs.locale] } : {}),
    diarization: { enabled: true },
    ...(inputs.phrases?.length ? { phraseList: { phrases: inputs.phrases } } : {}),
    enhancedMode: {
      enabled: true,
      model: MAI_API_NAMES[model] ?? model,
      modelOptions: { timestamps: 'word', transcribeStyle: 'verbatim' },
    },
  };
}

/**
 * Maps like Fast Transcription, minus phrase confidence: MAI-Transcribe-2 reports 0 for every phrase (as of
 * 2026-10-26), which would read as "unsure" downstream. Text is the combined transcript on one line (MAI breaks lines
 * between speakers).
 */
export function mapMaiResponse(res: FastTranscriptionResponse): TimingResult & { text: string } {
  const phrases = (res.phrases ?? []).map(({ confidence: _unused, ...p }) => p);
  const mapped = mapFastTranscription({ ...res, phrases });
  const joined = (res.combinedPhrases ?? []).map((p) => p.text).join(' ').trim() || phrases.map((p) => p.text).join(' ');
  return { ...mapped, text: joined.replace(/\s+/g, ' ').trim() };
}

export interface AzureMaiConfig {
  key: string;
  /** Host, e.g. `https://<name>.cognitiveservices.azure.com`. */
  endpoint: string;
  model: string;
  fetch: typeof fetch;
  retry?: RetryOptions;
  /** Per-attempt timeout in ms. Default as azure-speech: max(10 min, 0.5 s per audio second + 2 min). */
  timeoutMs?: number;
  warn?: (message: string) => void;
  usage?: UsageCallback;
}

export class AzureMaiProvider implements TextProvider, TimingProvider {
  /** The whole WAV in one call, so diarization covers the whole file. */
  readonly input = 'wav' as const;
  /** Cache by what is sent (no prompt), once for both roles. */
  readonly cacheInputs = maiRequestInputs;
  readonly sameRequestForTextAndTiming = true;
  private warned = new Set<string>();
  constructor(readonly id: string, private readonly cfg: AzureMaiConfig) {}

  private warnOnce(message: string): void {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.cfg.warn?.(message);
  }

  private async call(path: string, seconds: number, role: 'text' | 'timing', opts: TextOptions | TimingOptions): Promise<FastTranscriptionResponse> {
    const inputs = maiRequestInputs(role, opts);
    if (!inputs.locale && opts.language && !(opts.languages && opts.languages.length > 1)) {
      this.warnOnce(`MAI-Transcribe does not list the language '${opts.language}'; letting it detect the language`);
    }
    const url = `${this.cfg.endpoint}/speechtotext/transcriptions:transcribe?api-version=${FAST_TRANSCRIPTION_API_VERSION}`;
    const definition = JSON.stringify(maiDefinition(this.cfg.model, inputs as { locale?: string; phrases?: string[] }));
    // disk-backed Blob: streamed per attempt, not held in memory
    const blob = await openAsBlob(path, { type: 'audio/wav' });
    const timeoutMs = this.cfg.timeoutMs ?? defaultTimeoutMs(seconds);
    // a timed-out attempt may have been billed: one re-upload at most
    const json = await withRetry(reportTimeouts(() => withDeadline(timeoutMs, async (signal) => {
      const form = new FormData();
      form.append('audio', blob, basename(path));
      form.append('definition', definition);
      const res = await this.cfg.fetch(url, {
        method: 'POST',
        headers: { 'Ocp-Apim-Subscription-Key': this.cfg.key },
        body: form,
        signal,
      });
      if (!res.ok) throw await httpErrorFrom(res, 'Azure MAI-Transcribe', [this.cfg.key]);
      return (await res.json()) as FastTranscriptionResponse;
    }), () => this.cfg.usage?.({ audioSeconds: seconds, timedOut: true })), retryTimeoutsOnce(this.cfg.retry));
    this.cfg.usage?.({ audioSeconds: seconds });
    return json;
  }

  /** MAI takes no prompt: only the glossary is sent, as the phrase list. */
  async transcribe(audio: AudioChunk, opts: TextOptions): Promise<TextResult> {
    const res = mapMaiResponse(await this.call(audio.path, Math.max(0, audio.end - audio.start), 'text', opts));
    return { text: res.text, words: res.words, ...(res.language ? { language: res.language } : {}) };
  }

  /** Same request as `transcribe`; the answer also carries the text. */
  async align(audio: AudioFile, opts: TimingOptions): Promise<TimingResult> {
    return mapMaiResponse(await this.call(audio.path, audio.duration, 'timing', opts));
  }
}

/** MAI-Transcribe on an Azure AI Foundry (Speech) resource: text, word times and speakers in one call. */
export const azureMaiProvider: ProviderDescriptor = defineProvider({
  id: 'azure-mai',
  description: 'Microsoft MAI-Transcribe on Azure (Foundry Speech): text, word timings + diarization in one call (--timing same)',
  roles: ['text', 'timing'],
  env: [
    { name: 'AZURE_MAI_KEY', description: 'key of an Azure AI Foundry or Speech resource in a region that serves MAI-Transcribe', required: true, secret: true },
    // the host comes from AZURE_MAI_ENDPOINT when set; the region only builds the default host
    { name: 'AZURE_MAI_REGION', description: 'resource region, e.g. northeurope', required: true, waivedBy: 'AZURE_MAI_ENDPOINT' },
    { name: 'AZURE_MAI_ENDPOINT', description: 'resource host instead of the region, e.g. https://<name>.cognitiveservices.azure.com' },
  ],
  defaults: { text: DEFAULT_MODEL, timing: DEFAULT_MODEL },
  modelHint: `a MAI-Transcribe model: ${MAI_MODELS.join(', ')}`,
  wordTimings: true,
  normalizeModel(model) {
    const m = model.toLowerCase();
    if (!(MAI_MODELS as readonly string[]).includes(m)) throw new UserError(`Unknown azure-mai model "${model}"; supported: ${MAI_MODELS.join(', ')}.`);
    return m;
  },
  create(env, model, deps) {
    const endpoint = envString(env, 'AZURE_MAI_ENDPOINT') ?? `https://${envString(env, 'AZURE_MAI_REGION') ?? ''}.api.cognitive.microsoft.com`;
    return new AzureMaiProvider(deps.id, {
      key: envString(env, 'AZURE_MAI_KEY')!,
      endpoint: endpoint.replace(/\/+$/, ''),
      model,
      fetch: deps.fetch ?? fetch,
      retry: deps.retry,
      warn: deps.log ? (m) => deps.log!.warn(m) : undefined,
      usage: deps.usage,
    });
  },
});
