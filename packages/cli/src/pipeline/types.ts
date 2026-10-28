// The data the pipeline's stages hand each other.
import type { Edit, OvertoneDocument, Profile, Speaker, Turn } from 'overtone-format';
import type { TimingRetry } from '../align/relisten.js';
import type { burn } from '../burn/index.js';
import type { ModelSpec, ResolvedConfig } from '../config.js';
import type { Fallback } from '../hearings.js';
import type { Logger } from '../log.js';
import type { cutAudio, extractAudio, ExtractResult, normalizeLoudness } from '../media/extract.js';
import type { VideoInfo } from '../media/video.js';
import type { ExportOptions } from '../output.js';
import type { ProviderDeps, Providers } from '../providers/registry.js';
import type { LlmProvider } from '../providers/types.js';
import type { TextVote } from '../reconcile/vote.js';
import type { ReviewItem } from '../review.js';
import type { Refusal } from '../refusals.js';
import type { Heard, TimedWord } from '../types.js';
import type { UsageTotal } from '../usage.js';

/** The resolved configuration plus the export flags of `transcribe`. */
export type PipelineConfig = ResolvedConfig & ExportOptions;

export interface PipelineDeps {
  log: Logger;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Ready-made providers (tests); skips the environment check. */
  providers?: Providers;
  providerDeps?: ProviderDeps;
  /** Video probe (tests inject one). */
  probeVideo?: (media: string) => Promise<VideoInfo | undefined>;
  /** Burns captions into the video for `--export mp4` (tests inject a fake; Chrome is then not checked). */
  burn?: typeof burn;
  /** `ffmpeg -version` output, checked in preflight for `--export mp4` (tests inject one). */
  ffmpegVersion?: () => Promise<string>;
  checkBinaries?: () => Promise<string[]>;
  /** Stage 1 implementation (tests inject failures). */
  extractAudio?: typeof extractAudio;
  /** Loudness-normalizes an empty chunk before its retry (tests inject a fake). */
  normalizeLoudness?: typeof normalizeLoudness;
  /** Cuts a snippet out of the WAV for re-listening (tests inject a fake). */
  cutAudio?: typeof cutAudio;
  /** Builds the LLM for `languages.<code>.llm` once the language is known. Default: the registry. Tests that pass `providers` pass this too. */
  createLlm?: (sel: ModelSpec) => LlmProvider;
  /** Input duration from ffprobe (tests inject a fake). */
  probeDuration?: (media: string) => Promise<number | undefined>;
  now?: () => Date;
  /** `meta.generator`, also part of the extract key. Default: this package's name@version. */
  generator?: string;
}

export interface PipelineResult {
  doc: OvertoneDocument;
  written: string[];
  summary: string;
  rejected: number;
  /** LLM changes to check by ear (also `meta.review`). */
  review: ReviewItem[];
  /** What the providers reported for this run's calls, plus cache hits. */
  usage: UsageTotal[];
  /** The `usage: …` line; undefined when no provider was asked anything. */
  usageLine?: string;
  /** Refused requests the run went on without (also `meta.refusals`). */
  refusals: Refusal[];
}

/** Extract result plus each audio file's byte size (by name), to detect truncated or replaced files. */
export interface ExtractData extends ExtractResult { sizes: Record<string, number> }
/**
 * `words`: the text provider's own word times (absolute), when it has them. `loudnorm`: the text came from a
 * loudness-normalized retry of an empty chunk. `languageHint`: the retry sent the language the engines heard.
 * `source`: the text is that engine's words, because the text provider gave none.
 */
export interface TranscribeChunk { index: number; start: number; end: number; text: string; language?: string; words?: TimedWord[]; loudnorm?: true; languageHint?: string; source?: string }
export interface TranscribeData { chunks: TranscribeChunk[] }
export interface TimingData { words: TimedWord[]; language?: string; languagesHeard?: Record<string, number> }

/**
 * A chunk the text base changed (`meta.textRetries`). `loudnorm`: re-sent loudness-normalized; `language`: sent with
 * the retries; `attempts`: an empty chunk's retries in order, `attempt` the one (from 1) whose answer is the text;
 * `echo`: words removed as a prompt echo. `result`: `retry` (a retry's answer), `timing` (every retry was empty too:
 * an engine's words, see `meta.fallbacks`) or `removed` (the text without the echo).
 */
export interface TextRetry {
  start: number;
  end: number;
  reason: string;
  loudnorm?: true;
  language?: string;
  attempts?: RetryAttempt[];
  attempt?: number;
  echo?: string;
  result: 'retry' | 'timing' | 'removed';
}
/**
 * One retry of an empty chunk (text-base.ts EMPTY_RETRY). `audio`: the whole chunk, or only `start`–`end` where the
 * engines heard speech. `prompt`: the first request's whole prompt (`context`), the glossary plus preceding text
 * (`names`), or `none`. `words`: how many words the answer had.
 */
export interface RetryAttempt { audio: 'chunk' | 'speech'; start?: number; end?: number; prompt: 'context' | 'names' | 'none'; words: number }
/** The text base: chunks after echo removal, empty-chunk retries and the fallback to an engine's words. */
export interface CoverageData extends TranscribeData { fallbacks: Fallback[]; retries?: TextRetry[]; textIsEngine?: number }
/**
 * `heard`: per word in turn order, what the timing side heard there. `timingRetries`: unheard stretches sent again.
 * `textVotes`: the text vote's regions.
 */
export interface AlignData { language: string; turns: Turn[]; heard: Array<Heard | null>; timingRetries?: TimingRetry[]; textVotes?: TextVote[] }
/** `review`: the editor's part of the review list; the vote's part comes from `AlignData.textVotes`. */
export interface RefineData { speakers: Speaker[]; turns: Turn[]; profiles: Profile[]; edits: Edit[]; rejected: number; review: ReviewItem[] }
