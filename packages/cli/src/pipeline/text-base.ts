// The text base (part of the timing stage for --from-stage). Prompt echoes the engines do not back up are removed
// (echo.ts). A chunk with no words where the engines heard speech is retried (EMPTY_RETRY); one still empty takes an
// engine's words (hearings.ts textBase). Everything else is left to the text vote in the align stage.
import { roundTime } from 'overtone-format';
import { findPromptEcho, type PromptEcho } from '../echo.js';
import { textBase, unmatchedStretches, wordsInSpan } from '../hearings.js';
import { cutAudio, normalizeLoudness } from '../media/extract.js';
import type { AudioChunk } from '../providers/types.js';
import { tokenizeDisplay } from '../text/normalize.js';
import type { TimedWord } from '../types.js';
import { span } from './duration.js';
import { primary } from './language.js';
import type { Plan } from './preflight.js';
import { namesPrompt, textPrompt } from './prompt.js';
import type { Run } from './run.js';
import type { Hearings } from './timing.js';
import type { TextCalls } from './transcribe.js';
import type { CoverageData, ExtractData, RetryAttempt, TextRetry, TranscribeChunk, TranscribeData } from './types.js';

/**
 * Retries of a chunk the text provider left empty where the engines heard speech; gpt-transcribe can return nothing
 * for a whole film that opens with music. Every retry is loudness-normalized, sends the language the engines heard when
 * none was given, and the first answer with words wins:
 * 1. the whole chunk with the first request's whole prompt (`context`);
 * 2. only where the engines heard speech (± `pad`), with the glossary and preceding text as prompt (`names`): the model
 *    detects the language from the opening seconds, so the audio should start with speech. Skipped when it would cut
 *    less than `minCut` seconds;
 * 3. that audio without a prompt.
 * The same audio with the same prompt is never sent twice.
 */
export const EMPTY_RETRY = {
  /** Seconds of audio kept before the engines' first word and after their last in the trimmed retry. */
  pad: 0.5,
  /** The trimmed retry is skipped when it would remove less than this many seconds of the chunk in total. */
  minCut: 1,
} as const;

export interface TextBaseInput {
  plan: Pick<Plan, 'sel' | 'textFile'>;
  calls: TextCalls;
  text: TranscribeData;
  hearings: Hearings;
  audio: ExtractData;
}

/** The words that overlap a chunk. */
export const wordsOver = (words: readonly TimedWord[], c: { start: number; end: number }) => words.filter((w) => w.end > c.start && w.start < c.end);

/** Prompt echo removal (echo.ts) in the run's language. */
export const echoGuard = (language: string | undefined) => (answer: string, prompt: string | undefined, words: readonly TimedWord[]) =>
  findPromptEcho(answer, prompt, words, { language });

const echoNote = (echoes: readonly PromptEcho[]) => echoes
  .map((e) => `"${e.text}" (${e.to - e.from + 1} words at ${e.start.toFixed(2)}–${e.end.toFixed(2)} s, where the engines heard ${e.heard ? `"${e.heard}"` : 'nothing'})`)
  .join(', ');

/** The text the align stage starts from; with --timing same or --text-file, the text as transcribed or given. */
export async function textBaseStep(run: Run, input: TextBaseInput): Promise<CoverageData> {
  const { plan, text } = input;
  if (plan.textFile) textFileWarnings(run, input);
  const covered: CoverageData = plan.sel.timing.same || plan.textFile
    ? { chunks: text.chunks, fallbacks: [] }
    : await run.step<CoverageData>('timing', 'text base', () => coverText(run, input));
  for (const f of covered.fallbacks) run.log.warn(`${span(f)}: ${f.reason} (recorded in meta.fallbacks)`);
  return covered;
}

/**
 * A --text-file chunk looks like another media's transcript when it has under `share` of the words the timing
 * provider heard there, and that heard at least `minHeard` (a short quiet chunk proves nothing).
 */
const OTHER_TRANSCRIPT = { minHeard: 10, share: 0.3 } as const;

/** --text-file: the text is kept as given; speech it leaves out only gets a warning. */
function textFileWarnings(run: Run, { calls, text, hearings }: TextBaseInput): void {
  for (const c of text.chunks) {
    const inSpan = wordsInSpan(hearings.timing.words, c.start, c.end, c.index === calls.pieces.length - 1);
    const said = tokenizeDisplay(c.text).length;
    const keeping = 'keeping the text as given, so speech it leaves out gets no captions';
    if (inSpan.length >= OTHER_TRANSCRIPT.minHeard && said < OTHER_TRANSCRIPT.share * inSpan.length) {
      run.log.warn(`--text-file: the text has ${said} words where the timing provider heard ${inSpan.length} (is it the transcript of this media?); ${keeping}`);
      continue;
    }
    const gaps = unmatchedStretches(tokenizeDisplay(c.text), inSpan, hearings.language);
    if (gaps.length > 0) run.log.warn(`--text-file: the text has no words for ${gaps.map((g) => `${span(g)} (${g.words} words heard)`).join(', ')}; ${keeping}`);
  }
}

