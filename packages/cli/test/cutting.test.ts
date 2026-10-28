import { resolve } from 'node:path';
import { DEFAULT_PROFILES } from 'overtone-format';
import { describe, expect, it } from 'vitest';
import type { ResolvedProfile } from '../src/config.js';
import { estimateWordTimes, readRecutSource } from '../src/recut.js';
import { breakCost, invertedAuxiliaryAt, noBreakAfter, pronounEndAt } from '../src/segment/groups.js';
import { buildProfile, readingDeficit, timeCues } from '../src/segment/profile.js';
import { mergeProposal, newDiagnostics } from '../src/segment/proposal.js';
import { layoutLines, linesCost, pauseCueBreaks, shortCue, splitBlock, unpausedPair, type SplitContext } from '../src/segment/splitter.js';
import { tokenizeDisplay } from '../src/text/normalize.js';
import type { SpeakerWord } from '../src/turns.js';
import { talk } from './helpers.js';

// Soft line-cutting rules, mostly from captions flagged in a live run on a NASA interview (vertical profile).

const H: ResolvedProfile = { id: 'horizontal', ...DEFAULT_PROFILES.horizontal };
const V: ResolvedProfile = { id: 'vertical', ...DEFAULT_PROFILES.vertical };

const build = (words: SpeakerWord[], spec = V, proposal?: { cueStarts: number[]; lineStarts: number[] }, language = 'en') =>
  buildProfile(words, spec, { language, glossary: ['F-15 Eagle'], duration: Math.ceil(words.at(-1)!.end + 1), proposal });
const cues = (r: ReturnType<typeof build>) => r.profile.cues.map((c) => c.lines.map((l) => l.text).join(' / '));
const lineEnds = (r: ReturnType<typeof build>) => r.profile.cues.flatMap((c) => c.lines.slice(0, -1).map((l) => l.text.split(' ').at(-1)!));
/** Every line end except the last word of each cue's text, plus every cue end except the block's last. */
const allEnds = (r: ReturnType<typeof build>) => r.profile.cues.flatMap((c) => c.lines.map((l) => l.text.split(' ').at(-1)!)).slice(0, -1);

function ctxOf(text: string, spec = V, lang: 'en' | 'nl' = 'en'): SplitContext {
  const texts = tokenizeDisplay(text);
  return { texts, starts: texts.map((_, k) => k * 0.4), ends: texts.map((_, k) => k * 0.4 + 0.35), keep: noBreakAfter(texts, lang, []), lang, rules: spec.rules };
}
const layout = (text: string, spec = V) => {
  const ctx = ctxOf(text, spec);
  return layoutLines(ctx, 0, ctx.texts.length - 1)!.lines.map(([a, b]) => ctx.texts.slice(a, b + 1).join(' ')).join(' / ');
};
const cost = (text: string, i: number, lang: 'en' | 'nl' = 'en', lineStart = 0) => {
  const t = tokenizeDisplay(text);
  return breakCost({ texts: t, keep: noBreakAfter(t, lang, []), lang }, i, { lineStart });
};

