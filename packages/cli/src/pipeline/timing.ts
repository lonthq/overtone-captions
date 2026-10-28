// Stage 3: the whole-file hearings (word times and speakers) of the timing provider and the optional second hearing.
import { cachedTiming, type RequestOptions } from '../cache.js';
import { UserError } from '../errors.js';
import { providerLabel, type EngineHearing } from '../hearings.js';
import type { Providers } from '../providers/registry.js';
import { IMPLAUSIBLE_TRANSCRIPT, isImplausibleTranscript, isRefusal, type AudioFile, type TimingOptions, type TimingProvider } from '../providers/types.js';
import { chooseLanguage } from './language.js';
import type { Plan } from './preflight.js';
import type { Run } from './run.js';
import type { ExtractData, TimingData, TranscribeData } from './types.js';

/**
 * For a snippet re-listen, "no plausible transcript" (Scribe on mostly music) is cached as an answer: no words heard.
 * Not for the whole-file second hearing, where it is a service fault a later run should retry.
 */
export const ANSWER_ERRORS: RequestOptions = { answerErrors: [IMPLAUSIBLE_TRANSCRIPT] };

export interface TimingInput {
  plan: Pick<Plan, 'forced' | 'candidates' | 'sel'>;
  providers: Providers;
  secondTiming?: TimingProvider;
  /** The run's second hearing (secondHearingOnce), shared with the transcribe stage. */
  second?: SecondHearing;
  audio: ExtractData;
  text: TranscribeData;
}

/** The run's whole-file second hearing: sent at most once, by the first stage that needs it. */
export interface SecondHearing {
  id: string;
  heard(): Promise<TimingData | undefined>;
}

/**
 * The second hearing, sent once and shared; undefined without one. It goes with --language (or the candidates), else
 * with none, so an engine that detects the language (ElevenLabs Scribe) does. The transcribe stage waits for it and
 * sends that language to the text provider: gpt-transcribe returns no text at all for some media when it has to
 * detect the language itself.
 */
export function secondHearingOnce(run: Run, provider: TimingProvider | undefined, audio: ExtractData, plan: Pick<Plan, 'forced' | 'candidates'>): SecondHearing | undefined {
  if (!provider) return undefined;
  const cached = cachedTiming(provider, run.requests, 'timing');
  const opts: TimingOptions = { language: plan.forced, ...(plan.candidates ? { languages: plan.candidates } : {}), phrases: run.cfg.glossary };
  let heard: Promise<TimingData | undefined> | undefined;
  return {
    id: provider.id,
    heard: () => {
      heard ??= secondHearing(run, cached, { path: audio.wav, duration: audio.duration }, opts);
      // the stages await it; until then a failure must not count as an unhandled rejection
      heard.catch(() => undefined);
      return heard;
    },
  };
}

export interface Hearings {
  /** The language named to the engines, and where it came from. */
  chosen?: { language: string; source: string };
  /** The run's language once the engines heard it: the chosen one, else the timing provider's. */
  language?: string;
  timing: TimingData;
  second?: TimingData;
  /** With candidate languages: each one's share, as the timing provider heard it. */
  languagesHeard?: Record<string, number>;
  /** What every timing request of the run is sent with, snippet re-listens included. */
  timingOpts: TimingOptions;
  /** The timing provider's hearing (or the text provider's own times), then the second hearing. */
  engines: EngineHearing[];
}