async function coverText(run: Run, input: TextBaseInput): Promise<CoverageData> {
  const { calls, text, hearings, audio } = input;
  const unecho = echoGuard(hearings.language);
  const chunks: TranscribeChunk[] = [];
  const retries: TextRetry[] = [];
  for (const [k, answered] of text.chunks.entries()) {
    const perEngine = hearings.engines.map((e) => wordsInSpan(e.words, answered.start, answered.end, answered.index === calls.pieces.length - 1));
    const inSpan = perEngine.flat();
    const name = `chunk ${answered.index + 1}/${text.chunks.length} (${span(answered)})`;
    const echo = unecho(answered.text, textPrompt(run.cfg, text.chunks[k - 1]?.text), wordsOver(hearings.timing.words, answered));
    let c: TranscribeChunk = answered;
    if (echo.echoes.length > 0) {
      c = { ...answered, text: echo.text };
      delete c.words;
      run.log.warn(`${name}: the text provider echoed its prompt: ${echoNote(echo.echoes)}; removing it`);
      retries.push({ start: roundTime(c.start), end: roundTime(c.end), reason: 'the text provider echoed its prompt', echo: echo.echoes.map((e) => e.text).join(' … '), result: 'removed' });
    }
    if (c.text.trim() || inSpan.length === 0) { chunks.push(c); continue; }
    // count what one engine heard: two engines hearing the same speech is not twice as much
    const heardWords = Math.max(...perEngine.map((ws) => ws.length));
    const retried = await retryEmpty(run, input, { chunk: c, piece: k, engineWords: inSpan, heardWords, before: chunks[chunks.length - 1]?.text, name });
    retries.push(retried.retry);
    chunks.push(retried.chunk);
  }
  const base = textBase(chunks, hearings.engines, { duration: audio.duration });
  return { chunks: base.chunks as TranscribeChunk[], fallbacks: base.fallbacks, retries, ...(base.textIsEngine !== undefined ? { textIsEngine: base.textIsEngine } : {}) };
}

/**
 * The retries of an empty chunk (EMPTY_RETRY). `engineWords`: all engines' words in it (for the span); `heardWords`:
 * the most words one engine heard there; `before`: the previous chunk's text.
 */
async function retryEmpty(
  run: Run,
  { calls, hearings }: TextBaseInput,
  at: { chunk: TranscribeChunk; piece: number; engineWords: TimedWord[]; heardWords: number; before: string | undefined; name: string },
): Promise<{ chunk: TranscribeChunk; retry: TextRetry }> {
  const { chunk: c, name } = at;
  const hint = !calls.language && !calls.textLanguages && !c.language ? primary(hearings.timing.language ?? hearings.second?.language)?.toLowerCase() : undefined;
  const piece = calls.pieces[at.piece]!;
  const reason = `the text provider returned no text where the engines heard ${at.heardWords} words`;
  run.log.warn(`${name}: ${reason}; retrying with loudness-normalized audio${hint ? ` and language ${hint} (heard by the engines)` : ''}`);
  const louder = await (run.deps.normalizeLoudness ?? normalizeLoudness)(piece.path);
  // try 1 sends the first request's whole prompt: with the language, the context is what gets gpt-transcribe to answer
  const full = textPrompt(run.cfg, at.before);
  const names = namesPrompt(run.cfg, at.before);
  // where the engines heard speech, padded, in seconds from the start of the piece's file
  const length = piece.end - piece.start;
  const from = Math.max(0, Math.min(...at.engineWords.map((w) => w.start)) - piece.start - EMPTY_RETRY.pad);
  const to = Math.min(length, Math.max(...at.engineWords.map((w) => w.end)) - piece.start + EMPTY_RETRY.pad);
  const trim = to > from && from + (length - to) >= EMPTY_RETRY.minCut ? { from, to } : undefined;
  type Try = { trim?: { from: number; to: number }; prompt: string | undefined; kind: RetryAttempt['prompt'] };
  const candidates: Try[] = [
    { prompt: full, kind: full ? 'context' : 'none' },
    ...(trim ? [{ trim, prompt: names, kind: names ? 'names' as const : 'none' as const }] : []),
    { trim, prompt: undefined, kind: 'none' },
  ];
  // never send the same audio with the same prompt twice (without a context or glossary the prompts coincide)
  const tries = candidates.filter((t, i) => candidates.findIndex((u) => !!u.trim === !!t.trim && u.prompt === t.prompt) === i);
  const attempts: RetryAttempt[] = [];
  const base = { start: roundTime(c.start), end: roundTime(c.end), reason, loudnorm: true as const, ...(hint ? { language: hint } : {}) };
  let speech: string | undefined;
  for (const [i, t] of tries.entries()) {
    let sent: AudioChunk = piece;
    let path = louder;
    if (t.trim) {
      speech ??= await (run.deps.cutAudio ?? cutAudio)(louder, t.trim.from, t.trim.to);
      path = speech;
      sent = { ...piece, start: roundTime(piece.start + t.trim.from), end: roundTime(piece.start + t.trim.to) };
    }
    // a provider's own word times are absolute (relative to `sent`); the chunk keeps its own span
    const answer = await calls.transcribe('timing', sent, t.prompt, path, hint);
    const again = echoGuard(hearings.language)(answer.text, t.prompt, wordsOver(hearings.timing.words, c));
    const got = tokenizeDisplay(again.text).length;
    attempts.push({ audio: t.trim ? 'speech' : 'chunk', ...(t.trim ? { start: sent.start, end: sent.end } : {}), prompt: t.kind, words: got });
    const what = `${t.trim ? `only ${span(sent)}, where the engines heard speech` : 'the whole chunk'}, ${{ context: 'the whole prompt', names: 'glossary and earlier text as prompt', none: 'no prompt' }[t.kind]}`;
    run.log.info(`  ${name}: retry ${i + 1} of ${tries.length} (${what}): ${got} words`);
    if (got === 0) continue;
    const retried: TranscribeChunk = { ...answer, index: c.index, start: c.start, end: c.end, text: again.text, loudnorm: true, ...(hint ? { languageHint: hint } : {}) };
    if (again.echoes.length > 0) delete retried.words;
    return { chunk: retried, retry: { ...base, attempts, attempt: i + 1, result: 'retry' } };
  }
  return { chunk: c, retry: { ...base, attempts, result: 'timing' } };
}
