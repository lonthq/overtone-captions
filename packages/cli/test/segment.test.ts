import { readFileSync } from 'node:fs';
import { DEFAULT_PROFILES } from 'overtone-format';
import { describe, expect, it } from 'vitest';
import type { ResolvedProfile } from '../src/config.js';
import { breakCost, noBreakAfter, numberGroupEnds, plain } from '../src/segment/groups.js';
import { buildProfile, checkCues, timeCues } from '../src/segment/profile.js';
import { layoutLines, lineLength, splitBlock, type SplitContext } from '../src/segment/splitter.js';
import { tokenizeDisplay } from '../src/text/normalize.js';
import { flattenTurns, type SpeakerWord } from '../src/turns.js';
import { talk } from './helpers.js';

const H: ResolvedProfile = { id: 'horizontal', ...DEFAULT_PROFILES.horizontal };
const V: ResolvedProfile = { id: 'vertical', ...DEFAULT_PROFILES.vertical };
const GLOSSARY = ['DriveCover', 'Lumora', 'Lumora Insurance'];

/** Words of `text` spoken by `speaker`, `rate` s per word with a 0.05 s gap, starting at `start`. */
function speak(text: string, speaker = 'S1', start = 0, rate = 0.4): SpeakerWord[] {
  return tokenizeDisplay(text).map((t, k) => ({ text: t, start: +(start + k * rate).toFixed(3), end: +(start + k * rate + rate - 0.05).toFixed(3), speaker }));
}
const cut = (words: SpeakerWord[], spec: ResolvedProfile, language = 'en', glossary: string[] = []) =>
  buildProfile(words, spec, { language, glossary, duration: Math.ceil(words.at(-1)!.end + 1) }).profile.cues;
const cueTexts = (cues: ReturnType<typeof cut>) => cues.map((c) => c.lines.map((l) => l.text).join(' / '));

const SCRIPT = [
  speak('Every year, one in five drivers has some kind of car damage.', 'S1', 0),
  speak('With DriveCover from Lumora, you’re insured from day one, for just $12 a month.', 'S1', 5),
  speak('And the best part? You can claim directly in the app.', 'S2', 11),
  speak('So remember: DriveCover. Drive worry-free.', 'S1', 16),
].flat();

const lines = (words: SpeakerWord[], spec: ResolvedProfile) =>
  buildProfile(words, spec, { language: 'en', glossary: GLOSSARY, duration: 19 }).profile.cues.map((c) => c.lines.map((l) => l.text));