export async function timingStage(run: Run, input: TimingInput): Promise<Hearings> {
  const { log } = run;
  const { plan: { forced, candidates, sel }, providers, secondTiming, second: secondShared, audio, text } = input;
  // Azure's automatic language ID covers only a few locales (no Dutch), so name the language whenever possible:
  // --language > the text provider's language > a stopword guess on the text > none (the service detects).
  const chosen = chooseLanguage(forced, text.chunks);
  if (chosen) log.info(`  language: ${chosen.language} (${chosen.source})${candidates ? `; candidates: ${candidates.join(', ')}` : ''}`);
  const timingProvider = cachedTiming(providers.timing, run.requests, 'timing');
  const timingOpts = { language: chosen?.language, ...(candidates ? { languages: candidates } : {}), phrases: run.cfg.glossary };
  const file: AudioFile = { path: audio.wav, duration: audio.duration };
  const hearings = await run.stage<{ timing: TimingData; second?: TimingData }>('timing', async () => {
    const heardSecond = secondShared?.heard();
    let timing: TimingData;
    if (!sel.timing.same) {
      timing = await timingProvider.align(file, timingOpts);
    } else {
      // --timing same: the text provider's own word times from the transcribe stage (no second call)
      const words = text.chunks.flatMap((c) => c.words ?? []);
      if (words.length === 0 && text.chunks.some((c) => c.text.trim())) {
        throw new UserError(`--timing same: ${sel.text.id} returned no word timings. Re-run with --from-stage transcribe, or pick a timing provider such as azure-speech.`);
      }
      const reported = text.chunks.find((c) => c.language)?.language;
      timing = { words, ...(reported ? { language: reported } : {}) };
    }
    const second = heardSecond ? await heardSecond : undefined;
    if (second) log.info(`  ${secondShared!.id} (second hearing): ${second.words.length} words`);
    return { timing, ...(second ? { second } : {}) };
  });
  const timing = hearings.timing;
  const languagesHeard = candidates && timing.languagesHeard ? timing.languagesHeard : undefined;
  if (languagesHeard) log.info(`  languages heard: ${Object.entries(languagesHeard).map(([code, share]) => `${code} ${Math.round(share * 100)}%`).join(', ')}`);
  const engines: EngineHearing[] = [
    { id: sel.timing.same ? sel.text.id : providers.timing.id, label: providerLabel(sel.timing.same ? sel.text.provider : sel.timing.provider), words: timing.words },
    ...(hearings.second && secondTiming ? [{ id: secondTiming.id, label: providerLabel(secondTiming.id), words: hearings.second.words }] : []),
  ];
  return { chosen, language: chosen?.language ?? timing.language, ...hearings, languagesHeard, timingOpts, engines };
}

/**
 * With --timing same the text provider's own words are the timing hearing. After --two-pass that hearing must match
 * the text being aligned: each chunk's words come from the pass that was kept (`first` or `final`), so second-pass text
 * is never aligned to first-pass times.
 */
export function sameTimingFrom(hearings: Hearings, first: TranscribeData, final: TranscribeData): Hearings {
  if (final.chunks === first.chunks) return hearings;
  const words = final.chunks.flatMap((c, k) => c.words ?? first.chunks[k]?.words ?? []);
  if (words.length === 0) return hearings;
  return {
    ...hearings,
    timing: { ...hearings.timing, words },
    engines: hearings.engines.map((e, i) => (i === 0 ? { ...e, words } : e)),
  };
}

/** The second hearing is optional: on failure the run goes on without it (not cached); a refusal goes to `run.refused`. */
function secondHearing(run: Run, provider: TimingProvider, file: AudioFile, opts: TimingOptions): Promise<TimingData | undefined> {
  return provider.align(file, opts).catch((err: unknown): TimingData | undefined => {
    if (err instanceof UserError) throw err;
    if (isImplausibleTranscript(err)) {
      run.log.info(`  ${provider.id} returned no plausible transcript for the file; taking it as no words heard`);
      return { words: [] };
    }
    // the same request would be refused again: no retry hint; the person sees it in the REFUSED block
    if (isRefusal(err)) {
      run.refused({ provider: err.provider, by: err.by, request: 'the second hearing of the whole file', start: 0, end: file.duration, instead: 'went on without the second hearing' });
      return undefined;
    }
    run.log.warn(`${provider.id} failed (${(err as Error).message}); going on without the second hearing. Run the command again to retry it.`);
    return undefined;
  });
}
