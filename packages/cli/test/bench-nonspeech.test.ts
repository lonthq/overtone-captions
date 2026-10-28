// Scoring of the benchmark's non-speech set (bench/lib/nonspeech.mjs).
import { describe, expect, it } from 'vitest';
import { hallucinationRate, scoreNonSpeechClip } from '../../../bench/lib/nonspeech.mjs';

const w = (text: string, start: number) => ({ text, start, end: start + 0.3 });

describe('scoreNonSpeechClip', () => {
  it('counts the words output on a clip without speech, not fillers or punctuation', () => {
    const ref = { nonSpeech: true, duration: 120, words: [] };
    const hyp = { overtone: { words: [] }, azure: { words: [w('Um,', 1), w('thank', 2), w('you.', 2.4)] }, textOnly: { text: 'Thank you for watching!' } };
    expect(scoreNonSpeechClip(ref, hyp, 'en')).toEqual({
      overtone: { words: 0, perMinute: 0 },
      textOnly: { words: 4, perMinute: 2 },
      azure: { words: 2, perMinute: 1 },
    });
  });

  it('on music then speech, counts the words before the speech and scores the rest', () => {
    const ref = { duration: 70, speechStart: 60, words: [{ text: 'Goede' }, { text: 'morgen.' }] };
    const hyp = {
      overtone: { words: [w('Goede', 60.1), w('morgen.', 60.5)] },
      // a word heard in the music, and one just before the speech (within the 0.5 s slack)
      azure: { words: [w('la', 30), w('Goede', 59.7), w('morgen.', 60.2)] },
      textOnly: { text: 'La. Goede morgen.' },
    };
    expect(scoreNonSpeechClip(ref, hyp, 'nl')).toEqual({
      overtone: { wordsBefore: 0, wer: 0, refTokens: 2 },
      textOnly: { wordsBefore: undefined, wer: 0.5, refTokens: 2 },
      azure: { wordsBefore: 1, wer: 0, refTokens: 2 },
    });
  });
});

describe('hallucinationRate', () => {
  it('is the share of non-speech clips with any word, per system', () => {
    const zero = { words: 0 }, some = { words: 3 };
    const rate = hallucinationRate([
      { nonSpeech: true, scores: { overtone: zero, textOnly: some, azure: zero } },
      { nonSpeech: true, scores: { overtone: zero, textOnly: some, azure: some } },
      { scores: { overtone: some, textOnly: some, azure: some } },
    ]);
    expect(rate).toEqual({ overtone: { clips: 2, withWords: 0 }, textOnly: { clips: 2, withWords: 2 }, azure: { clips: 2, withWords: 1 } });
  });
});
