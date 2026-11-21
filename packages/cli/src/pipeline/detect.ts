// Without --language: the spoken language from up to three audio samples (spec 2026-11-20), as a step of the extract
// stage. Its requests are cached under that stage, so --from-stage transcribe reuses them.
import { cachedLanguage } from '../cache.js';
import { cutAudio, detectSilences } from '../media/extract.js';
import type { LanguageProvider } from '../providers/types.js';
import { decideLanguage, pickSamples, type LanguageDetection, type SampleHeard } from './audio-language.js';
import type { Plan } from './preflight.js';
import type { Run } from './run.js';
import type { ExtractData } from './types.js';

/** The detection, or undefined when there is no detector or the language is given. */
export async function detectStep(run: Run, provider: LanguageProvider | undefined, audio: ExtractData, plan: Pick<Plan, 'forced' | 'candidates' | 'textFile'>): Promise<LanguageDetection | undefined> {
  if (!provider || plan.forced || plan.candidates || plan.textFile) return undefined;
  const { deps, log } = run;
  return run.step('extract', 'language detection', async () => {
    const silences = await (deps.detectSilences ?? detectSilences)(audio.wav, audio.duration);
    const detector = cachedLanguage(provider, run.requests, 'extract');
    const heard: SampleHeard[] = [];
    for (const span of pickSamples(audio.duration, silences)) {
      const whole = span.start === 0 && span.end >= audio.duration - 0.05;
      const path = whole ? audio.wav : await (deps.cutAudio ?? cutAudio)(audio.wav, span.start, span.end);
      const res = await detector.detect({ path, duration: span.end - span.start });
      heard.push({ ...span, words: res.words });
    }
    const detection = decideLanguage(heard, provider.id);
    const samples = detection.samples!.map((s) => `${s.language ?? '-'} ${s.words}`).join(', ');
    if (detection.language) log.info(`  language: ${detection.language} (detected from the audio by ${provider.id}, ${detection.verdict})${detection.verdict === 'unsure' ? `; samples: ${samples}` : ''}`);
    else log.info(`  language: no speech in the samples (${provider.id}); the engines detect it`);
    log.debug(`language samples: ${samples} words`);
    return detection;
  });
}
