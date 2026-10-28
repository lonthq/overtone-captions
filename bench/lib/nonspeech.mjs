// Scores the non-speech set: no words on audio without speech, and on music then speech, words only from the speech.
// See DATASETS.md (Non-speech set).
import { normalizeWords, wordsFromText } from './normalize.mjs';
import { editDistance } from './wer.mjs';

export const SYSTEMS = ['overtone', 'textOnly', 'azure', 'scribe']; // scribe: only when the run had the second hearing
/** Words that start this long before the speech still count as speech (word times are not exact). */
export const SPEECH_START_SLACK = 0.5;

const wordsOf = (hyp, system) => (system === 'textOnly' ? wordsFromText(hyp.textOnly.text) : hyp[system].words);
const tokens = (words, lang) => normalizeWords(words, lang, 'plain').map((t) => t.t);

/**
 * Per-system scores of one clip. Non-speech: normalized `words` output and `perMinute`. With `speechStart`:
 * `wordsBefore` (starting over SPEECH_START_SLACK s early) and the `wer` of the rest; untimed textOnly gets no
 * `wordsBefore`.
 */
export function scoreNonSpeechClip(ref, hyp, lang) {
  const out = {};
  for (const system of SYSTEMS.filter((s) => s === 'textOnly' || hyp[s])) {
    const words = wordsOf(hyp, system);
    if (ref.nonSpeech) {
      const n = tokens(words, lang).length;
      out[system] = { words: n, perMinute: n / (ref.duration / 60) };
      continue;
    }
    const timed = system !== 'textOnly';
    const cut = ref.speechStart - SPEECH_START_SLACK;
    const before = timed ? words.filter((w) => w.start < cut) : [];
    const speech = timed ? words.filter((w) => !(w.start < cut)) : words;
    const R = tokens(ref.words, lang), H = tokens(speech, lang);
    out[system] = { wordsBefore: timed ? tokens(before, lang).length : undefined, wer: editDistance(R, H) / R.length, refTokens: R.length };
  }
  return out;
}

/** Per system: how many non-speech clips got any words. */
export function hallucinationRate(scored) {
  const ns = scored.filter((s) => s.nonSpeech);
  return Object.fromEntries(SYSTEMS.filter((sys) => ns.length && ns.every((s) => s.scores[sys])).map((sys) => [sys, { clips: ns.length, withWords: ns.filter((s) => s.scores[sys].words > 0).length }]));
}
