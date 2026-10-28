import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname, join } from 'node:path';
import OpenAI, { AzureOpenAI, toFile } from 'openai';
import { UserError } from '../errors.js';
import type { Logger } from '../log.js';
import { planChunks } from '../media/chunks.js';
import { detectSilences, run, WAV_ARGS } from '../media/extract.js';
import type { TimedWord } from '../types.js';
import { httpStatus, reportTimeouts, retryTimeoutsOnce, withRetry, type RetryOptions } from '../util/retry.js';
import { makeTempDir, type TempDir } from '../util/temp-file.js';
import { jsonContent, jsonObjectSystem, responseFormatFrom, type ResponseFormat } from './json-answer.js';
import { fromWhisperName } from './lang-codes.js';
import { AUDIO_MIME_TYPES, audioTimeoutMs, defineProvider, envFlag, envString, LLM_TIMEOUT_MS, MIN_WORD_SECONDS, round3, serverTag, speakerNumbering, tokenUsage, WHISPER_PROMPT_CHARS, withSettings, type AudioTimeoutPolicy, type CreateDeps, type ProviderDescriptor, type UsageCallback } from './kit.js';
import {
  LlmFormatError,
  RefusalError,
  type AudioChunk,
  type AudioFile,
  type TimingOptions,
  type TimingProvider,
  type TimingResult,
  type LlmProvider,
  type LlmRequest,
  type TextOptions,
  type TextProvider,
  type TextResult,
} from './types.js';

/** SDK per-request options: `timeout` in ms for this attempt (maxRetries stays 0). */
export interface RequestOptions { timeout?: number }

/** The part of the OpenAI SDK client we use (tests pass fakes). */
export interface OpenAILike {
  audio: { transcriptions: { create(params: Record<string, unknown>, options?: RequestOptions): Promise<unknown> } };
  chat: { completions: { create(params: Record<string, unknown>, options?: RequestOptions): Promise<unknown> } };
}

/**
 * Per-attempt upload timeout: Azure Speech's allowance (0.5 s per audio second + 2 minutes), at least LLM_TIMEOUT_MS.
 * Pieces are ≤ 1400 s, so ≤ 13.7 minutes (the SDK default is 10 minutes for any length). Resent at most once.
 */
export const TRANSCRIPTION_TIMEOUT: AudioTimeoutPolicy = { minMs: LLM_TIMEOUT_MS, msPerAudioSecond: 500, extraMs: 120_000 };

/**
 * OPENAI_API_KEY, optional OPENAI_BASE_URL (any compatible server). No SDK retries (withRetry does them); timeout
 * LLM_TIMEOUT_MS, transcription uploads pass their own.
 */
export function createOpenAIClient(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): OpenAILike {
  return new OpenAI({ apiKey: envString(env, 'OPENAI_API_KEY'), baseURL: envString(env, 'OPENAI_BASE_URL'), maxRetries: 0, timeout: LLM_TIMEOUT_MS, fetch: fetchImpl }) as unknown as OpenAILike;
}

/** AZURE_OPENAI_ENDPOINT without trailing slashes or `/openai` or `/openai/v1` (any case). */
export function normalizeAzureEndpoint(endpoint: string | undefined): string {
  return (endpoint ?? '').trim().replace(/\/+$/, '').replace(/\/openai(\/v1)?$/i, '').replace(/\/+$/, '');
}

/** Default api-version of the classic deployments path for the text role (verified 2026-10-17). */
export const AZURE_TRANSCRIBE_API_VERSION = '2025-04-01-preview';

/**
 * `deployment` is the selection's model part.
 * - Classic deployments API (`<endpoint>/openai/deployments/<dep>/…?api-version=…`): both roles when
 *   AZURE_OPENAI_API_VERSION is set, else the text role (with AZURE_TRANSCRIBE_API_VERSION). As of 2026-10-17 the v1
 *   transcription path answers 404 DeploymentNotFound for a gpt-transcribe deployment. `baseURL` is passed instead of
 *   `endpoint`: otherwise AzureOpenAI takes `baseURL` from OPENAI_BASE_URL and rejects the pair.
 * - llm role without AZURE_OPENAI_API_VERSION: the v1 API (`<endpoint>/openai/v1/`).
 */