describe('groups', () => {
  it('compares apostrophes and accents the way the comparison keys do', () => {
    expect(plain('Weʼre')).toBe("we're"); // modifier-letter apostrophe
    expect(plain('We´re')).toBe("we're");
    expect(plain('e\u0301e\u0301n')).toBe('één'); // typed with combining accents
    expect(plain("'t")).toBe("'t"); // a Dutch clitic keeps its apostrophe
  });

  it('strips punctuation for comparisons', () => {
    expect(plain('Month.')).toBe('month');
    expect(plain("M'n")).toBe("m'n");
    expect(plain('“Drive')).toBe('drive');
  });

  it('keeps number groups, glossary terms and names together', () => {
    const t = tokenizeDisplay('for just €12 a month, one in five drivers, Maya Jones of Lumora Insurance said');
    const keep = noBreakAfter(t, 'en', GLOSSARY);
    const kept = t.map((w, i) => (keep[i] ? `${w}+` : w)).join(' ');
    expect(kept).toBe('for just €12+ a+ month, one+ in+ five drivers, Maya+ Jones of Lumora+ Insurance said');
  });

  it('ends a number group at a comma: the words after it are a new clause', () => {
    const t = tokenizeDisplay('I paid €12, a month later one, in five years');
    const keep = noBreakAfter(t, 'en', []);
    expect(t.map((w, i) => (keep[i] ? `${w}+` : w)).join(' ')).toBe('I paid €12, a month later one, in five years');
  });

  it('keeps Dutch number groups together', () => {
    const t = tokenizeDisplay('voor twaalf euro per maand, één op de vijf bestuurders');
    const keep = noBreakAfter(t, 'nl', []);
    expect(t.map((w, i) => (keep[i] ? `${w}+` : w)).join(' ')).toBe('voor twaalf+ euro+ per+ maand, één+ op+ de+ vijf bestuurders');
  });

  const marked = (text: string, lang: 'en' | 'nl' = 'en') => {
    const t = tokenizeDisplay(text);
    const keep = noBreakAfter(t, lang, []);
    return t.map((w, i) => (keep[i] ? `${w}+` : w)).join(' ');
  };

  it('keeps names with lowercase particles together', () => {
    expect(marked('Gisteren sprak Jan de Vries met Maya van der Berg over de zaak', 'nl')).toBe('Gisteren sprak Jan+ de+ Vries met Maya+ van+ der+ Berg over de zaak');
    expect(marked('Yesterday our colleague Dr. Maya van der Berg met us')).toBe('Yesterday our colleague Dr.+ Maya+ van+ der+ Berg met us');
  });

  it('keeps a name at the start of a sentence together', () => {
    expect(marked('Maya Jones said hello.')).toBe('Maya+ Jones said hello.');
    expect(marked('It ended. Jan de Vries left.', 'nl')).toBe('It ended. Jan+ de+ Vries left.');
  });

  it('does not over-join sentence-initial function words with a name', () => {
    expect(marked('Yesterday Maya Jones left.')).toBe('Yesterday Maya+ Jones left.');
    expect(marked('Thanks Tom, that helps.')).toBe('Thanks Tom, that helps.');
    expect(marked('Today Maya Jones left.')).toBe('Today Maya+ Jones left.');
    expect(marked('De Koning van Nederland sprak.', 'nl')).toBe('De Koning+ van+ Nederland sprak.');
    expect(marked('Gisteren Maya Jones vertrok.', 'nl')).toBe('Gisteren Maya+ Jones vertrok.');
  });

  it('does not treat brands from the glossary or all-caps words as name parts', () => {
    const t = tokenizeDisplay('Met DriveCover van Lumora ben je verzekerd.');
    expect(noBreakAfter(t, 'nl', GLOSSARY).some(Boolean)).toBe(false);
    expect(marked('THIS IS A LOUD SENTENCE')).toBe('THIS IS A LOUD SENTENCE');
    expect(marked('We met NASA Johnson Space today')).toBe('We met NASA Johnson+ Space today');
  });

  it('caps a run of capitalized words at four', () => {
    expect(marked('Wir sahen Haus Auto Baum Tisch Stuhl Lampe heute', 'en')).toBe('Wir sahen Haus+ Auto+ Baum+ Tisch Stuhl+ Lampe heute');
  });

  it('still groups real names mid-sentence', () => {
    expect(noBreakAfter(tokenizeDisplay('We saw Lumora Insurance today'), 'en', GLOSSARY).filter(Boolean)).toHaveLength(1);
    expect(marked('Hij zag Jan de Vries gisteren', 'nl')).toBe('Hij zag Jan+ de+ Vries gisteren');
  });

  it('does not join a particle that is not followed by a capitalized word', () => {
    expect(marked('Maya van het kantoor belde')).toBe('Maya van het kantoor belde');
    expect(marked('I said Maya, de Vries was there')).toBe('I said Maya, de Vries was there');
  });

  it('ranks break points', () => {
    const t = tokenizeDisplay('It works. Sure, and then the app');
    const keep = t.map(() => false);
    expect([0, 1, 2, 3, 4, 5, 6].map((i) => breakCost({ texts: t, keep, lang: 'en' }, i))).toEqual([12, 0, 1, 14, 4, 24, 4]);
  });
});

