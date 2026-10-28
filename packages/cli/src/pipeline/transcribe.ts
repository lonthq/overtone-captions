// Stage 2: the text provider's transcript, one request per audio piece.
import { roundTime } from 'overtone-format';
import { cachedText } from '../cache.js';
import { isRefusal, type AudioChunk, type TextProvider, type TextResult } from '../providers/types.js';
import { primary } from './language.js';
import type { Plan } from './preflight.js';
import { textPrompt } from './prompt.js';
import type { Run } from './run.js';
import type { SecondHearing } from './timing.js';
import type { ExtractData, TranscribeChunk, TranscribeData } from './types.js';

/** The text provider's requests: the chunks in transcribe; the text base's retries and --two-pass in timing. */
export interface TextCalls {
  /** The upload chunks, or the whole WAV in one call for a provider with `input: 'wav'` (local engines). */
  pieces: AudioChunk[];
  /** The forced language's primary code. */
  language?: string;
  /** The candidates' primary codes, main language first. */
  textLanguages?: string[];
  /**
   * One text call for a piece (sent as `path`, default the piece's file); the provider's own word times become absolute.
   * `hint`: a language when none was given (the second hearing's for the first request, the timing provider's for a
   * retry). A refused call answers no text (reported with `run.refused`): the text base retries the chunk and fills
   * what stays empty from the engines, and --two-pass keeps the first pass.
   */
  transcribe(at: 'transcribe' | 'timing', chunk: AudioChunk, prompt: string | undefined, path?: string, hint?: string): Promise<TranscribeChunk>;
}

export function textCalls(run: Run, provider: TextProvider, audio: ExtractData, plan: Pick<Plan, 'forced' | 'candidates'>): TextCalls {
  const language = primary(plan.forced);
  const textLanguages = plan.candidates ? [...new Set(plan.candidates.map((c) => primary(c)!))] : undefined;
  const textOpts = (prompt: string | undefined, hint?: string) => ({ language: language ?? hint, ...(textLanguages ? { languages: textLanguages } : {}), prompt, keywords: run.cfg.glossary });
  const pieces: AudioChunk[] = provider.input === 'wav' ? [{ path: audio.wav, index: 0, start: 0, end: audio.duration }] : audio.chunks;
  const textAt: Record<'transcribe' | 'timing', TextProvider> = {
    transcribe: cachedText(provider, run.requests, 'transcribe'),
    timing: cachedText(provider, run.requests, 'timing'),
  };
  const transcribe = async (at: keyof typeof textAt, chunk: AudioChunk, prompt: string | undefined, path = chunk.path, hint?: string): Promise<TranscribeChunk> => {
    let res: TextResult;
    try {
      res = await textAt[at].transcribe({ ...chunk, path }, textOpts(prompt, hint));
    } catch (err) {
      if (!isRefusal(err)) throw err;
      const what = at === 'transcribe' ? 'the transcription' : prompt === undefined ? 'a retry of the transcription' : 'a retry or second pass of the transcription';
      run.refused({ provider: err.provider, by: err.by, request: `${what} of chunk ${chunk.index + 1}/${pieces.length}`, start: chunk.start, end: chunk.end, instead: 'took it as no text there' });
      return { index: chunk.index, start: chunk.start, end: chunk.end, text: '' };
    }
    const words = res.words?.map((w) => ({ ...w, start: roundTime(w.start + chunk.start), end: roundTime(w.end + chunk.start) }));
    return {
      index: chunk.index, start: chunk.start, end: chunk.end, text: res.text.trim(),
      ...(res.language ? { language: res.language } : {}),
      ...(words && words.length > 0 ? { words } : {}),
    };
  };
  return { pieces, language, textLanguages, transcribe };
}

/**
 * Every piece in order, each with the previous piece's tail in its prompt. Without --language, every piece gets the
 * language the second hearing detected; the stage waits for it.
 */
export async function transcribeStage(run: Run, calls: TextCalls, second?: SecondHearing): Promise<TranscribeData> {
  const { pieces } = calls;
  return run.stage<TranscribeData>('transcribe', async () => {
    const heard = !calls.language && !calls.textLanguages && second ? primary((await second.heard())?.language) : undefined;
    if (heard) run.log.info(`  language: ${heard} (heard by ${second!.id}), sent with the text`);
    const chunks: TranscribeData['chunks'] = [];
    for (const chunk of pieces) {
      const res = await calls.transcribe('transcribe', chunk, textPrompt(run.cfg, chunks[chunks.length - 1]?.text), undefined, heard);
      chunks.push(res);
      run.log.info(`  chunk ${chunk.index + 1}/${pieces.length}: ${res.text.length} chars`);
    }
    return { chunks };
  });
}