describe('break costs', () => {
  // a plain break between two content words, the reference for the soft rules below
  const plainBreak = cost('the crew flew home', 1);

  it('a preposition or particle followed by a comma is a fine line end ("is up to,")', () => {
    expect(cost('what the crew is up to, we are joined', 5)).toBeLessThan(plainBreak);
    expect(cost('when we first came in, we were told', 4)).toBeLessThan(plainBreak);
    expect(cost('walk through what they do', 1)).toBeGreaterThan(plainBreak + 10);
  });

  it('penalizes ending on a subject pronoun or relative word, not on an object before a preposition', () => {
    expect(cost('with a class we affectionately call', 3)).toBeGreaterThan(plainBreak);
    expect(cost('walk through what they are doing', 2)).toBeGreaterThan(plainBreak);
    expect(cost('Jim, thank you for joining us.', 2)).toBe(plainBreak);
    // "before that" closes a phrase when a new one follows; "with that car" does not
    expect(cost('and before that I flew', 2)).toBe(plainBreak);
    expect(cost('he came with that car', 3)).toBeGreaterThan(plainBreak);
    expect(pronounEndAt(tokenizeDisplay('en toen zei ik dat het kon'), 'nl', 3)).toBe('subject');
  });

  it('penalizes an object-like pronoun after a verb less than a subject pronoun', () => {
    const subject = cost('with a class we affectionately call', 3);
    expect(cost('I want to thank you so much for coming', 4)).toBeLessThan(subject);
    expect(cost('We never did that again after the launch', 3)).toBeLessThan(subject);
    expect(cost('Ik weet dat niet zeker, zei ze', 2, 'nl')).toBeLessThan(cost('Ik denk dat ik morgen kom', 3, 'nl'));
  });

  it('reads "I." as the end of a sentence, not as an initial', () => {
    expect(cost('You like it, and so do I. That is what I think about it.', 6)).toBeLessThan(plainBreak);
  });

  it('penalizes a contracted pronoun less than a bare one', () => {
    expect(cost("so it'll be a gap", 1)).toBeGreaterThan(cost('so it will be a gap', 1));
    expect(cost("so it'll be a gap", 1)).toBeLessThan(cost('so we be a gap', 1));
  });

  it('penalizes cutting an adjective or modifier off its noun', () => {
    for (const [text, i] of [['as an operational pilot in the jet', 2], ['a five-year gap between them', 1], ['a very long gap', 1], ['the new vision for going', 1]] as const) {
      expect(cost(text, i)).toBeGreaterThan(plainBreak);
    }
    // not before a function word, not on a capitalized word
    expect(cost('it was operational in the end', 2)).toBe(plainBreak);
    expect(cost('als operationele piloot in de lucht', 1, 'nl')).toBeGreaterThan(cost('als piloot vliegt hij in de lucht', 1, 'nl'));
  });

  it('does not take common nouns and verbs with adjective endings for adjectives', () => {
    for (const w of ['arrive', 'receive', 'believe', 'achieve', 'survive', 'reveal', 'festival', 'hospital', 'arrival', 'capital', 'detective']) {
      expect(cost(`they ${w} today again`, 1)).toBe(cost('they fly today again', 1));
    }
    for (const w of ['finale', 'centrale']) expect(cost(`de ${w} morgen weer`, 1, 'nl')).toBe(cost('de wedstrijd morgen weer', 1, 'nl'));
  });

  it('penalizes a new sentence starting at the end of a line, and a sentence end carried over', () => {
    // "That's correct. I | think"
    const cutOff = cost("for a class. That's correct. I think it is safe", 5);
    // the same break on a line that starts with "I" cuts nothing off
    expect(cost("for a class. That's correct. I think it is safe", 5, 'en', 5)).toBeLessThan(cutOff);
    // "the 2004 | class."
    expect(cost('part of the 2004 class. Jim, thanks', 3)).toBeGreaterThan(plainBreak);
  });
});

describe('line layouts (vertical)', () => {
  it('keeps a pronoun with its verb', () => {
    expect(layout('with a class we affectionately')).toBe('with a class / we affectionately');
    expect(layout('Basically we flew in orbit')).toBe('Basically we flew / in orbit');
    expect(layout('Eventually they flew together')).toBe('Eventually / they flew together');
  });

  it('keeps an adjective with its noun', () => {
    expect(layout('the operational pilot flew home')).toBe('the operational pilot / flew home');
  });

  it('lets a top-line interjection stand alone, but makes other lone words cost more', () => {
    expect(layout('Okay. A little about me:')).toBe('Okay. / A little about me:');
    const alone = linesCost(ctxOf('Okay A little about me:'), [[0, 0], [1, 4]]);
    const interjection = linesCost(ctxOf('Okay. A little about me:'), [[0, 0], [1, 4]]);
    expect(alone - interjection).toBeGreaterThan(5);
  });
});