describe('layoutLines', () => {
  const ctxFor = (text: string, max = 22, maxLines = 2): SplitContext => {
    const texts = tokenizeDisplay(text);
    return { texts, starts: texts.map((_, i) => i), ends: texts.map((_, i) => i + 0.9), keep: noBreakAfter(texts, 'en', []), lang: 'en', rules: { maxCharsPerLine: max, maxLines } };
  };

  it('uses one line when it fits', () => {
    expect(layoutLines(ctxFor('You can claim it.'), 0, 3)).toEqual({ lines: [[0, 3]], cost: 0 });
  });

  it('never ends a line on an article or preposition', () => {
    const ctx = ctxFor('You can claim directly in the app');
    const res = layoutLines(ctx, 0, 6)!;
    const text = res.lines.map(([a, b]) => ctx.texts.slice(a, b + 1).join(' '));
    expect(text).toEqual(['You can claim', 'directly in the app']);
  });

  it('balances two lines (bottom may be longer)', () => {
    const ctx = ctxFor('one two three four five six seven eight', 30);
    const res = layoutLines(ctx, 0, 7)!;
    const lens = res.lines.map(([a, b]) => lineLength(ctx.texts, a, b));
    expect(Math.abs(lens[0] - lens[1])).toBeLessThanOrEqual(6);
    expect(lens[1]).toBeGreaterThanOrEqual(lens[0]);
  });

  it('returns null when the words cannot fit in maxLines', () => {
    expect(layoutLines(ctxFor('aaaa bbbb cccc dddd eeee ffff', 9, 2), 0, 5)).toBeNull();
  });

  it('puts an over-long single word on its own line', () => {
    expect(layoutLines(ctxFor('Supercalifragilisticexpialidocious', 10), 0, 0)).toEqual({ lines: [[0, 0]], cost: 0 });
  });
});