export function createAzureOpenAIClient(
  env: NodeJS.ProcessEnv,
  deployment: string,
  role: 'text' | 'llm' = 'llm',
  fetchImpl?: typeof fetch,
): OpenAILike {
  const endpoint = normalizeAzureEndpoint(env.AZURE_OPENAI_ENDPOINT);
  const apiVersion = envString(env, 'AZURE_OPENAI_API_VERSION') ?? (role === 'text' ? AZURE_TRANSCRIBE_API_VERSION : undefined);
  const apiKey = envString(env, 'AZURE_OPENAI_API_KEY');
  if (apiVersion) {
    return new AzureOpenAI({
      baseURL: `${endpoint}/openai`,
      apiKey,
      apiVersion,
      deployment,
      maxRetries: 0,
      timeout: LLM_TIMEOUT_MS,
      fetch: fetchImpl,
    }) as unknown as OpenAILike;
  }
  return new OpenAI({
    baseURL: `${endpoint}/openai/v1/`,
    apiKey,
    maxRetries: 0,
    timeout: LLM_TIMEOUT_MS,
    fetch: fetchImpl,
  }) as unknown as OpenAILike;
}

/** gpt-transcribe takes `languages` + `keywords`; older transcription models take `language` only. */
export function isGptTranscribe(model: string): boolean {
  return /gpt-transcribe/i.test(model);
}

/** Azure OpenAI transcription request shape; the deployment name says nothing about the model. */
export interface TextShape {
  /** azure-openai: singular `language` (the glossary is in the prompt). */
  azure?: boolean;
  /** AZURE_OPENAI_TRANSCRIBE_MODEL. */
  underlyingModel?: string;
  /** AZURE_OPENAI_TRANSCRIBE_KEYWORDS=1: also send `languages` + `keywords` (not in Azure's spec). */
  keywords?: boolean;
}

/** Text models that return word times (verbose_json), so `--timing same` works. */
export const WORD_TIMING_TEXT_MODELS: readonly string[] = ['whisper-1'];

/**
 * Azure OpenAI's content filter: HTTP 400 with `code: "content_filter"` (`innererror.code:
 * "ResponsibleAIPolicyViolation"`) and a "content management policy" message. Seen on the chooser's request for a
 * LibriSpeech story ("crushed in his skull").
 */
export function isContentFilterRefusal(err: unknown): boolean {
  if (httpStatus(err) !== 400) return false;
  const e = err as { code?: unknown; message?: unknown; error?: { code?: unknown; innererror?: { code?: unknown } } } | undefined;
  return e?.code === 'content_filter' || e?.error?.code === 'content_filter'
    || e?.error?.innererror?.code === 'ResponsibleAIPolicyViolation'
    || /content management policy/i.test(String(e?.message ?? ''));
}

/** A content-filter refusal as a RefusalError; anything else unchanged. */
function contentFilterOf(id: string, err: unknown): unknown {
  return isContentFilterRefusal(err) ? new RefusalError(id, 'content filter', `${id}: the request was refused by the content filter (HTTP 400)`) : err;
}

export class OpenAITextProvider implements TextProvider {
  constructor(
    readonly id: string,
    private readonly client: OpenAILike,
    private readonly model: string,
    private readonly retry: RetryOptions = {},
    private readonly shape: TextShape = {},
    private readonly usage?: UsageCallback,
  ) {}

  async transcribe(audio: AudioChunk, opts: TextOptions): Promise<TextResult> {
    const bytes = await readFile(audio.path);
    const type = AUDIO_MIME_TYPES[extname(audio.path).toLowerCase()];
    const azure = this.shape.azure === true;
    const modern = azure ? isGptTranscribe(this.shape.underlyingModel ?? '') && this.shape.keywords === true : isGptTranscribe(this.model);
    // whisper-1 on OpenAI: also ask for word times, for `--timing same` (same price)
    const words = !azure && WORD_TIMING_TEXT_MODELS.includes(this.model);
    const prompt = opts.prompt;
    const timeout = audioTimeoutMs(audio.end - audio.start, TRANSCRIPTION_TIMEOUT);
    const seconds = Math.max(0, audio.end - audio.start);
    const res = (await withRetry(reportTimeouts(async () => {
      const params: Record<string, unknown> = {
        file: await toFile(bytes, basename(audio.path), type ? { type } : undefined),
        model: this.model,
        response_format: words ? 'verbose_json' : 'json',
      };
      if (words) params.timestamp_granularities = ['word'];
      if (prompt) params.prompt = prompt;
      if (opts.language) {
        // gpt-transcribe takes all candidates; older models only the main language
        if (modern) params.languages = opts.languages && opts.languages.length > 0 ? opts.languages : [opts.language];
        else params.language = opts.language;
      }
      if (modern && opts.keywords && opts.keywords.length > 0) params.keywords = opts.keywords;
      return this.client.audio.transcriptions.create(params, { timeout });
    }, () => this.usage?.({ audioSeconds: seconds, timedOut: true })), retryTimeoutsOnce(this.retry)).catch((err: unknown) => { throw contentFilterOf(this.id, err); })) as { text?: unknown; languages?: Array<{ code?: string }>; usage?: TranscriptionUsage } & VerboseTranscription;
    if (typeof res.text !== 'string') throw new Error(`${this.id}: transcription response has no text`);
    this.usage?.({ audioSeconds: seconds, ...tokenUsage(res.usage?.input_tokens, res.usage?.output_tokens) });
    if (!words) return { text: res.text, language: res.languages?.[0]?.code };
    const language = fromWhisperLanguage(res.language);
    const timed = whisperWords(res, Math.max(0, audio.end - audio.start)).map((w) => ({ ...w, speaker: 'S1' }));
    return { text: timed.length > 0 ? timed.map((w) => w.text).join(' ') : res.text.trim(), ...(language ? { language } : {}), ...(timed.length > 0 ? { words: timed } : {}) };
  }
}

