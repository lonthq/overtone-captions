import { describe, expect, it } from 'vitest';
import { buildTurns, endsSentence, flattenTurns, groupTurns } from '../src/turns.js';
import type { AlignedWord } from '../src/types.js';

/** "Hello|S1 world.|S1 Hi|S2" → aligned words, 0.5 s apart. */
function words(spec: string, step = 0.5): AlignedWord[] {
  return spec.split(' ').map((tok, k) => {
    const [text, speaker] = tok.split('|');
    return { text, start: k * step, end: k * step + 0.4, speaker, match: 'exact', confidence: 1 };
  });
}
const shape = (spec: string, step?: number) =>
  buildTurns(words(spec, step)).map((t) => `${t.speaker}: ${t.words.map((w) => w.text).join(' ')}`);

describe('endsSentence', () => {
  it.each([['free.', true], ['part?', true], ['wow!', true], ['so…”', true], ['done.)', true], ['remember:', false], ['Hello,', false],
    ['Dr.', false], ['(Mr.', false], ['U.S.', false], ['e.g.', false], ['bijv.', false], ['J.', false],
    ['Dr.”', false], ['etc.?', true], ['是的。', true], ['好吗？', true], ['نعم؟', true], ['है।', true], ['wait...', true]])(
    '%s → %s',
    (text, expected) => expect(endsSentence(text)).toBe(expected),
  );
});

describe('endsSentence with context', () => {
  it('a single capital + "." is an initial only after a capitalized word or another initial', () => {
    expect(endsSentence('F.', { prev: 'John' })).toBe(false);
    expect(endsSentence('R.', { prev: 'J.' })).toBe(false);
    expect(endsSentence('B.', { prev: 'plan' })).toBe(true);
    expect(endsSentence('C.', { prev: 'vitamin' })).toBe(true);
    expect(endsSentence('B.', { prev: '(plan' })).toBe(true);
    expect(endsSentence('B.', { prev: '“Plan' })).toBe(false);
    expect(endsSentence('J.')).toBe(false); // nothing known about the previous word: stay careful
    expect(endsSentence('J.', {})).toBe(false);
  });

  it('"etc.", "U.S." and "U.K." end a sentence when the next word starts with a capital', () => {
    for (const abbr of ['etc.', 'U.S.', 'U.K.']) {
      expect(endsSentence(abbr, { next: 'Then' })).toBe(true);
      expect(endsSentence(abbr, { next: '“Then' })).toBe(true);
      expect(endsSentence(abbr, { next: 'then' })).toBe(false);
      expect(endsSentence(abbr, { next: '12' })).toBe(false);
      expect(endsSentence(abbr)).toBe(false);
    }
    expect(endsSentence('Dr.', { next: 'Smith' })).toBe(false);
    expect(endsSentence('e.g.', { next: 'Then' })).toBe(false);
  });

  it('the last word of the text ends a sentence, punctuated or not', () => {
    expect(endsSentence('Fine', { last: true })).toBe(true);
    expect(endsSentence('Fine', { last: false })).toBe(false);
    expect(endsSentence('Dr.', { last: true })).toBe(true);
  });
});

describe('buildTurns', () => {
  it('returns no turns for no words', () => {
    expect(buildTurns([])).toEqual([]);
  });

  it('groups consecutive words of one speaker', () => {
    expect(shape('Hello|S1 there.|S1 Hi|S2 Maya.|S2')).toEqual(['S1: Hello there.', 'S2: Hi Maya.']);
  });

  it('copies word fields and computes turn start/end', () => {
    const [t] = buildTurns(words('Hello|S1 there.|S1'));
    expect(t).toEqual({
      speaker: 'S1', start: 0, end: 0.9,
      words: [
        { text: 'Hello', start: 0, end: 0.4, match: 'exact', confidence: 1 },
        { text: 'there.', start: 0.5, end: 0.9, match: 'exact', confidence: 1 },
      ],
    });
  });

  it('moves a late speaker change back to the sentence end', () => {
    // timing says S2 starts at "Yes", but "so." was the end of S1's sentence one word later
    expect(shape('I|S1 think|S1 so.|S2 Yes|S2 indeed.|S2')).toEqual(['S1: I think so.', 'S2: Yes indeed.']);
  });

  it('moves an early speaker change forward to the sentence end', () => {
    expect(shape('I|S1 think|S1 so.|S1 Yes|S1 indeed.|S2 Right.|S2')).toEqual(['S1: I think so.', 'S2: Yes indeed. Right.']);
  });

  it('does not snap further than the window', () => {
    expect(shape('One.|S1 a|S1 b|S1 c|S1 d|S2 e.|S2', 0.5)).toEqual(['S1: One. a b c', 'S2: d e.']);
  });

  it('absorbs a one-word diarization blip inside a sentence', () => {
    expect(shape('we|S1 should|S1 really|S2 go|S1 now.|S1')).toEqual(['S1: we should really go now.']);
  });

  it('keeps a short interjection that is a sentence', () => {
    expect(shape('we|S1 go.|S1 Yeah.|S2 Now|S1 then.|S1')).toEqual(['S1: we go.', 'S2: Yeah.', 'S1: Now then.']);
  });
});