describe('buildProfile (deterministic)', () => {
  it('cuts the sample script for horizontal within all hard rules', () => {
    const { profile } = buildProfile(SCRIPT, H, { language: 'en', glossary: GLOSSARY, duration: 19 });
    expect(checkCues(profile.cues, SCRIPT, H.rules).filter((v) => v.rule !== 'maxCps')).toEqual([]);
    expect(profile).toMatchObject({ id: 'horizontal', description: 'TV/desktop', rules: H.rules });
  });

  it('cuts the sample script for vertical without splitting groups or ending lines on stopwords', () => {
    const all = lines(SCRIPT, V).flat();
    for (const l of all) {
      expect(l.length).toBeLessThanOrEqual(22);
      expect(['a', 'an', 'the', 'in', 'for', 'from', 'of', 'with']).not.toContain(plain(l.split(' ').at(-1)!));
    }
    const joined = all.join(' | ');
    expect(joined).toContain('one in five');
    expect(joined).toContain('$12 a month.');
    expect(joined).toMatch(/in the app\./);
    expect(checkCues(buildProfile(SCRIPT, V, { language: 'en', glossary: GLOSSARY, duration: 19 }).profile.cues, SCRIPT, V.rules).filter((v) => v.rule !== 'maxCps')).toEqual([]);
  });

  it('never lets a cue cross a speaker change', () => {
    const { profile } = buildProfile(SCRIPT, H, { language: 'en', glossary: GLOSSARY, duration: 19 });
    for (const cue of profile.cues) {
      for (const l of cue.lines) for (let w = l.words[0]; w <= l.words[1]; w++) expect(SCRIPT[w].speaker).toBe(cue.speaker);
    }
    expect(profile.cues.some((c) => c.speaker === 'S2')).toBe(true);
  });

  it('respects maxDuration on a long monologue', () => {
    const words = speak(Array.from({ length: 60 }, (_, i) => `word${i}`).join(' '), 'S1', 0, 0.5);
    const { profile } = buildProfile(words, H, { language: 'en', glossary: [], duration: 40 });
    for (const c of profile.cues) expect(c.end - c.start).toBeLessThanOrEqual(7);
    expect(checkCues(profile.cues, words, H.rules).filter((v) => v.rule === 'maxDuration' || v.rule === 'overlap' || v.rule === 'coverage')).toEqual([]);
  });

  it('extends short cues to the minimum duration, but not into the next cue', () => {
    const words: SpeakerWord[] = [
      { text: 'Yes.', start: 1, end: 1.2, speaker: 'S1' },
      { text: 'No.', start: 1.5, end: 1.7, speaker: 'S2' },
      { text: 'Okay.', start: 5, end: 5.2, speaker: 'S1' },
    ];
    const cues = timeCues([{ lines: [[0, 0]] }, { lines: [[1, 1]] }, { lines: [[2, 2]] }], words, H.rules, 10);
    expect(cues.map((c) => [c.start, c.end])).toEqual([[1, 1.5], [1.5, 2.5], [5, 6]]);
  });

  it('keeps cues valid for zero-length words at the same time', () => {
    const words: SpeakerWord[] = [
      { text: 'a', start: 2, end: 2, speaker: 'S1' },
      { text: 'b', start: 2, end: 2, speaker: 'S2' },
    ];
    const cues = timeCues([{ lines: [[0, 0]] }, { lines: [[1, 1]] }], words, H.rules, 10);
    expect(cues.map((c) => [c.start, c.end])).toEqual([[2, 2.001], [2.001, 3.001]]);
  });

  describe('holding a cue into the silence after it (minimum display time)', () => {
    // 60 characters: 3.53 s of reading time at 17 characters per second, spoken in 1 s
    const fast = (next: number, nextSpeaker = 'S1', match?: 'interpolated'): SpeakerWord[] => [
      { text: 'Everything we planned for this launch went', start: 0, end: 0.5, speaker: 'S1' },
      { text: 'wrong at once.', start: 0.55, end: 1, speaker: 'S1' },
      { text: 'Next.', start: next, end: next + 0.4, speaker: nextSpeaker, ...(match ? { match } : {}) },
    ];
    const layouts = [{ lines: [[0, 1]] as Array<[number, number]> }, { lines: [[2, 2]] as Array<[number, number]> }];

    it('holds a fast cue at most 1.5 s past its last word', () => {
      const cues = timeCues(layouts, fast(5), H.rules, 10);
      expect(cues[0]).toMatchObject({ start: 0, end: 2.5 });
    });

    it('keeps 0.4 s of a pause of 1 s or more blank, also before another speaker', () => {
      expect(timeCues(layouts, fast(2.2), H.rules, 10)[0]!.end).toBe(1.8);
      expect(timeCues(layouts, fast(2.2, 'S2'), H.rules, 10)[0]!.end).toBe(1.8);
      // exactly 1 s of silence: 0.6 s of it is used, 0.4 s stays blank
      expect(timeCues(layouts, fast(2), H.rules, 10)[0]!.end).toBe(1.6);
    });

    it('may run up to the next cue after a pause under 1 s, or next to a word with an unknown time', () => {
      expect(timeCues(layouts, fast(1.9), H.rules, 10)[0]!.end).toBe(1.9);
      expect(timeCues(layouts, fast(1.9, 'S2'), H.rules, 10)[0]!.end).toBe(1.9);
      expect(timeCues(layouts, fast(2.2, 'S1', 'interpolated'), H.rules, 10)[0]!.end).toBe(2.2);
    });

    it('holds only as long as needed, rounded up to the millisecond, and never moves a start', () => {
      const words: SpeakerWord[] = [
        { text: "You're a jerk, Thom.", start: 23.22, end: 24.32, speaker: 'S1' },
        { text: 'Look.', start: 27, end: 27.3, speaker: 'S2' },
      ];
      const cues = timeCues([{ lines: [[0, 0]] }, { lines: [[1, 1]] }], words, H.rules, 30);
      // 20 characters need 1.1765 s: 24.397, not 24.396 (that would still be over 17 characters per second)
      expect(cues.map((c) => [c.start, c.end])).toEqual([[23.22, 24.397], [27, 28]]);
      expect(20 / (cues[0]!.end - cues[0]!.start)).toBeLessThanOrEqual(17);
    });

    it('never runs past the end of the media or beyond maxDuration', () => {
      expect(timeCues(layouts.slice(0, 1), fast(5).slice(0, 2), H.rules, 1.7)[0]!.end).toBe(1.7);
      const long: SpeakerWord[] = [{ text: 'a', start: 0, end: 6.8, speaker: 'S1' }, { text: 'b', start: 9, end: 9.2, speaker: 'S1' }];
      expect(timeCues([{ lines: [[0, 0]] }, { lines: [[1, 1]] }], long, { ...H.rules, maxCps: 0.1 }, 10)[0]!.end).toBe(7);
    });
  });

  describe('tiny gaps between cues', () => {
    const pair = (gap: number, second = 'S1'): SpeakerWord[] => [
      { text: 'First.', start: 0, end: 1, speaker: 'S1' },
      { text: 'Second.', start: +(1 + gap).toFixed(3), end: +(2 + gap).toFixed(3), speaker: second },
    ];
    const layouts = [{ lines: [[0, 0]] as Array<[number, number]> }, { lines: [[1, 1]] as Array<[number, number]> }];

    it('closes a gap under 0.1 s between cues of the same speaker', () => {
      const cues = timeCues(layouts, pair(0.05), H.rules, 10);
      expect(cues.map((c) => [c.start, c.end])).toEqual([[0, 1.05], [1.05, 2.05]]);
    });

    it('leaves a gap between cues of different speakers', () => {
      const cues = timeCues(layouts, pair(0.05, 'S2'), H.rules, 10);
      expect(cues.map((c) => [c.start, c.end])).toEqual([[0, 1], [1.05, 2.05]]);
    });

    it('leaves a gap of 0.3 s', () => {
      const cues = timeCues(layouts, pair(0.3), H.rules, 10);
      expect(cues.map((c) => [c.start, c.end])).toEqual([[0, 1], [1.3, 2.3]]);
    });

    it('keeps cue durations within maxDuration', () => {
      const words: SpeakerWord[] = [
        { text: 'Long', start: 0, end: 6.97, speaker: 'S1' },
        { text: 'next', start: 7.02, end: 8, speaker: 'S1' },
      ];
      const cues = timeCues(layouts, words, H.rules, 10);
      expect(cues[0].end).toBe(6.97);
    });

    it('closes tiny gaps in a built profile without overlap or speaker crossing', () => {
      const { profile } = buildProfile(SCRIPT, V, { language: 'en', glossary: GLOSSARY, duration: 19 });
      expect(checkCues(profile.cues, SCRIPT, V.rules).filter((v) => v.rule === 'overlap' || v.rule === 'speaker' || v.rule === 'coverage')).toEqual([]);
      profile.cues.forEach((c, i) => {
        const next = profile.cues[i + 1];
        if (next && next.speaker === c.speaker) expect(next.start - c.end >= 0.1 || next.start === c.end).toBe(true);
      });
    });
  });

  it('never extends past the media duration', () => {
    const words: SpeakerWord[] = [{ text: 'End.', start: 9.8, end: 9.9, speaker: 'S1' }];
    expect(timeCues([{ lines: [[0, 0]] }], words, H.rules, 10)[0].end).toBe(10);
  });

  it('splits a block into cues of at most maxLines lines', () => {
    const words = speak('This is a rather long sentence that will certainly need more than one vertical caption cue to show.', 'S1', 0, 0.25);
    const ctx: SplitContext = { texts: words.map((w) => w.text), starts: words.map((w) => w.start), ends: words.map((w) => w.end), keep: words.map(() => false), lang: 'en', rules: V.rules };
    const layouts = splitBlock(ctx, 0, words.length - 1);
    expect(layouts.length).toBeGreaterThan(1);
    for (const c of layouts) expect(c.lines.length).toBeLessThanOrEqual(2);
  });
});