// ---- timing role: word timings (whisper-1) + speakers (gpt-4o-transcribe-diarize)

/*
 * OpenAI Transcriptions API, POST /v1/audio/transcriptions. As of 2026-10-17:
 * - https://developers.openai.com/api/docs/guides/speech-to-text: files up to 25 MB; whisper-1 for word timestamps;
 *   gpt-4o-transcribe-diarize returns `diarized_json` (segments with speaker, start, end), takes no prompt, needs
 *   `chunking_strategy` over 30 s, and takes up to four known speakers as 2–10 s reference clips (data URLs).
 * - SDK docs (openai 7.30.0): `timestamp_granularities` needs `verbose_json` and is unavailable for
 *   gpt-4o-transcribe-diarize; gpt-4o-transcribe/-mini support `json` only.
 * Live: gpt-transcribe and gpt-4o-transcribe reject `verbose_json` (400), so give no word times; whisper-1 returns
 * `words` ({ word, start, end }, no punctuation), punctuated `text`, `language` as an English name and
 * `usage: { type: 'duration' }`; gpt-4o-transcribe-diarize returns phrase-level segments `{ id, type, text,
 * speaker: "A", start, end }` and token usage (180 audio tokens in, 551 out for 18 s).
 */

/** Word times from whisper-1, speakers from gpt-4o-transcribe-diarize. */
export const OPENAI_TIMING_DEFAULT = 'whisper-1+gpt-4o-transcribe-diarize';
/** Short names for the timing model part. */
export const OPENAI_TIMING_ALIASES: Readonly<Record<string, string>> = { diarize: OPENAI_TIMING_DEFAULT, words: 'whisper-1' };
/** The API's 25 MB upload limit, with a margin. */
export const OPENAI_MAX_UPLOAD_BYTES = 24 * 1000 * 1000;
/** The gpt-4o-transcribe family rejects audio over 1500 s. */
export const OPENAI_MAX_PIECE_SECONDS = 1400;
/** Known-speaker references: count and clip length (the API takes 2–10 s). */
export const KNOWN_SPEAKERS = { max: 4, minSeconds: 2, maxSeconds: 10 } as const;

/** `<words model>[+<diarize model>]`, after aliases. */
export function parseTimingModel(model: string): { words: string; diarize?: string } {
  const m = OPENAI_TIMING_ALIASES[model.trim().toLowerCase()] ?? model.trim();
  const [words, diarize, ...rest] = m.split('+').map((s) => s.trim());
  if (!words || rest.length > 0 || (diarize !== undefined && !diarize) || ![words, diarize ?? 'x'].every((p) => /^[A-Za-z0-9][\w.:-]*$/.test(p))) {
    throw new UserError(`Invalid OpenAI timing model "${model}"; expected <words model>[+<diarize model>], e.g. ${OPENAI_TIMING_DEFAULT}, or one of: ${Object.keys(OPENAI_TIMING_ALIASES).join(', ')}.`);
  }
  return diarize ? { words, diarize } : { words };
}

/** verbose_json response of whisper-1 (fields we use). */
export interface VerboseTranscription {
  text?: string;
  language?: string;
  duration?: number;
  words?: Array<{ word?: string; start?: number; end?: number }>;
}
/** diarized_json response of gpt-4o-transcribe-diarize (fields we use). */
export interface DiarizedTranscription {
  text?: string;
  duration?: number;
  segments?: Array<{ speaker?: string; start?: number; end?: number; text?: string }>;
  usage?: TranscriptionUsage;
}

/** whisper-1's `language` ("english", or a code from compatible servers) → "en"; undefined when unknown. */
export function fromWhisperLanguage(language: string | undefined): string | undefined {
  const l = language?.trim().toLowerCase();
  if (!l) return undefined;
  return fromWhisperName(l) ?? (/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(l) ? l : undefined);
}

const normWord = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/**
 * whisper-1's words with the punctuation and casing of its `text` restored ("year" → "year,"): each word takes the
 * next text token with the same letters and digits, looking up to 4 tokens ahead. Words without text or start are
 * dropped; zero-length words get MIN_WORD_SECONDS; stable-sorted by start.
 */