describe('deterministic cuts of flagged NASA captions (vertical)', () => {
  it('"To help us / walk through what": no line ends on "what" or "we\'re"', () => {
    const r = build(talk("To help us walk through what they're doing now, what the crew is up to, we're joined right now by Colonel Jim Dutton."));
    expect(allEnds(r)).not.toContain('what');
    expect(allEnds(r)).not.toContain("we're");
  });

  it('"and before that I / flew as an operational": never ends a line on "I"', () => {
    const r = build(talk('I was a test pilot, and before that I flew as an operational pilot in the F-15 Eagle.'));
    expect(allEnds(r)).not.toContain('I');
    expect(cues(r).join(' | ')).not.toMatch(/\bas an( \/ | \| )/);
  });

  it('"But when we / first came in, we": no line ends on "we"', () => {
    const r = build(talk('But when we first came in, we were told as a class that we would not fly on the shuttle.'));
    expect(allEnds(r)).not.toContain('we');
  });

  it('"That\'s correct. I / think": a new sentence does not start at the end of a line', () => {
    const r = build(talk("NASA is also right now actively looking, at least for another month or so, for a 2009 class. That's correct. I think pretty probably safe to say that that class will not fly on a shuttle."));
    expect(cues(r).join(' | ')).not.toMatch(/correct\. I( \/ | \| )/);
    expect(lineEnds(r)).not.toContain('I');
  });

  it('a cue of one or two short words joins a neighbour', () => {
    const ctx = ctxOf('But when we first came in, we were told');
    expect(shortCue(ctx, 0, 1, 0, 8)).toBe(2);
    expect(shortCue(ctx, 0, 0, 0, 8)).toBe(1);
    expect(shortCue(ctx, 0, 2, 0, 8)).toBe(0);
    // alone in its speaker block, or isolated by long pauses: fine
    expect(shortCue(ctx, 0, 1, 0, 1)).toBe(0);
    expect(shortCue({ ...ctx, starts: ctx.starts.map((s, k) => (k >= 2 ? s + 3 : s)), ends: ctx.ends.map((e, k) => (k >= 2 ? e + 3 : e)) }, 0, 1, 0, 8)).toBe(0);
  });
});

describe('proposal acceptance (relaxed reading rules)', () => {
  const words = talk("What the crew is up to, we're joined right now by the commander.");

  it('keeps a proposed line that ends on a preposition followed by a comma', () => {
    // "What the crew is up to," / "we're joined right now by the commander." on horizontal
    const r = build(words, H, { cueStarts: [0], lineStarts: [6] });
    expect(r.diagnostics.rejected).toEqual({});
    expect(cues(r)).toEqual(["What the crew is up to, / we're joined right now by the commander."]);
  });

  it('rejects a proposed line that ends on a subject pronoun and reports the rule', () => {
    const w = talk('We took a class we affectionately call the Peacocks.');
    const r = build(w, H, { cueStarts: [0], lineStarts: [5] });
    expect(r.diagnostics.rejected).toEqual({ pronounEnd: 1 });
    expect(r.diagnostics.examples.pronounEnd?.[0]).toEqual({ cue: 'We took a class we / affectionately call the Peacocks.', detail: 'line ends on "we"' });
    expect(lineEnds(r)).not.toContain('we');
  });

  it('rejects a proposed line that ends on a coordinating conjunction ("and" starts the next line)', () => {
    // a line end found in the caption benchmark: "the aptitude and / the willingness to learn"
    const w = talk('You need the aptitude and the willingness to learn new things.');
    const r = build(w, H, { cueStarts: [0], lineStarts: [5] });
    expect(r.diagnostics.rejected).toEqual({ lineEnd: 1 });
    expect(r.diagnostics.examples.lineEnd?.[0]?.detail).toBe('line ends on "and"');
    expect(lineEnds(r)).not.toContain('and');
  });

  it('rejects a proposed cue of two short words and re-cuts it with its neighbours', () => {
    const w = talk('And then obviously we carry on into the next program.');
    const r = build(w, V, { cueStarts: [0, 2, 6], lineStarts: [] });
    expect(r.diagnostics.rejected.shortCue).toBeGreaterThanOrEqual(1);
    expect(cues(r)).not.toContain('And then');
  });

  it('re-cuts only the lines of a kept cue whose lines are clearly worse', () => {
    // from the live run: the cue is kept, its lines are re-cut
    const r = build(talk("So, yeah, it's very exciting."), V, { cueStarts: [0], lineStarts: [3] });
    expect(r.diagnostics.reflowed).toBe(1);
    expect(r.diagnostics.reflowExamples[0]).toEqual({ cue: "So, yeah, it's / very exciting.", to: "So, yeah, / it's very exciting." });
    expect(r.fromProposal).toBe(1);
    // a proposal whose lines are only a little worse keeps its own lines
    const kept = build(talk('And my background is with the Air Force.'), V, { cueStarts: [0], lineStarts: [3] });
    expect(kept.diagnostics.reflowed).toBe(0);
    expect(cues(kept)).toEqual(['And my background / is with the Air Force.']);
  });
});