describe('buildProfile with LLM proposals', () => {
  const words = speak('And the best part? You can claim directly in the app.', 'S2', 9);

  it('uses a proposal that satisfies the hard rules', () => {
    // a valid but unusual cut: one cue, lines "And the best part? You can claim" / "directly in the app."
    const res = buildProfile(words, H, { language: 'en', glossary: [], duration: 19, proposal: { cueStarts: [0], lineStarts: [7] } });
    expect(res.fromProposal).toBe(1);
    expect(res.profile.cues[0].lines.map((l) => l.text)).toEqual(['And the best part? You can claim', 'directly in the app.']);
  });

  it('repairs a proposal that breaks a hard rule', () => {
    const res = buildProfile(words, V, { language: 'en', glossary: [], duration: 19, proposal: { cueStarts: [0], lineStarts: [] } });
    expect(res.fromProposal).toBe(0);
    for (const c of res.profile.cues) for (const l of c.lines) expect(l.text.length).toBeLessThanOrEqual(22);
  });

  it('forces a cue start at every speaker change', () => {
    const res = buildProfile(SCRIPT, H, { language: 'en', glossary: GLOSSARY, duration: 19, proposal: { cueStarts: [0], lineStarts: [] } });
    expect(res.blocks).toBe(3);
    expect(checkCues(res.profile.cues, SCRIPT, H.rules).filter((v) => v.rule === 'speaker' || v.rule === 'coverage')).toEqual([]);
  });
});