export function whisperWords(res: VerboseTranscription, duration?: number): TimedWord[] {
  const tokens = (res.text ?? '').split(/\s+/).filter(Boolean);
  let j = 0;
  const out: TimedWord[] = [];
  for (const w of res.words ?? []) {
    const raw = (w.word ?? '').trim();
    if (!raw || typeof w.start !== 'number' || !Number.isFinite(w.start)) continue;
    let text = raw;
    const n = normWord(raw);
    if (n) {
      for (let k = j; k < Math.min(tokens.length, j + 5); k++) {
        if (normWord(tokens[k]!) === n) { text = tokens[k]!; j = k + 1; break; }
      }
    }
    const start = round3(Math.max(0, w.start));
    let end = typeof w.end === 'number' && Number.isFinite(w.end) ? round3(w.end) : start;
    if (duration !== undefined && duration > 0) end = Math.min(end, round3(Math.max(duration, start + MIN_WORD_SECONDS)));
    out.push({ text, start, end: Math.max(end, round3(start + MIN_WORD_SECONDS)) });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** A speaker turn: global speaker key, start, end (s). */
export interface SpeakerSpan { speaker: string; start: number; end: number }

/**
 * Each word gets the speaker of the span it overlaps most, else the nearest span, else S1. Speakers are numbered by
 * first appearance.
 */
export function mergeSpeakers(words: readonly TimedWord[], spans: readonly SpeakerSpan[]): TimedWord[] {
  const sorted = [...spans].filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end)).sort((a, b) => a.start - b.start);
  const speakerOf = speakerNumbering<string>();
  return words.map((w) => {
    let best: SpeakerSpan | undefined;
    let bestOverlap = 0;
    let nearest: SpeakerSpan | undefined;
    let nearestGap = Infinity;
    for (const s of sorted) {
      const overlap = Math.min(w.end, s.end) - Math.max(w.start, s.start);
      if (overlap > bestOverlap) { best = s; bestOverlap = overlap; }
      const gap = Math.max(s.start - w.end, w.start - s.end, 0);
      if (gap < nearestGap) { nearest = s; nearestGap = gap; }
    }
    return { ...w, speaker: speakerOf((best ?? nearest)?.speaker ?? 'S1') };
  });
}

/** One upload piece of the timing WAV; start/end in seconds within the whole file. */
interface Piece { path: string; start: number; end: number }

/** Sample-exact for PCM. */
async function cutWav(src: string, start: number, end: number, out: string): Promise<void> {
  await run('ffmpeg', ['-y', '-v', 'error', '-ss', start.toFixed(3), '-to', end.toFixed(3), '-i', src, ...WAV_ARGS, out]);
}

/** The WAV itself if it fits one request, else pieces cut at silences (same planner as text chunks) into `dir`. */
async function planPieces(audio: AudioFile, dir: () => Promise<string>, maxBytes: number, maxSeconds: number): Promise<Piece[]> {
  const size = (await stat(audio.path)).size;
  if (size <= maxBytes && audio.duration <= maxSeconds) return [{ path: audio.path, start: 0, end: audio.duration }];
  const silences = await detectSilences(audio.path, audio.duration);
  const spans = planChunks(audio.duration, { bytesPerSecond: size / Math.max(audio.duration, 1e-9), maxBytes, maxSeconds, silences });
  const d = await dir();
  const pieces: Piece[] = [];
  for (const [i, s] of spans.entries()) {
    const path = join(d, `piece-${i}.wav`);
    await cutWav(audio.path, s.start, s.end, path);
    pieces.push({ path, start: s.start, end: s.end });
  }
  return pieces;
}

export interface OpenAITimingConfig {
  /** Word-timing model (verbose_json), e.g. whisper-1. */
  words: string;
  /** Diarization model (diarized_json), e.g. gpt-4o-transcribe-diarize; unset: one speaker. */
  diarize?: string;
  retry?: RetryOptions;
  usage?: UsageCallback;
  /** Per-request limits (tests shrink them). */
  maxBytes?: number;
  maxSeconds?: number;
}

/**
 * Timing from OpenAI's transcription models. Per WAV piece (≤ 25 MB / 1400 s, about 12.5 minutes; longer files are
 * cut at silences), whisper-1 (words) and gpt-4o-transcribe-diarize (speakers) run in parallel; each word gets the
 * speaker it overlaps most. Later pieces get the up to four longest-speaking speakers so far as known speakers with a
 * 2–10 s clip each, so ids carry over. Known limitation: a fifth speaker, or one not recognized, gets a new id.
 */
const pieceTimeout = (piece: Piece) => audioTimeoutMs(piece.end - piece.start, TRANSCRIPTION_TIMEOUT);