describe('proposal acceptance (sentences and pronouns)', () => {
  // The start of the live NASA interview (words with their real timing) and the vertical layout the LLM proposed.
  const NASA: Array<[string, number, number, string]> = [
    ['To', 0.43, 0.51, 'S1'], ['help', 0.51, 0.83, 'S1'], ['us', 0.91, 1.15, 'S1'], ['walk', 1.15, 1.47, 'S1'], ['through', 1.47, 1.67, 'S1'],
    ['what', 1.67, 2.03, 'S1'], ["they're", 2.43, 2.67, 'S1'], ['doing', 2.91, 3.23, 'S1'], ['now,', 3.23, 3.39, 'S1'], ['what', 3.39, 3.51, 'S1'],
    ['the', 3.51, 3.59, 'S1'], ['crew', 3.59, 3.777, 'S1'], ['is', 3.777, 3.87, 'S1'], ['up', 3.87, 3.956, 'S1'], ['to,', 3.956, 4.07, 'S1'],
    ["we're", 4.07, 4.19, 'S1'], ['joined', 4.19, 4.51, 'S1'], ['right', 4.51, 4.63, 'S1'], ['now', 4.63, 4.75, 'S1'], ['by', 4.75, 5.07, 'S1'],
    ['Colonel', 6.51, 6.79, 'S1'], ['Jim', 6.79, 6.99, 'S1'], ['Dutton,', 6.99, 7.23, 'S1'], ["who's", 7.23, 7.51, 'S1'], ['one', 7.55, 7.75, 'S1'],
    ['of', 7.75, 7.83, 'S1'], ['our', 7.83, 7.95, 'S1'], ['astronauts,', 7.95, 8.43, 'S1'], ['part', 8.43, 8.63, 'S1'], ['of', 8.63, 8.71, 'S1'],
    ['the', 8.71, 8.79, 'S1'], ['2004', 8.79, 9.47, 'S1'], ['class.', 9.47, 10.03, 'S1'], ['Jim,', 10.75, 10.95, 'S1'], ['thank', 10.95, 11.11, 'S1'],
    ['you', 11.11, 11.19, 'S1'], ['for', 11.19, 11.31, 'S1'], ['joining', 11.31, 11.51, 'S1'], ['us.', 11.51, 11.59, 'S1'],
    ["It's", 11.59, 11.83, 'S2'], ['great', 12.03, 12.23, 'S2'], ['to', 12.23, 12.31, 'S2'], ['be', 12.31, 12.43, 'S2'], ['here,', 12.43, 12.59, 'S2'],
    ['Allard.', 12.59, 12.83, 'S2'], ['Thanks.', 12.83, 13.23, 'S2'],
  ];
  const nasa: SpeakerWord[] = NASA.map(([text, start, end, speaker]) => ({ text, start, end, speaker }));
  const nasaProposal = { cueStarts: [0, 4, 9, 15, 23, 28, 36, 39], lineStarts: [7, 12, 19, 25, 32, 44] };

  it('NASA: rejects "part of the 2004 / class. Jim, thank you" | "for joining us."', () => {
    const r = build(nasa, V, nasaProposal);
    const all = cues(r);
    expect(all).not.toContain('part of the 2004 / class. Jim, thank you');
    expect(all).not.toContain('for joining us.');
    expect(all.join(' | ')).not.toMatch(/2004( \/ | \| )class\./);
    expect(all.some((c) => /Jim, thank you( \/ )?for joining us\.$/.test(c) || c === 'Jim, thank you / for joining us.')).toBe(true);
    expect(r.diagnostics.rejected.sentenceEdge).toBeGreaterThanOrEqual(1);
    // the other proposed cues of the block are kept, except the one that hides the 1.4 s pause after "by" inside a
    // line: it is re-cut so the hesitation shows
    expect(all).toContain("who's one / of our astronauts,");
    expect(r.diagnostics.examples.pause?.[0]).toEqual({ cue: "we're joined right now / by Colonel Jim Dutton,", detail: '1.4 s pause inside a line after "by"' });
    expect(all.join(' | ')).toMatch(/ by \| Colonel Jim Dutton,/);
  });

  it('rejects a cue end that splits a sentence which fits one cue', () => {
    const w = talk('We waited for a while. Jim, thank you for joining us. It was great.');
    const r = build(w, V, { cueStarts: [0, 5, 8, 11], lineStarts: [] });
    expect(r.diagnostics.rejected.splitSentence).toBeGreaterThanOrEqual(1);
    expect(cues(r).join(' | ')).not.toMatch(/thank you \| for/);
  });

  it('keeps a sentence that ends on "I." (not an initial)', () => {
    const w = talk('You like it, and so do I. That is what I think about it.');
    const r = build(w, H, { cueStarts: [0, 7], lineStarts: [] });
    expect(r.diagnostics.rejected).toEqual({});
    expect(cues(r)).toEqual(['You like it, and so do I.', 'That is what I think about it.']);
  });

  it('rejects "what" opening a clause after a preposition, keeps it after a verb', () => {
    const through = build(talk("We walked through what they are doing in orbit right now today."), H, { cueStarts: [0], lineStarts: [4] });
    expect(through.diagnostics.rejected.pronounEnd).toBe(1);
    const verb = build(talk('In the end we all did what was right for the whole crew.'), H, { cueStarts: [0], lineStarts: [7] });
    expect(verb.diagnostics.rejected).toEqual({});
  });

  it.each([
    ['en', 'I want to thank you so much for coming here today.', 5],
    ['en', 'We never did that again after the launch.', 4],
    ['nl', 'Ik weet dat niet zeker, zei ze tegen mij.', 3],
    ['nl', 'Ik heb ze gisteren nog gezien in de stad.', 3],
  ])('keeps an object-like pronoun at a proposed line end (%s: %s)', (language, text, lineStart) => {
    const r = build(talk(text), H, { cueStarts: [0], lineStarts: [lineStart] }, language);
    expect(r.diagnostics.rejected).toEqual({});
    expect(r.proposalCues).toBe(1);
  });

  it('rejects a proposed cue shown for less than half the minimum duration when the deterministic cue lasts longer', () => {
    // "for joining us." alone lasts 0.4 s before the next speaker starts
    const r = build(nasa.slice(33), V, { cueStarts: [0, 3, 6], lineStarts: [] });
    expect(r.diagnostics.rejected.tooShort).toBe(1);
    expect(cues(r)).not.toContain('for joining us.');
  });

  it('caps the reading-speed fallback examples', () => {
    const ws = 'we tested every single system on the whole spacecraft twice and then we flew homeward'
      .split(' ').map((t, k) => ({ text: t, start: k * 0.25, end: k * 0.25 + 0.22, speaker: 'S1' }));
    const texts = ws.map((w) => w.text);
    const ctx: SplitContext = { texts, starts: ws.map((w) => w.start), ends: ws.map((w) => w.end), keep: noBreakAfter(texts, 'en', []), lang: 'en', rules: H.rules };
    const to = ws.length - 1;
    const det = timeCues(splitBlock(ctx, 0, to), ws, H.rules, 10, 10);
    const diagnostics = newDiagnostics();
    for (let k = 0; k < 5; k++) {
      expect(mergeProposal(ctx, ws, 10, { from: 0, to, nextStart: 10, after: 0, det }, { cueStarts: [0, 3, 5, 9, 12], lineStarts: [] }, diagnostics)).toBeUndefined();
    }
    expect(diagnostics.timingFallback).toBe(5);
    expect(diagnostics.fallbacks.length).toBeLessThan(5);
  });
});