describe('proposal acceptance', () => {
  const text = 'And the best part? You can claim directly in the app. Drive worry-free.';
  const words = speak(text, 'S1', 0);
  const propose = (proposal: { cueStarts: number[]; lineStarts: number[] }, spec = H) =>
    buildProfile(words, spec, { language: 'en', glossary: [], duration: 19, proposal });
  const texts = (r: ReturnType<typeof propose>) => r.profile.cues.map((c) => c.lines.map((l) => l.text).join(' / '));

  it('keeps the good cues of a proposal and re-cuts only the bad one', () => {
    // cue 2 ends its first line on "in": rejected; cues 1 and 3 are valid: kept
    const res = propose({ cueStarts: [0, 4, 11], lineStarts: [9] });
    expect(texts(res)).toEqual(['And the best part?', 'You can claim directly in the app.', 'Drive worry-free.']);
    expect(res).toMatchObject({ proposalCues: 2, repairedCues: 1, fromProposal: 0 });
  });

  it('rejects a cue break inside a number group', () => {
    const w = speak('So for just €12 a month you get the app.', 'S1', 0);
    const res = buildProfile(w, H, { language: 'en', glossary: [], duration: 19, proposal: { cueStarts: [0, 4], lineStarts: [] } });
    expect(res.fromProposal).toBe(0);
    expect(res.profile.cues.map((c) => c.lines.map((l) => l.text).join(' '))).not.toContain('So for just €12');
  });

  it('rejects a line that ends on a stopword', () => {
    const res = propose({ cueStarts: [0, 4, 11], lineStarts: [2] });
    expect(res.fromProposal).toBe(0);
    expect(texts(res)).toEqual(['And the best part?', 'You can claim directly in the app.', 'Drive worry-free.']);
  });

  it('ignores fractional indices', () => {
    for (const proposal of [{ cueStarts: [3.5], lineStarts: [] }, { cueStarts: [], lineStarts: [2.5] }, { cueStarts: [Number.NaN], lineStarts: [] }]) {
      const res = propose(proposal, V);
      expect(checkCues(res.profile.cues, words, V.rules).filter((v) => v.rule !== 'maxCps')).toEqual([]);
    }
  });
});

describe('proposals and pauses', () => {
  const words = talk('The answer is forty two and that is final.', 'S1', 0, { 5: 3 });

  it('re-cuts a proposed cue that spans a long pause', () => {
    const res = buildProfile(words, H, { language: 'en', glossary: [], duration: 20, proposal: { cueStarts: [0], lineStarts: [] } });
    expect(res.fromProposal).toBe(0);
    expect(cueTexts(res.profile.cues)).toEqual(['The answer is forty two', 'and that is final.']);
  });

  it('keeps the other proposed cues when only one spans a pause', () => {
    const more = [...words, ...talk('Drive worry-free.', 'S1', words.at(-1)!.end + 0.4)];
    const res = buildProfile(more, H, { language: 'en', glossary: [], duration: 30, proposal: { cueStarts: [0, 9], lineStarts: [] } });
    expect(cueTexts(res.profile.cues)).toEqual(['The answer is forty two', 'and that is final.', 'Drive worry-free.']);
    expect(res.proposalCues).toBe(1);
  });

  it('reports a pause violation', () => {
    const cue = [{ start: 0, end: 9, speaker: 'S1', lines: [{ words: [0, words.length - 1] as [number, number], text: 'x' }] }];
    expect(checkCues(cue, words, H.rules).map((v) => v.rule)).toContain('pause');
  });
});