describe('blips never start a turn mid-sentence', () => {
  it('absorbs a stray sentence-final word that is not a complete sentence', () => {
    expect(shape('and|S1 then|S1 we|S1 left.|S2 It|S1 was|S1 late.|S1')).toEqual(['S1: and then we left. It was late.']);
  });

  it('absorbs a stray abbreviation', () => {
    expect(shape('I|S1 met|S1 Dr.|S2 Smith|S1 today.|S1')).toEqual(['S1: I met Dr. Smith today.']);
  });

  it('leaves no fragment when a blip contains an early sentence end', () => {
    expect(shape('we|S1 go.|S2 now|S2 then|S1 ok.|S1')).toEqual(['S1: we go. now then ok.']);
  });

  it('absorbs a blip at the very start', () => {
    expect(shape('Well|S2 I|S1 think|S1 so.|S1')).toEqual(['S1: Well I think so.']);
  });

  it('absorbs a blip at the very end', () => {
    expect(shape('I|S1 think|S1 so|S1 too.|S2')).toEqual(['S1: I think so too.']);
  });

  it('keeps complete-sentence interjections at the start and end', () => {
    expect(shape('Yeah.|S2 I|S1 think|S1 so.|S1')).toEqual(['S2: Yeah.', 'S1: I think so.']);
    expect(shape('we|S1 go.|S1 Yeah.|S2')).toEqual(['S1: we go.', 'S2: Yeah.']);
  });

  it('keeps a Yes/No exchange', () => {
    expect(shape('Yes.|S1 No.|S2 Yes.|S1 No.|S2')).toEqual(['S1: Yes.', 'S2: No.', 'S1: Yes.', 'S2: No.']);
  });

  it('merges a blip between different speakers into the side it continues', () => {
    expect(shape('I|S1 agree.|S1 but|S2 the|S3 cost|S3 is|S3 high.|S3')).toEqual(['S1: I agree.', 'S3: but the cost is high.']);
    expect(shape('we|S1 all|S1 agree|S1 so.|S2 the|S3 cost|S3 is|S3 high.|S3')).toEqual(['S1: we all agree so.', 'S3: the cost is high.']);
  });

  it('does not snap a boundary onto an abbreviation', () => {
    expect(shape('Hi.|S1 the|S1 U.S.|S1 economy|S1 is|S2 big.|S2')).toEqual(['S1: Hi. the U.S. economy', 'S2: is big.']);
    expect(shape('Hi.|S1 the|S1 U.S.|S1 economy|S1 is|S2 very|S2 big.|S2')).toEqual(['S1: Hi. the U.S. economy', 'S2: is very big.']);
  });
});

describe('sentence ends in turn building', () => {
  it('"plan B." and "vitamin C." end a sentence, "John F." does not', () => {
    expect(shape('Yes.|S1 vitamin|S2 C.|S2 Fine.|S1')).toEqual(['S1: Yes.', 'S2: vitamin C.', 'S1: Fine.']);
    expect(shape('Yes.|S1 John|S2 F.|S2 Fine.|S1')).toEqual(['S1: Yes. John F. Fine.']);
    expect(shape('Yes.|S1 J.|S2 R.|S2 Fine.|S1')).toEqual(['S1: Yes. J. R. Fine.']);
  });

  it('"etc." and "U.S." end a sentence before a capitalized word only', () => {
    expect(shape('Yes.|S1 cats|S2 etc.|S2 Fine.|S1')).toEqual(['S1: Yes.', 'S2: cats etc.', 'S1: Fine.']);
    expect(shape('Yes.|S1 the|S2 U.S.|S2 Fine.|S1')).toEqual(['S1: Yes.', 'S2: the U.S.', 'S1: Fine.']);
    expect(shape('Yes.|S1 the|S2 U.S.|S2 economy|S1 grows.|S1')).toEqual(['S1: Yes. the U.S. economy grows.']);
  });

  it('keeps a final unpunctuated one-word reply as its own turn', () => {
    expect(shape('How|S1 are|S1 you?|S1 Fine|S2')).toEqual(['S1: How are you?', 'S2: Fine']);
  });

  it('still absorbs a stray last word that continues an unfinished sentence', () => {
    expect(shape('I|S1 think|S1 so|S1 too|S2')).toEqual(['S1: I think so too']);
  });

  it('maxBlipWords: 0 turns edge smoothing off', () => {
    const spec = 'I|S1 think|S1 so|S1 too.|S2';
    expect(buildTurns(words(spec)).map((t) => t.speaker)).toEqual(['S1']);
    expect(buildTurns(words(spec), { maxBlipWords: 0 }).map((t) => t.speaker)).toEqual(['S1', 'S2']);
    const mid = 'we|S1 should|S1 really|S2 go|S1 now.|S1';
    expect(buildTurns(words(mid), { maxBlipWords: 0 }).map((t) => t.speaker)).toEqual(['S1', 'S2', 'S1']);
  });
});

describe('flattenTurns / groupTurns', () => {
  it('round-trips', () => {
    const turns = buildTurns(words('Hello|S1 there.|S1 Hi|S2 Maya.|S2 Bye.|S1'));
    const flat = flattenTurns(turns);
    expect(flat.map((w) => `${w.speaker}:${w.text}`)).toEqual(['S1:Hello', 'S1:there.', 'S2:Hi', 'S2:Maya.', 'S1:Bye.']);
    expect(groupTurns(flat)).toEqual(turns);
    expect(groupTurns([])).toEqual([]);
  });
});
