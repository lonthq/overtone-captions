// Stage 4: times, snippet re-listens, the text vote and speakers (hearings.ts).
import { roundTime } from 'overtone-format';
import { snapWindow } from '../align/relisten.js';
import { cachedLlm, cachedText, cachedTiming } from '../cache.js';
import { UserError } from '../errors.js';
import { hear, preferredEngine, speakerEngine, speakersHeard } from '../hearings.js';
import { cutAudio } from '../media/extract.js';
import type { Providers } from '../providers/registry.js';
import { isImplausibleTranscript, isRefusal, type LlmProvider, type TimingOptions, type TimingProvider } from '../providers/types.js';
import { tokenizeDisplay } from '../text/normalize.js';
import { buildTurns } from '../turns.js';
import type { TimedWord } from '../types.js';
import type { MediaContext } from './editor.js';
import { primary } from './language.js';
import type { Plan } from './preflight.js';
import type { Run } from './run.js';
import { ANSWER_ERRORS, type Hearings } from './timing.js';
import type { TextCalls } from './transcribe.js';
import type { AlignData, CoverageData, ExtractData, TranscribeData } from './types.js';

export interface AlignInput {
  plan: Pick<Plan, 'sel' | 'textFile'>;
  providers: Providers;
  secondTiming?: TimingProvider;
  audio: ExtractData;
  calls: TextCalls;
  hearings: Hearings;
  covered: CoverageData;
  /** The text to align: the text base, or its second pass. */
  finalText: TranscribeData;
  llm: LlmProvider;
  context: MediaContext;
}

export async function alignStage(run: Run, input: AlignInput): Promise<AlignData> {
  const { cfg, log } = run;
  const { plan, hearings: { engines }, covered, finalText, context: { context, inferredTerms } } = input;
  const lang = input.hearings.language ?? 'und';
  attachListeners(run, input);
  // no vote with --text-file: the user's text is kept as given
  const voting = !plan.textFile;
  const aligned = await run.stage<AlignData>('align', async () => {
    // times from the second hearing when it heard words, else the timing provider; speakers from the engine that told
    // more voices apart
    const timeBy = preferredEngine(engines);
    const speakersBy = speakerEngine(engines, timeBy);
    if (engines.length > 1) log.info(`  times from ${engines[timeBy]!.id}, speakers from ${engines[speakersBy]!.id} (${engines.map((e) => `${e.id}: ${speakersHeard(e.words)}`).join(', ')} speakers)`);
    const result = await hear({
      text: tokenizeDisplay(finalText.chunks.map((c) => c.text).join(' ')),
      engines, timeBy, speakersBy,
      ...(covered.textIsEngine !== undefined ? { textIsEngine: covered.textIsEngine } : {}),
      textEngine: plan.sel.text.model ?? plan.sel.text.provider,
      language: lang, duration: input.audio.duration,
      ...(context ? { context } : {}),
      names: [...cfg.glossary, ...inferredTerms.filter((t) => !cfg.glossary.includes(t))],
    }, { log, onRefusal: run.refused, ...(voting ? { llm: cachedLlm(input.llm, run.requests, 'align'), relistenText: snippetText(run, input) } : {}) });
    return {
      language: lang, turns: buildTurns(result.words), heard: result.words.map((w) => w.heard ?? null),
      ...(result.retries.length > 0 ? { timingRetries: result.retries } : {}),
      ...(result.votes.length > 0 ? { textVotes: result.votes } : {}),
    };
  });
  if (aligned.turns.every((t) => t.words.length === 0)) {
    throw new UserError(`No words to caption: the text provider (${plan.sel.text.id}) returned no text and the timing provider (${plan.sel.timing.id}) heard no words. Does the media contain speech? Nothing was written.`);
  }
  return aligned;
}

/**
 * Lets each engine hear snippets again where the hearings missed words. Timing snippets are requests of the timing
 * stage, the vote's of the align stage (for `--from-stage`).
 */