describe('reading speed', () => {
  it('measures the reading time cues lack, not how many cues are too fast', () => {
    const w = talk('one two three four five six seven eight nine ten');
    const rules = { maxCharsPerLine: 42, maxLines: 2, maxCps: 10, minDuration: 1 };
    // the media ends 0.5 s after the last word, so both layouts get the same time after it
    const end = w[9]!.end + 0.5;
    const one = timeCues([{ lines: [[0, 9]] }], w, rules, end);
    const two = timeCues([{ lines: [[0, 4]] }, { lines: [[5, 9]] }], w, rules, end);
    const chars = 'one two three four five six seven eight nine ten'.length;
    expect(readingDeficit(one, rules)).toBeCloseTo(chars / 10 - (one[0].end - one[0].start), 6);
    // splitting the same words in two adds the joining space back as reading time, nothing more
    expect(readingDeficit(two, rules)).toBeCloseTo(readingDeficit(one, rules) - 0.1, 1);
  });

  // fast speech: 0.25 s per word, so every layout is too fast to read comfortably
  const fast = 'we tested every single system on the whole spacecraft twice and then we flew homeward'
    .split(' ').map((t, k) => ({ text: t, start: k * 0.25, end: k * 0.25 + 0.22, speaker: 'S1' }));
  // the media ends 0.5 s after the last word: no layout can make up its reading time in the silence after it
  const end = fast.at(-1)!.end + 0.5;
  const propose = (cueStarts: number[]) => buildProfile(fast, H, { language: 'en', glossary: [], duration: end, proposal: { cueStarts, lineStarts: [] } });
  const detDeficit = readingDeficit(buildProfile(fast, H, { language: 'en', glossary: [], duration: end }).profile.cues, H.rules);

  it('keeps a proposal that lacks a little more reading time than the deterministic cut', () => {
    const r = propose([0, 5, 10]);
    expect(readingDeficit(r.profile.cues, H.rules)).toBeGreaterThan(detDeficit);
    expect(r).toMatchObject({ proposalCues: 3, fromProposal: 1 });
    expect(r.diagnostics.timingFallback).toBe(0);
  });

  it('falls back to the deterministic cut when a proposal lacks much more reading time', () => {
    const r = propose([0, 3, 5, 9, 12]);
    expect(r.diagnostics.timingFallback).toBe(1);
    expect(r.diagnostics.fallbacks[0].mixed).toBeGreaterThan(r.diagnostics.fallbacks[0].deterministic);
    expect(r.proposalCues).toBe(0);
    expect(readingDeficit(r.profile.cues, H.rules)).toBeCloseTo(detDeficit, 6);
  });
});