describe('cue end clamp', () => {
  it('never extends a cue beyond maxDuration', () => {
    const rules = { maxCharsPerLine: 42, maxLines: 2, maxCps: 10, maxDuration: 2 };
    const words = speak('This sentence is long enough to need extra time', 'S1', 0, 0.2);
    const cues = timeCues([{ lines: [[0, words.length - 1]] }], words, rules, 30);
    expect(cues[0].end - cues[0].start).toBeLessThanOrEqual(2);
  });
});

describe('checkCues', () => {
  it('reports every hard-rule violation', () => {
    const words = speak('aaaa bbbb cccc', 'S1', 0, 1);
    words[2].speaker = 'S2';
    const bad = [
      { start: 0, end: 9, speaker: 'S1', lines: [{ words: [0, 1] as [number, number], text: 'aaaa bbbb' }, { words: [2, 2] as [number, number], text: 'cccc' }, { words: [2, 2] as [number, number], text: 'cccc' }] },
    ];
    const rules = { maxCharsPerLine: 5, maxLines: 2, maxDuration: 7, minDuration: 1, maxCps: 17 };
    expect(checkCues(bad, words, rules).map((v) => v.rule)).toEqual(['maxLines', 'maxCharsPerLine', 'speaker', 'coverage', 'speaker', 'maxDuration']);
  });
});

describe('fixture timings', () => {
  const doc = JSON.parse(readFileSync(new URL('../../../examples/fixtures/sample.overtone.json', import.meta.url), 'utf8'));
  const words = flattenTurns(doc.turns);
  const fixtureCues = (spec: ResolvedProfile) => cueTexts(buildProfile(words, spec, { language: 'en', glossary: GLOSSARY, duration: doc.duration }).profile.cues);

  it('cuts the vertical profile like the hand-made fixture where it matters', () => {
    const texts = fixtureCues(V);
    expect(texts).toContain('With DriveCover / from Lumora,');
    expect(texts).toContain("you're insured / from day one,");
    expect(texts).toContain('for just $12 a month.');
    expect(texts.join(' | ')).toContain('one in five drivers');
  });

  it('cuts the horizontal profile at clause boundaries', () => {
    const texts = fixtureCues(H);
    expect(texts).toContain("With DriveCover from Lumora, / you're insured from day one,");
    expect(texts).toContain('for just $12 a month.');
  });
});

describe('pauses', () => {
  it.each([['horizontal', H], ['vertical', V]] as const)('starts a new cue at a long pause inside a sentence (%s)', (_, spec) => {
    const words = talk('The answer is forty two and that is final.', 'S1', 0, { 5: 3 });
    const texts = cueTexts(cut(words, spec));
    expect(texts.join(' | ')).toContain('forty two | and');
    expect(texts.length).toBeGreaterThan(1);
  });

  it('keeps a pause shorter than a hesitation (the 0.4 s floor of rule set 1) inside the line', () => {
    // a 1 s pause would start a cue (see cutting.test.ts, "pauses show hesitations")
    const words = talk('The answer is forty two and that is final.', 'S1', 0, { 5: 0.3 });
    expect(cueTexts(cut(words, H))).toEqual(['The answer is forty two and that is final.']);
  });
});

describe('names in captions', () => {
  it('never splits Dutch names across lines or cues (vertical)', () => {
    const words = talk('Gisteren sprak Jan de Vries met Maya van der Berg over de nieuwe verzekering.', 'S1', 0);
    const texts = cueTexts(cut(words, V, 'nl'));
    const flat = texts.join(' | ');
    for (const name of ['Jan de Vries', 'Maya van der Berg']) expect(flat.replace(/ [|/] /g, ' ')).toContain(name);
    expect(flat).not.toMatch(/Jan( \/ | \| )de|de( \/ | \| )Vries|Maya( \/ | \| )van|van( \/ | \| )der|der( \/ | \| )Berg/);
  });

  it('never splits an English name with particles (vertical)', () => {
    const words = talk('Yesterday our colleague Dr. Maya van der Berg met Jan Jones and Sarah Smith at noon.', 'S1', 0);
    const flat = cueTexts(cut(words, V)).join(' | ');
    expect(flat).not.toMatch(/Dr\.( \/ | \| )Maya|Maya( \/ | \| )van|van( \/ | \| )der|der( \/ | \| )Berg|Jan( \/ | \| )Jones|Sarah( \/ | \| )Smith/);
  });
});