export class OpenAITimingProvider implements TimingProvider {
  constructor(readonly id: string, private readonly client: OpenAILike, private readonly cfg: OpenAITimingConfig) {}

  private async upload(path: string): Promise<Awaited<ReturnType<typeof toFile>>> {
    return toFile(await readFile(path), basename(path), { type: AUDIO_MIME_TYPES[extname(path).toLowerCase()] ?? 'audio/wav' });
  }

  /** A timed-out request may still be billed. */
  private timedOut(piece: Piece): void {
    this.cfg.usage?.({ audioSeconds: Math.max(0, piece.end - piece.start), timedOut: true });
  }

  private async wordsCall(piece: Piece, language: string | undefined, phrases: readonly string[] | undefined): Promise<VerboseTranscription> {
    return (await withRetry(reportTimeouts(async () => {
      const params: Record<string, unknown> = {
        file: await this.upload(piece.path),
        model: this.cfg.words,
        response_format: 'verbose_json',
        timestamp_granularities: ['word'],
      };
      if (language) params.language = language;
      const prompt = glossaryPrompt(phrases);
      if (prompt) params.prompt = prompt;
      return this.client.audio.transcriptions.create(params, { timeout: pieceTimeout(piece) });
    }, () => this.timedOut(piece)), retryTimeoutsOnce(this.cfg.retry))) as VerboseTranscription;
  }

  private async diarizeCall(piece: Piece, language: string | undefined, known: Array<{ name: string; ref: string }>): Promise<DiarizedTranscription> {
    return (await withRetry(reportTimeouts(async () => {
      const params: Record<string, unknown> = {
        file: await this.upload(piece.path),
        model: this.cfg.diarize!,
        response_format: 'diarized_json',
        chunking_strategy: 'auto',
      };
      if (language) params.language = language;
      if (known.length > 0) {
        params.known_speaker_names = known.map((k) => k.name);
        params.known_speaker_references = known.map((k) => k.ref);
      }
      return this.client.audio.transcriptions.create(params, { timeout: pieceTimeout(piece) });
    }, () => this.timedOut(piece)), retryTimeoutsOnce(this.cfg.retry))) as DiarizedTranscription;
  }

  async align(audio: AudioFile, opts: TimingOptions): Promise<TimingResult> {
    // several candidates: none, so the models detect and follow switches
    const forced = opts.languages && opts.languages.length > 1 ? undefined : opts.language?.trim().toLowerCase().split(/[-_]/)[0] || undefined;
    // removed afterwards, also on a stop
    let tmp: Promise<TempDir> | undefined;
    const tempDir = async () => (await (tmp ??= makeTempDir('overtone-openai-timing-'))).path;
    try {
      const pieces = await planPieces(audio, tempDir, this.cfg.maxBytes ?? OPENAI_MAX_UPLOAD_BYTES, this.cfg.maxSeconds ?? OPENAI_MAX_PIECE_SECONDS);
      const words: TimedWord[] = [];
      const spans: SpeakerSpan[] = [];
      let heard: string | undefined;
      /** Talk time per global speaker and its longest span (for a reference clip). */
      const talk = new Map<string, { seconds: number; longest: SpeakerSpan }>();
      const refs = new Map<string, string>();
      let speakers = 0;
      for (const [i, piece] of pieces.entries()) {
        const seconds = Math.max(0, piece.end - piece.start);
        const known = this.cfg.diarize && i > 0 ? await this.knownSpeakers(audio.path, talk, refs, tempDir) : [];
        const calls = [this.wordsCall(piece, forced, opts.phrases), ...(this.cfg.diarize ? [this.diarizeCall(piece, forced, known)] : [])] as const;
        const [w, d] = await Promise.allSettled(calls);
        // report every billed (successful) call, in a fixed order, before throwing any failure
        if (w!.status === 'fulfilled') this.cfg.usage?.({ audioSeconds: seconds });
        if (d?.status === 'fulfilled') {
          const u = (d.value as DiarizedTranscription).usage;
          this.cfg.usage?.({ audioSeconds: seconds, ...tokenUsage(u?.input_tokens, u?.output_tokens) });
        }
        if (w!.status === 'rejected') throw w!.reason;
        if (d?.status === 'rejected') throw d.reason;
        const verbose = w!.value as VerboseTranscription;
        heard ??= fromWhisperLanguage(verbose.language);
        for (const word of whisperWords(verbose, seconds)) words.push({ ...word, start: round3(word.start + piece.start), end: round3(word.end + piece.start) });
        if (d) {
          const names = new Set(known.map((k) => k.name));
          const local = new Map<string, string>();
          for (const s of (d.value as DiarizedTranscription).segments ?? []) {
            if (typeof s.start !== 'number' || typeof s.end !== 'number' || !Number.isFinite(s.start) || !Number.isFinite(s.end)) continue;
            const label = (s.speaker ?? '?').trim() || '?';
            // a known speaker keeps its global key; another label ("A") is a new speaker
            if (!names.has(label) && !local.has(label)) local.set(label, `speaker_${++speakers}`);
            const speaker = names.has(label) ? label : local.get(label)!;
            const span = { speaker, start: round3(s.start + piece.start), end: round3(Math.max(s.end, s.start) + piece.start) };
            spans.push(span);
            const t = talk.get(speaker);
            const len = span.end - span.start;
            if (!t) talk.set(speaker, { seconds: len, longest: span });
            else { t.seconds += len; if (len > t.longest.end - t.longest.start) t.longest = span; }
          }
        }
      }
      words.sort((a, b) => a.start - b.start);
      const out = this.cfg.diarize ? mergeSpeakers(words, spans) : words.map((w) => ({ ...w, speaker: 'S1' }));
      const language = forced ?? heard;
      return { words: out, ...(language ? { language } : {}) };
    } finally {
      if (tmp) await tmp.then((dir) => dir.remove(), () => undefined);
    }
  }

