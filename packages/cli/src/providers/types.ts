import type { TimedWord } from '../types.js';

/** One piece of compressed audio for the text provider; start/end are its offsets in the full media (s). */
export interface AudioChunk { path: string; index: number; start: number; end: number }
/** The full-length 16 kHz mono WAV for the timing provider. */
export interface AudioFile { path: string; duration: number }

export interface TextOptions {
  /** ISO-639-1 code of the forced language (with --language en,es: the first). */
  language?: string;
  /**
   * All candidate languages when several were given, main first. Providers that accept a list (gpt-transcribe's
   * `languages`) send them all; others use `language`.
   */
  languages?: string[];
  /** Context, style and the tail of the previous chunk. */
  prompt?: string;
  /** Glossary terms. */
  keywords?: string[];
}
export interface TimingOptions {
  language?: string;
  /** All candidate languages when several were given, main first. */
  languages?: string[];
  /** Glossary terms to bias recognition. */
  phrases?: string[];
}

export type JsonSchema = Record<string, unknown>;
/**
 * How much a reasoning model thinks before answering (mapped per provider). No 'minimal': gpt-6.1-sol on Azure
 * answers 400 to it (as of 2026-10-17 it supports low, medium, high, xhigh).
 */
export type Effort = 'low' | 'medium' | 'high';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high'];

/**
 * `name` keys recorded responses. `system` is the large, stable prompt part and `user` the step-specific part:
 * requests sharing `system` and `schemaName` share a prefix that prompt caching can reuse.
 */
export interface LlmRequest {
  name: string;
  system: string;
  user: string;
  schema: JsonSchema;
  /** Schema name sent to the API (OpenAI requires one); default `name`. Same schema → same name. */
  schemaName?: string;
  /**
   * openai/azure-openai: `reasoning_effort`; anthropic: `output_config.effort`; ollama: thinking on for high, off
   * otherwise (unless OLLAMA_THINK is set). Unset: the provider's default.
   */
  effort?: Effort;
}

/** What a text provider returns for one piece of audio. */
export interface TextResult {
  text: string;
  /** Language heard (ISO-639-1 code or locale), if reported. */
  language?: string;
  /**
   * Word times from providers with `wordTimings: true`, relative to the audio piece (the pipeline adds the offset).
   * With `--timing same` these are the timings.
   */
  words?: TimedWord[];
}

/** Request-cache traits (cache.ts). Answers are keyed by a hash of what is sent, including `id` and `settings`. */
export interface CacheTraits {
  /**
   * Settings besides the model id that change the answer (Azure Speech's profanity mode; a custom server address as
   * a fingerprint). Part of every cache key. Never a key or other secret.
   */
  readonly settings?: Record<string, unknown>;
  /**
   * For a speech provider that sends less than it gets: the request fields built from `opts`, as the service sees
   * them (Scribe: language code and keyterms, no prompt). The cache key uses these instead of all options, so an
   * ignored option never pays for the same answer twice. Pure: no warnings, no I/O.
   */
  readonly cacheInputs?: (role: 'text' | 'timing', opts: TextOptions | TimingOptions) => Record<string, unknown>;
  /**
   * Text and timing send the same request for the same audio and `cacheInputs`, and both answers carry text and
   * timed words (`align` sets `TimingResult.text`). The cache keeps one answer for both roles. Needs `cacheInputs`.
   */
  readonly sameRequestForTextAndTiming?: boolean;
  /** Never cache: answers are free, instant and may depend on more than the request (recorded, --text-file). */
  readonly uncached?: boolean;
}

export interface TextProvider extends CacheTraits {
  readonly id: string;
  /**
   * `chunks` (default): one call per compressed MP3 chunk (cloud upload limits). `wav`: the whole 16 kHz WAV in one
   * call (local engines such as whisper.cpp).
   */
  readonly input?: 'chunks' | 'wav';
  transcribe(audio: AudioChunk, opts: TextOptions): Promise<TextResult>;
}
export interface TimingProvider extends CacheTraits {
  readonly id: string;
  align(audio: AudioFile, opts: TimingOptions): Promise<TimingResult>;
}
/** What a timing provider returns for the whole file. */
export interface TimingResult {
  words: TimedWord[];
  language?: string;
  /**
   * Transcript text, for providers with `sameRequestForTextAndTiming`; the request cache strips it before the
   * pipeline sees it.
   */
  text?: string;
  /** Share of speech per language heard (primary codes, e.g. { en: 0.82, es: 0.18 }), if reported. */
  languagesHeard?: Record<string, number>;
}
export interface LlmProvider extends CacheTraits {
  readonly id: string;
  complete<T>(req: LlmRequest): Promise<T>;
  /**
   * Prompt caching: concurrent requests with a shared prefix start this many ms apart, so later ones read what the
   * first wrote to the cache. Default 0.
   */
  readonly cacheWarmupMs?: number;
}

/**
 * The LLM answer is not parseable JSON; the caller retries once. `truncated`: cut off at the token limit, so a retry
 * would be cut off again.
 */
export class LlmFormatError extends Error {
  readonly truncated: boolean;
  constructor(message: string, opts: { truncated?: boolean } = {}) {
    super(message);
    this.name = 'LlmFormatError';
    this.truncated = opts.truncated ?? false;
  }
}

/** RefusalError's name; matched by name, like IMPLAUSIBLE_TRANSCRIPT. */
export const REFUSAL = 'RefusalError';

/**
 * A provider refused the request: its content filter (Azure OpenAI's HTTP 400 content-management message, or
 * `finish_reason: "content_filter"`) or the model (OpenAI's `refusal`, Anthropic's `stop_reason: "refusal"`). Never
 * retried: it would be refused again. The step goes on without the answer where it can and reports it
 * (refusals.ts); otherwise it fails without advising a rerun.
 */
export class RefusalError extends Error {
  constructor(readonly provider: string, readonly by: 'content filter' | 'model', message: string) {
    super(message);
    this.name = REFUSAL;
  }
}

export function isRefusal(err: unknown): err is RefusalError {
  return (err as Error | undefined)?.name === REFUSAL;
}

/** ImplausibleTranscriptError's name; matched by name, since a cached error replays as a plain Error. */
export const IMPLAUSIBLE_TRANSCRIPT = 'ImplausibleTranscriptError';

/**
 * A speech service answered HTTP 200 twice with something that cannot be a transcript (`implausibleScribe` in
 * elevenlabs.ts); request once more yourself before throwing it. For a whole file it is a service fault. For a short
 * re-listen window of mostly music (align/relisten.ts) it means no words, and the pipeline treats it as an empty
 * answer (cached like one, see ANSWER_ERRORS).
 */
export class ImplausibleTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = IMPLAUSIBLE_TRANSCRIPT;
  }
}

/** Also true for one replayed from the request cache. */
export function isImplausibleTranscript(err: unknown): boolean {
  return (err as Error | undefined)?.name === IMPLAUSIBLE_TRANSCRIPT;
}