describe('soft break preferences', () => {
  it('does not leave a one-word cue when it fits its neighbour', () => {
    const words = talk('Je kunt de schade direct in de app melden.', 'S1', 0);
    const texts = cueTexts(cut(words, V, 'nl'));
    expect(texts.every((t) => t.includes(' '))).toBe(true);
  });

  it('only penalizes a break right after a number group, not after a name', () => {
    const t = tokenizeDisplay('Maya Jones said one in five drivers');
    const keep = noBreakAfter(t, 'en', []);
    const tails = numberGroupEnds(t, 'en');
    expect(breakCost({ texts: t, keep, lang: 'en', tails }, 1)).toBe(4);
    expect(breakCost({ texts: t, keep, lang: 'en', tails }, 5)).toBe(7);
  });

  it('never ends a horizontal line on "vanaf"', () => {
    const words = talk('Met DriveCover van Lumora ben je vanaf de eerste dag verzekerd,', 'S1', 0);
    const ends = cut(words, H, 'nl', GLOSSARY).flatMap((c) => c.lines.map((l) => plain(l.text.split(' ').at(-1)!)));
    expect(ends).not.toContain('vanaf');
  });

  it.each([['nl', 'vanaf tijdens binnen zoals naast rond langs sinds tot via volgens'], ['en', 'until since across around among toward towards via per']])('knows the %s line-end words', (lang, list) => {
    const t = [...list.split(' '), 'x'];
    for (let i = 0; i < t.length - 1; i++) expect(breakCost({ texts: t, keep: t.map(() => false), lang: lang as 'en' | 'nl' }, i)).toBe(24);
  });

  it('keeps a one-word cue that is isolated by pauses', () => {
    const words = [...talk('Wait.', 'S1', 0), ...talk('That is not what we agreed on at all.', 'S1', 4)];
    expect(cueTexts(cut(words, H))[0]).toBe('Wait.');
  });

  it('starts a line with a coordinating conjunction rather than ending on it', () => {
    const words = talk('We tested the whole thing carefully and then we shipped it', 'S1', 0);
    const ends = cut(words, V).flatMap((c) => c.lines.map((l) => plain(l.text.split(' ').at(-1)!)));
    expect(ends).not.toContain('and');
  });

  it('does not strand the noun after a number group on the next cue', () => {
    const words = talk('Every year, one in five drivers has some kind of car damage.', 'S1', 0);
    expect(cueTexts(cut(words, V)).join(' | ')).toContain('one in five drivers');
  });
});

describe('pauses next to words with an unknown time', () => {
  // "Hello there." and "See you." heard; "Go now" no engine heard, placed in the middle of a 4 s gap
  const words: SpeakerWord[] = [
    { text: 'Hello', start: 1, end: 1.3, speaker: 'S1' }, { text: 'there.', start: 1.3, end: 1.7, speaker: 'S1' },
    { text: 'Go', start: 3.3, end: 3.5, speaker: 'S1', match: 'interpolated', confidence: 0 }, { text: 'now', start: 3.5, end: 3.8, speaker: 'S1', match: 'interpolated', confidence: 0 },
    { text: 'See', start: 5.6, end: 5.8, speaker: 'S1' }, { text: 'you.', start: 5.8, end: 6.1, speaker: 'S1' },
  ];
  const spec = H;
  const cuesOf = (untimed?: boolean[]) => buildProfile(words, spec, { language: 'en', glossary: [], duration: 10, ...(untimed ? { untimed } : {}) }).profile.cues.map((c) => c.lines.map((l) => l.text).join(' / '));

  it('are no pauses: the gaps next to them are where they were placed, so they force no new cue', () => {
    // read as pauses (1.6 s and 1.8 s, over the 1.5 s force threshold) they split the line three times
    expect(cuesOf()).toEqual(['Hello there.', 'Go now', 'See you.']);
    expect(cuesOf(words.map((w) => w.match === 'interpolated'))).toEqual(['Hello there. Go now See you.']);
  });
});