  /**
   * Up to four speakers with the most talk time whose longest span is ≥ 2 s, each with a clip of that span (≤ 10 s,
   * WAV data URL). Named by global key, so the diarization answers with those keys.
   */
  private async knownSpeakers(wav: string, talk: Map<string, { seconds: number; longest: SpeakerSpan }>, refs: Map<string, string>, dir: () => Promise<string>): Promise<Array<{ name: string; ref: string }>> {
    const top = [...talk.entries()]
      .filter(([, t]) => t.longest.end - t.longest.start >= KNOWN_SPEAKERS.minSeconds)
      .sort((a, b) => b[1].seconds - a[1].seconds)
      .slice(0, KNOWN_SPEAKERS.max);
    const out: Array<{ name: string; ref: string }> = [];
    for (const [speaker, t] of top) {
      if (!refs.has(speaker)) {
        const path = join(await dir(), `speaker-${refs.size}.wav`);
        await cutWav(wav, t.longest.start, Math.min(t.longest.end, t.longest.start + KNOWN_SPEAKERS.maxSeconds), path);
        refs.set(speaker, `data:audio/wav;base64,${(await readFile(path)).toString('base64')}`);
      }
      out.push({ name: speaker, ref: refs.get(speaker)! });
    }
    return out;
  }
}

/** "Glossary: A, B.", cut to fit whisper-1's 224-token prompt limit. */
export function glossaryPrompt(phrases: readonly string[] | undefined): string | undefined {
  const terms: string[] = [];
  let len = 0;
  for (const p of phrases ?? []) {
    const t = p.replace(/\s+/g, ' ').trim();
    if (!t || terms.includes(t)) continue;
    if (len + t.length + 2 > WHISPER_PROMPT_CHARS) break;
    terms.push(t);
    len += t.length + 2;
  }
  return terms.length > 0 ? `Glossary: ${terms.join(', ')}.` : undefined;
}