function attachListeners(run: Run, { plan: { sel }, providers, secondTiming, audio, hearings: { engines, timingOpts } }: AlignInput): void {
  const { deps, log, requests } = run;
  const relistenText = cachedText(providers.text, requests, 'timing', ANSWER_ERRORS);
  // --timing same: the text provider hears the snippet, and its own word times are the times
  const sameTiming: TimingProvider = {
    id: sel.text.id,
    align: async (a, opts) => {
      const res = await relistenText.transcribe({ path: a.path, index: 0, start: 0, end: a.duration }, { ...textLanguageOpts(opts), keywords: opts.phrases });
      return { words: res.words ?? [], ...(res.language ? { language: res.language } : {}) };
    },
  };
  /** Sends a WAV snippet to `provider` again; its words in absolute seconds. */
  const snippetListener = (provider: TimingProvider) => async (start: number, end: number): Promise<TimedWord[]> => {
    // widen to the grid, so a window a few ms off sends the same audio and hits the cache
    const win = snapWindow(start, end, audio.duration);
    try {
      const path = await (deps.cutAudio ?? cutAudio)(audio.wav, win.start, win.end);
      const data = await provider.align({ path, duration: roundTime(win.end - win.start) }, timingOpts);
      return data.words.map((w) => ({ ...w, start: roundTime(w.start + win.start), end: roundTime(w.end + win.start) }));
    } catch (err) {
      if (err instanceof UserError) throw err;
      if (isImplausibleTranscript(err)) {
        log.info(`  timing: ${provider.id} returned no plausible transcript for ${start.toFixed(2)}–${end.toFixed(2)} s; taking it as no words heard`);
        return [];
      }
      if (isRefusal(err)) {
        run.refused({ provider: err.provider, by: err.by, request: 'a timing snippet re-listen', start, end, instead: 'took it as no words heard and kept the estimated times there' });
        return [];
      }
      log.warn(`${provider.id} failed for ${start.toFixed(2)}–${end.toFixed(2)} s (${(err as Error).message}); keeping the estimated times there. The failed request is not cached: run the command again to retry.`);
      return [];
    }
  };
  engines[0]!.listen = snippetListener(sel.timing.same ? sameTiming : cachedTiming(providers.timing, requests, 'timing', ANSWER_ERRORS));
  if (engines[1] && secondTiming) engines[1].listen = snippetListener(cachedTiming(secondTiming, requests, 'timing', ANSWER_ERRORS));
}

/**
 * The timing options' languages for a text call, main parts only ("nl-BE" → "nl") like every other text call: a text
 * provider such as whisper rejects a region.
 */
export function textLanguageOpts(opts: Pick<TimingOptions, 'language' | 'languages'>): { language: string | undefined; languages?: string[] } {
  return { language: primary(opts.language), ...(opts.languages ? { languages: [...new Set(opts.languages.map((l) => primary(l)!))] } : {}) };
}

/** The vote's snippet re-listen with the text provider; the prompt is the caption text before the snippet. */
function snippetText(run: Run, { plan: { sel }, providers, audio, calls, hearings }: AlignInput) {
  const voteText = cachedText(providers.text, run.requests, 'align');
  // no known language: leave it out, as the main transcription did ("und" is no language a provider takes)
  const language = calls.language ?? (hearings.language ? primary(hearings.language) : undefined);
  return async (start: number, end: number, prompt: string | undefined): Promise<string> => {
    const win = snapWindow(start, end, audio.duration);
    try {
      const path = await (run.deps.cutAudio ?? cutAudio)(audio.wav, win.start, win.end);
      const res = await voteText.transcribe({ path, index: 0, start: win.start, end: win.end }, { ...(language ? { language } : {}), ...(calls.textLanguages ? { languages: calls.textLanguages } : {}), prompt });
      return res.text.trim();
    } catch (err) {
      if (err instanceof UserError) throw err;
      if (isRefusal(err)) {
        run.refused({ provider: err.provider, by: err.by, request: "the text vote's snippet re-listen", start, end, instead: 'the vote took it as no words heard there' });
        return '';
      }
      run.log.warn(`${sel.text.id} failed for the snippet ${start.toFixed(2)}–${end.toFixed(2)} s (${(err as Error).message}); the vote goes on without it`);
      return '';
    }
  };
}