describe('recut fixtures (vertical, word times estimated from the cue times)', () => {
  const FIXTURES = resolve(import.meta.dirname, 'fixtures/subtitles');
  async function recutCues(file: string): Promise<string[]> {
    const source = await readRecutSource(resolve(FIXTURES, file), file);
    if (source.kind === 'overtone') throw new Error('expected subtitles');
    const words = estimateWordTimes(source.parsed.cues);
    return cues(buildProfile(words, V, { language: 'en', glossary: [], duration: Math.ceil(words.at(-1)!.end + 1) }));
  }

  it('"How did / the project start?": an inverted question breaks after its auxiliary, not after a lone "How"', async () => {
    const c = await recutCues('interview.vtt');
    expect(c).toContain('How did / the project start?');
    expect(c.join(' | ')).not.toMatch(/(^|\| )How \//);
  });

  it('"Most subtitle files were written": two words without a pause around them are not a cue of their own', async () => {
    const c = await recutCues('talk.srt');
    expect(c).not.toContain('Most subtitle');
    expect(c.filter((x) => x.split(/ \/? ?/).length <= 2 && !/[.?!]$/.test(x))).toEqual([]);
  });
});

describe('questions with the auxiliary before the subject', () => {
  const at = (text: string, i: number, lang: 'en' | 'nl' = 'en') => invertedAuxiliaryAt(tokenizeDisplay(text), lang, i);

  it('lets a line end on the auxiliary right after a question word that opens the sentence or clause', () => {
    expect(at('How did the project start?', 1)).toBe(true);
    expect(at('Where are you going?', 1)).toBe(true);
    expect(at('Thanks. And how did Tom find it?', 3)).toBe(true);
    expect(at('Okay, what is the plan?', 2)).toBe(true);
    expect(at('Hoe is het project begonnen?', 1, 'nl')).toBe(true);
    expect(cost('How did the project start?', 1)).toBeLessThan(cost('How did the project start?', 2));
  });

  it('keeps the auxiliary cost when the question word is the subject, inside a sentence, or a relative word', () => {
    expect(at('What is needed now?', 1)).toBe(false);
    expect(at("That's what is the problem.", 2)).toBe(false);
    expect(at('Jim, who is a pilot, flew it.', 2)).toBe(false);
    expect(at('How did.', 1)).toBe(false);
    expect(cost('What is needed now?', 1)).toBeGreaterThan(cost('How did the project start?', 1) + 10);
  });

  it('lays out "How did / the project start?" on a phone', () => {
    expect(layout('How did the project start?')).toBe('How did / the project start?');
  });
});

describe('short cues of two longer words', () => {
  it('a cue of two words of more than 12 characters together costs extra, unless a pause sets it apart', () => {
    const ctx = ctxOf('Most subtitle files were written for a wide screen');
    expect(unpausedPair(ctx, 0, 1, 0, 8)).toBe(true);
    // a pause of 0.5 s after "subtitle": the short cue shows the pause
    const paused = { ...ctx, starts: ctx.starts.map((s, k) => (k >= 2 ? s + 0.5 : s)), ends: ctx.ends.map((e, k) => (k >= 2 ? e + 0.5 : e)) };
    expect(unpausedPair(paused, 0, 1, 0, 8)).toBe(false);
    // short enough for shortCue, three words, one word longer than 12 characters, or alone in its block: not this rule
    expect(unpausedPair(ctxOf('But when we first came in'), 0, 1, 0, 5)).toBe(false);
    expect(unpausedPair(ctx, 0, 2, 0, 8)).toBe(false);
    expect(unpausedPair(ctxOf('Unfortunately nobody came to the show'), 0, 1, 0, 5)).toBe(false);
    expect(unpausedPair(ctx, 0, 1, 0, 1)).toBe(false);
  });
});

describe('pauses show hesitations', () => {
  // Captions should show the vocal situation: a break at a real pause is good, even mid-sentence or after a short
  // word (see src/segment/pauses.ts).

  /** The words with extra silence before word k (`pauses[k]` seconds; later words shift). */
  const pauseBefore = (words: SpeakerWord[], pauses: Record<number, number>) => {
    let shift = 0;
    return words.map((w, k) => {
      shift += pauses[k] ?? 0;
      return { ...w, start: +(w.start + shift).toFixed(3), end: +(w.end + shift).toFixed(3) };
    });
  };
  const timed = (list: Array<[string, number, number]>): SpeakerWord[] => list.map(([text, start, end]) => ({ text, start, end, speaker: 'S1' }));
  const ctxFrom = (words: SpeakerWord[], spec = V): SplitContext => {
    const texts = words.map((w) => w.text);
    return { texts, starts: words.map((w) => w.start), ends: words.map((w) => w.end), keep: noBreakAfter(texts, 'en', []), lang: 'en', rules: spec.rules };
  };
  const sentence = talk('The answer is forty two and that is final.');

  it('a pause of 1 s or more starts a new cue, even inside a sentence', () => {
    expect(cues(build(pauseBefore(sentence, { 5: 1 }), H))).toEqual(['The answer is forty two', 'and that is final.']);
    expect(cues(build(sentence, H))).toEqual(['The answer is forty two and that is final.']);
  });

  it('but not where a piece would be on screen less than 0.7 s: the shorter pause next to it is dropped', () => {
    // "uh" would be on screen 0.6 s: of the pauses around it (1.1 s, 1.2 s), the shorter one is dropped
    const words = timed([['We', 0, 0.2], ['went', 0.25, 0.5], ['uh', 1.6, 1.7], ['home', 2.9, 3.3], ['today.', 3.35, 3.8]]);
    expect([...pauseCueBreaks(ctxFrom(words), 0, 4)]).toEqual([0, 0, 1, 0, 0]);
    expect(cues(build(words, V)).map((c) => c.replace(' / ', ' '))).toEqual(['We went uh', 'home today.']);
    // a pause of 1.5 s or more always stays
    const hard = timed([['We', 0, 0.2], ['went', 0.25, 0.5], ['uh', 2.0, 2.1], ['home', 3.3, 3.7], ['today.', 3.75, 4.2]]);
    expect([...pauseCueBreaks(ctxFrom(hard), 0, 4)]).toEqual([0, 1, 0, 0, 0]);
  });

  it('a word between two such pauses is not an orphan', () => {
    const words = timed([['We', 0, 0.2], ['went', 0.25, 0.5], ['home,', 1.6, 2.0], ['and', 3.2, 3.3], ['slept.', 3.35, 3.8]]);
    expect(shortCue(ctxFrom(words), 2, 2, 0, 4)).toBe(0);
    expect(shortCue(ctxFrom(timed([['We', 0, 0.2], ['went', 0.25, 0.5], ['home,', 0.6, 1.0], ['and', 1.05, 1.15], ['slept.', 1.2, 1.6]])), 2, 2, 0, 4)).toBe(1);
  });

  it('a pause of 0.5 s or more may break a cue that fits on one line', () => {
    const words = talk("That's what I feel.");
    expect(cues(build(pauseBefore(words, { 3: 0.53 }), H))).toEqual(["That's what I / feel."]);
    expect(cues(build(pauseBefore(words, { 3: 0.4 }), H))).toEqual(["That's what I feel."]);
  });

  it('a break followed by a pause of 0.5 s or more costs no more than one after a comma, whatever word it ends on', () => {
    const t = tokenizeDisplay('walk through what they do, and the rest');
    const keep = noBreakAfter(t, 'en', []);
    const comma = breakCost({ texts: t, keep, lang: 'en' }, 4);
    for (const i of [0, 1, 2, 3, 6]) {
      expect(breakCost({ texts: t, keep, lang: 'en' }, i, { hesitation: 1 })).toBeLessThanOrEqual(comma);
      expect(breakCost({ texts: t, keep, lang: 'en' }, i)).toBeGreaterThan(comma);
    }
    // a hesitation after a preposition shows as a break there
    const words = pauseBefore(talk('He talked about the launch of the new rocket today.'), { 6: 0.57 });
    expect(allEnds(build(words, V))).toContain('of');
    expect(allEnds(build(talk('He talked about the launch of the new rocket today.'), V))).not.toContain('of');
  });

  it('never waives names, number groups or glossary terms', () => {
    const t = tokenizeDisplay('We met Colonel Jim Dutton and paid €12 a month for the F-15 Eagle today.');
    const keep = noBreakAfter(t, 'en', ['F-15 Eagle']);
    for (const i of [2, 3, 7, 8, 12]) expect(breakCost({ texts: t, keep, lang: 'en' }, i, { hesitation: 1 })).toBeGreaterThanOrEqual(100);
    const name = talk('We met Colonel Jim Dutton at the launch site yesterday.');
    for (const pause of [0.8, 1.2]) {
      const r = build(pauseBefore(name, { 4: pause }), V);
      expect(cues(r).join(' | ')).toContain('Colonel Jim Dutton');
    }
  });

  it('a cue with less than 0.7 s on screen costs extra', () => {
    // fast speech without pauses: "It is done." alone would be on screen 0.57 s
    let t = 0;
    const words = tokenizeDisplay('It is done. Now we start the next part of the work and we go on until the evening comes.').map((text) => {
      const w = { text, start: +t.toFixed(3), end: +(t + 0.04 * text.length + 0.05).toFixed(3), speaker: 'S1' };
      t = w.end + 0.02;
      return w;
    });
    const r = build(words, H);
    expect(cues(r)[0]).not.toBe('It is done.');
    for (const c of r.profile.cues) expect(c.end - c.start).toBeGreaterThanOrEqual(0.7);
  });

  it('proposals: a line or cue break at a hesitation breaks no reading rule but "group"', () => {
    // a subject pronoun at a line end, followed by a 0.6 s pause
    const w = pauseBefore(talk('We took a class we affectionately call the Peacocks.'), { 5: 0.57 });
    const r = build(w, H, { cueStarts: [0], lineStarts: [5] });
    expect(r.diagnostics.rejected).toEqual({});
    expect(cues(r)).toEqual(['We took a class we / affectionately call the Peacocks.']);
    // a cue end inside a sentence that fits one cue
    const s = pauseBefore(talk('We waited for a while. Jim, thank you for joining us. It was great.'), { 8: 0.57 });
    expect(build(s, V, { cueStarts: [0, 5, 8, 11], lineStarts: [] }).diagnostics.rejected.splitSentence).toBeUndefined();
    // inside a name: still rejected
    const n = pauseBefore(talk('We met Colonel Jim Dutton at the launch site.'), { 4: 0.57 });
    expect(build(n, H, { cueStarts: [0], lineStarts: [4] }).diagnostics.rejected).toEqual({ group: 1 });
  });

  it('proposals: a pause of 1 s or more may show as a line break, never inside a line', () => {
    const w = pauseBefore(sentence, { 5: 1 });
    const shown = build(w, H, { cueStarts: [0], lineStarts: [5] });
    expect(shown.diagnostics.rejected).toEqual({});
    expect(cues(shown)).toEqual(['The answer is forty two / and that is final.']);
    const hidden = build(w, H, { cueStarts: [0], lineStarts: [] });
    expect(hidden.diagnostics.rejected).toEqual({ pause: 1 });
    expect(cues(hidden)).toEqual(['The answer is forty two', 'and that is final.']);
  });
});
