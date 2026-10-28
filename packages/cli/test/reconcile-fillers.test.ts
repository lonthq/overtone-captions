import { describe, expect, it } from 'vitest';
import { findRegions, phraseKey, type EngineWords, type TextWord } from '../src/reconcile/regions.js';
import { tokenizeDisplay } from '../src/text/normalize.js';

/** Words of `text`, 0.4 s apart from `start`. */
function said(text: string, start: number): TextWord[] {
  return tokenizeDisplay(text).map((t, k) => ({ text: t, start: +(start + k * 0.4).toFixed(3), end: +(start + k * 0.4 + 0.35).toFixed(3) }));
}

describe('fillers in the text vote come from the language packs', () => {
  it('keeps "er" in a Dutch or German phrase key, drops it in English', () => {
    expect(phraseKey('er is niets', 'nl')).toBe('er is niets');
    expect(phraseKey('er kommt morgen', 'de')).toBe('er kommt morgen');
    expect(phraseKey('er is it', 'en')).toBe('is it');
  });

  it('keeps the fillers the global list had, per pack', () => {
    for (const f of ['um', 'umm', 'uh', 'erm', 'er', 'hmm', 'mmm', 'mhm', 'mmhmm', 'mmhm', 'uhhuh', 'ehm']) expect(phraseKey(`${f} yes`, 'en'), f).toBe('yes');
    for (const f of ['äh', 'ähm', 'ehm']) expect(phraseKey(`${f} ja`, 'de'), f).toBe('ja');
    // "um" is a German word ("around")
    expect(phraseKey('um acht', 'de')).toBe('um acht');
  });

  it('lets "er" vote in Dutch and German: an engine that heard it where the text has none disagrees', () => {
    const engine = (words: TextWord[]): EngineWords[] => [{ id: 'a', label: 'A', words }];
    // the engine heard "er" (at 0.8 s) where the text has no word
    const text = (a: string, b: string) => [...said(a, 0), ...said(b, 1.2)];
    expect(findRegions(text('Ik denk', 'niet aan.'), engine(said('Ik denk er niet aan.', 0)), { language: 'nl' }).map((r) => r.heard[0]!.map((w) => w.text).join(' '))).toEqual(['er']);
    expect(findRegions(text('Ich glaube', 'kommt.'), engine(said('Ich glaube er kommt.', 0)), { language: 'de' }).map((r) => r.heard[0]!.map((w) => w.text).join(' '))).toEqual(['er']);
    // in English "er" is a hesitation: it does not vote
    expect(findRegions(text('I think', 'not now.'), engine(said('I think er not now.', 0)), { language: 'en' })).toEqual([]);
  });
});