/** OpenAI requires json_schema.name to match ^[a-zA-Z0-9_-]{1,64}$: replace other characters, shorten with a hash. */
export function schemaName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_-]/g, '-') || 'response';
  if (clean.length <= 64) return clean;
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${clean.slice(0, 55)}-${hash}`;
}

/** Token-billed models report tokens; whisper-1 reports `{ type: 'duration' }`. */
interface TranscriptionUsage { type?: string; input_tokens?: number; output_tokens?: number }

export interface LlmOptions {
  usage?: UsageCallback;
  responseFormat?: ResponseFormat;
  /** Send `reasoning_effort` (OpenAI and Azure only; other compatible servers may reject it). */
  reasoningEffort?: boolean;
  cacheWarmupMs?: number;
  log?: Logger;
}

/** A non-reasoning model's 400 (gpt-4.1, gpt-4o): "Unsupported parameter: 'reasoning_effort' …". */
function rejectsReasoningEffort(err: unknown): boolean {
  const e = err as { param?: unknown; message?: unknown } | undefined;
  return httpStatus(err) === 400 && (e?.param === 'reasoning_effort' || /reasoning_effort/.test(String(e?.message ?? '')));
}

/**
 * OpenAI and Azure cache prefixes of ≥ 1024 tokens automatically, but not for a request that starts while the same
 * prefix is still processing. With a 1.5 s stagger, the second line-cutting request read 2,303 of 2,820 prompt tokens
 * from cache (gpt-6.1-sol on Azure). The schema is part of the prefix: other schemas share nothing.
 */
export const OPENAI_CACHE_WARMUP_MS = 1500;

/** Chat completion `usage` (fields we read). */
interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/** Includes cached and reasoning tokens when reported. */
export function chatUsage(u: ChatUsage | undefined) {
  if (!u) return {};
  const cached = u.prompt_tokens_details?.cached_tokens;
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  return {
    ...tokenUsage(u.prompt_tokens, u.completion_tokens),
    ...(typeof cached === 'number' && Number.isFinite(cached) ? { cachedInputTokens: cached } : {}),
    ...(typeof reasoning === 'number' && Number.isFinite(reasoning) ? { reasoningTokens: reasoning } : {}),
  };
}

export class OpenAILlmProvider implements LlmProvider {
  readonly cacheWarmupMs: number;
  /** Cleared once the model rejects `reasoning_effort`. */
  private sendsEffort: boolean;
  constructor(
    readonly id: string,
    private readonly client: OpenAILike,
    private readonly model: string,
    private readonly retry: RetryOptions = {},
    private readonly opts: LlmOptions = {},
  ) {
    this.cacheWarmupMs = opts.cacheWarmupMs ?? 0;
    this.sendsEffort = opts.reasoningEffort === true;
  }

  async complete<T>(req: LlmRequest): Promise<T> {
    // snapshot: a concurrent request may clear the flag meanwhile
    const sentEffort = this.sendsEffort;
    try {
      return await this.send<T>(req, sentEffort);
    } catch (err) {
      if (!sentEffort || !req.effort || !rejectsReasoningEffort(err)) throw err;
      if (this.sendsEffort) {
        this.sendsEffort = false;
        this.opts.log?.info(`  ${this.id} takes no reasoning_effort (a model without reasoning); sending its requests without it`);
      }
      return this.send<T>(req, false);
    }
  }

  private async send<T>(req: LlmRequest, effort: boolean): Promise<T> {
    const jsonObject = this.opts.responseFormat === 'json_object';
    const res = (await withRetry(
      reportTimeouts(() =>
        this.client.chat.completions.create({
          model: this.model,
          messages: [
            { role: 'system', content: jsonObject ? jsonObjectSystem(req.system, req.schema) : req.system },
            { role: 'user', content: req.user },
          ],
          response_format: jsonObject
            ? { type: 'json_object' }
            : { type: 'json_schema', json_schema: { name: schemaName(req.schemaName ?? req.name), schema: req.schema, strict: true } },
          ...(effort && req.effort ? { reasoning_effort: req.effort } : {}),
        }, { timeout: LLM_TIMEOUT_MS }), () => this.opts.usage?.({ timedOut: true })),
      retryTimeoutsOnce(this.retry),
    ).catch((err: unknown) => { throw contentFilterOf(this.id, err); })) as {
      choices?: Array<{ message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }>;
      usage?: ChatUsage;
    };
    this.opts.usage?.(chatUsage(res.usage));
    const choice = res.choices?.[0];
    if (choice?.message?.refusal) throw new RefusalError(this.id, 'model', `${this.id}: the model refused: ${choice.message.refusal}`);
    if (choice?.finish_reason === 'content_filter') throw new RefusalError(this.id, 'content filter', `${this.id}: response blocked by the content filter`);
    if (choice?.finish_reason === 'length') throw new LlmFormatError('response was cut off (max tokens)', { truncated: true });
    const content = jsonContent(choice?.message?.content);
    if (!content) throw new LlmFormatError('empty response');
    try {
      return JSON.parse(content) as T;
    } catch {
      throw new LlmFormatError('response is not valid JSON');
    }
  }
}

// ---- descriptors

/**
 * Azure text-role request shape:
 * - AZURE_OPENAI_TRANSCRIBE_MODEL: the model behind the deployment, e.g. `gpt-transcribe` (the deployment name never
 *   decides the shape).
 * - AZURE_OPENAI_TRANSCRIBE_KEYWORDS=1: with gpt-transcribe, also send `languages` + `keywords` (not in Azure's
 *   spec). The glossary is in `prompt` either way.
 */
export function azureTextShape(env: NodeJS.ProcessEnv): TextShape {
  return {
    azure: true,
    underlyingModel: envString(env, 'AZURE_OPENAI_TRANSCRIBE_MODEL'),
    keywords: envFlag(env, 'AZURE_OPENAI_TRANSCRIBE_KEYWORDS'),
  };
}

function textOrLlm(role: string): 'text' | 'llm' {
  if (role !== 'text' && role !== 'llm') throw new Error(`openai-family providers have no ${role} role`);
  return role;
}

/** The text or llm provider for an OpenAI-compatible client (openai and azure-openai). */
export function openAiFamily(client: OpenAILike, model: string, deps: CreateDeps, text: TextShape, llm: LlmOptions): TextProvider | LlmProvider {
  return textOrLlm(deps.role) === 'text'
    ? new OpenAITextProvider(deps.id, client, model, deps.retry, text, deps.usage)
    : new OpenAILlmProvider(deps.id, client, model, deps.retry, { ...llm, usage: deps.usage, log: deps.log });
}

/** OpenAI, or any compatible server (OPENAI_BASE_URL). Default models verified 2026-10-07 (timing: 2026-10-17). */
export const openaiProvider: ProviderDescriptor = defineProvider({
  id: 'openai',
  description: 'OpenAI API (or any OpenAI-compatible server via OPENAI_BASE_URL); timing: whisper-1 words + gpt-4o-transcribe-diarize speakers',
  roles: ['text', 'timing', 'llm'],
  env: [
    { name: 'OPENAI_API_KEY', description: 'API key (sk-…)', required: true, secret: true },
    { name: 'OPENAI_BASE_URL', description: 'another OpenAI-compatible server, e.g. http://localhost:1234/v1 (LM Studio)' },
    { name: 'OPENAI_RESPONSE_FORMAT', description: 'json_schema (default) or json_object, for servers without JSON-schema support' },
  ],
  defaults: { text: 'gpt-transcribe', timing: OPENAI_TIMING_DEFAULT, llm: 'gpt-6.1-sol' },
  wordTimings: WORD_TIMING_TEXT_MODELS,
  normalizeModel(model, role) {
    if (role !== 'timing') return model;
    const { words, diarize } = parseTimingModel(model);
    return diarize ? `${words}+${diarize}` : words;
  },
  create(env, model, deps) {
    const client = (deps.openai ?? ((e) => createOpenAIClient(e, deps.fetch)))(env);
    const baseUrl = envString(env, 'OPENAI_BASE_URL');
    if (deps.role === 'timing') {
      return withSettings(new OpenAITimingProvider(deps.id, client, { ...parseTimingModel(model), retry: deps.retry, usage: deps.usage }), { server: serverTag(baseUrl) });
    }
    // reasoning_effort and cache warm-up only for OpenAI itself: other servers may reject the field
    const official = baseUrl === undefined;
    const responseFormat = deps.role === 'llm' ? responseFormatFrom(env, 'OPENAI_RESPONSE_FORMAT') : undefined;
    const provider = openAiFamily(client, model, deps, {}, { responseFormat, reasoningEffort: official, cacheWarmupMs: official ? OPENAI_CACHE_WARMUP_MS : 0 });
    // cache key: another server may serve another model under this name; json_object asks for other output
    return withSettings(provider, { server: serverTag(baseUrl), responseFormat: responseFormat === 'json_object' ? responseFormat : undefined });
  },
});

/** The model part is the deployment name. API paths: createAzureOpenAIClient. */
export const azureOpenaiProvider: ProviderDescriptor = defineProvider({
  id: 'azure-openai',
  description: 'Azure OpenAI deployments (the model part is your deployment name)',
  roles: ['text', 'llm'],
  env: [
    { name: 'AZURE_OPENAI_ENDPOINT', description: 'resource endpoint, e.g. https://<name>.openai.azure.com', required: true },
    { name: 'AZURE_OPENAI_API_KEY', description: 'resource key', required: true, secret: true },
    { name: 'AZURE_OPENAI_API_VERSION', description: 'set: the classic deployments API for both roles, e.g. 2025-04-01-preview' },
    { name: 'AZURE_OPENAI_TRANSCRIBE_MODEL', description: 'the model behind the text deployment, e.g. gpt-transcribe' },
    { name: 'AZURE_OPENAI_TRANSCRIBE_KEYWORDS', description: '1 = also send languages + keywords (with TRANSCRIBE_MODEL=gpt-transcribe)' },
  ],
  defaults: {},
  modelHint: 'your deployment name, e.g. azure-openai:my-deployment',
  create(env, model, deps) {
    const role = textOrLlm(deps.role);
    const client = (deps.azureOpenai ?? ((e, d, r) => createAzureOpenAIClient(e, d, r, deps.fetch)))(env, model, role);
    const shape = azureTextShape(env);
    const provider = openAiFamily(client, model, deps, shape, { reasoningEffort: true, cacheWarmupMs: OPENAI_CACHE_WARMUP_MS });
    // cache key: the deployment belongs to the resource, and these settings shape the request
    return withSettings(provider, {
      server: serverTag(normalizeAzureEndpoint(env.AZURE_OPENAI_ENDPOINT)),
      apiVersion: envString(env, 'AZURE_OPENAI_API_VERSION'),
      ...(role === 'text' ? { underlyingModel: shape.underlyingModel, keywords: shape.keywords || undefined } : {}),
    });
  },
});
