import { describe, expect, it } from 'vitest';
import { alignWords, type AlignOptions } from '../src/align/align.js';
import { alignUnits, opsCost, type Unit } from '../src/align/dp.js';
import { tokenizeDisplay } from '../src/text/normalize.js';
import type { AlignedWord, TimedWord } from '../src/types.js';
import { az } from './helpers.js';

const cat = (...xs: TimedWord[][]): TimedWord[] => xs.flat();
const MATCHES = new Set(['exact', 'fuzzy', 'split', 'merge', 'interpolated']);
const ms = (t: number): boolean => Math.round(t * 1000) / 1000 === t;

/** Everything the aligner promises for any input; returns a list of violations (empty = fine). */
function violations(words: readonly string[], timed: readonly TimedWord[], r: readonly AlignedWord[], duration?: number): string[] {
  const p: string[] = [];
  if (r.length !== words.length) p.push(`length ${r.length} != ${words.length}`);
  const speakers = new Set(['S1', ...timed.map((t) => t.speaker ?? 'S1')]);
  let prev: AlignedWord | undefined;
  r.forEach((w, i) => {
    const at = `#${i} ${w.text} ${w.start}-${w.end}`;
    if (w.text !== words[i]) p.push(`${at}: text differs from "${words[i]}"`);
    if (!(w.start < w.end)) p.push(`${at}: not start < end`);
    if (!ms(w.start) || !ms(w.end)) p.push(`${at}: not rounded to ms`);
    if (w.start < 0) p.push(`${at}: negative`);
    if (duration !== undefined && w.end > duration) p.push(`${at}: beyond duration ${duration}`);
    if (prev && w.start < prev.end) p.push(`${at}: overlaps previous`);
    if (prev && w.start < prev.start) p.push(`${at}: not monotonic`);
    if (!MATCHES.has(w.match)) p.push(`${at}: match ${w.match}`);
    if (!(Number.isFinite(w.confidence) && w.confidence >= 0 && w.confidence <= 1)) p.push(`${at}: confidence ${w.confidence}`);
    if (!speakers.has(w.speaker)) p.push(`${at}: unknown speaker ${w.speaker}`);
    prev = w;
  });
  return p;
}

function run(text: string, timed: TimedWord[], lang = 'en', extra: AlignOptions = {}): AlignedWord[] {
  const words = tokenizeDisplay(text);
  const r = alignWords(words, timed, { language: lang, ...extra });
  expect(violations(words, timed, r, extra.duration)).toEqual([]);
  expect(alignWords(words, timed, { language: lang, ...extra })).toEqual(r); // deterministic
  return r;
}
const word = (r: AlignedWord[], text: string, nth = 0): AlignedWord => r.filter((w) => w.text === text)[nth];
const span = (w: AlignedWord): [number, number] => [w.start, w.end];

describe('repair windows use the time around them', () => {
  it('a phrase only the text has goes into the silence before a misheard word', () => {
    const r = run('Thanks for coming. And welcome Ruud.', cat(az('thanks for coming'), az('root', { start: 7 })));
    for (const t of ['And', 'welcome']) {
      expect(word(r, t).match).toBe('interpolated');
      expect(word(r, t).start).toBeGreaterThanOrEqual(1.4);
      expect(word(r, t).end).toBeLessThanOrEqual(7);
    }
    // no engine heard the phrase: an unknown time, its natural length in the middle of the silence (no punctuation rule)
    const mid = (word(r, 'And').start + word(r, 'welcome').end) / 2;
    expect(mid).toBeCloseTo((word(r, 'coming.').end + 7) / 2, 1);
    expect(word(r, 'welcome').end - word(r, 'And').start).toBeLessThan(1.5);
    expect(span(word(r, 'Ruud.'))).toEqual([7, 7.4]);
  });

  it('a misheard word keeps its own timing word when the timing side adds a false start', () => {
    const r = run("Thanks, Ruud. Let's begin.", cat(az('thanks root'), az('so before we really go into it I mean', { start: 1 }), az("let's begin", { start: 5 })));
    expect(span(word(r, 'Ruud.'))).toEqual([0.5, 0.9]);
    expect(word(r, "Let's").match).toBe('exact');
  });

  it('a sentence the timing side missed fills the gap; the misheard next word stays on its timing word', () => {
    const r = run('Hello there. This sentence was missed entirely. Fabulous news.', cat(az('hello there'), az('abyss news', { start: 5 })));
    for (const t of ['This', 'sentence', 'was', 'missed', 'entirely.']) {
      expect(word(r, t).start).toBeGreaterThanOrEqual(0.9);
      expect(word(r, t).end).toBeLessThanOrEqual(5);
    }
    expect(span(word(r, 'Fabulous'))).toEqual([5, 5.4]);
  });

  it('a sentence the timing side missed fills the gap; the misheard previous word stays on its timing word', () => {
    const r = run('Hello Qxyz. This sentence was missed entirely. Thank you.', cat(az('hello kite'), az('thank you', { start: 5 })));
    expect(span(word(r, 'Qxyz.'))).toEqual([0.5, 0.9]);
    expect(word(r, 'This').start).toBeGreaterThanOrEqual(0.9);
    expect(word(r, 'entirely.').end).toBeLessThanOrEqual(5);
    expect(word(r, 'entirely.').end - word(r, 'This').start).toBeGreaterThan(1.5);
  });

  it('a word in the middle of a long silence gets a natural length, not the whole silence', () => {
    // word i spoken at i × 8.3 s; the timing side misses every third word
    const words = 'please wait for the tone then say your name clearly after it'.split(' ');
    const timed = words.flatMap((w, i) => (i % 3 === 1 ? [] : [{ text: w, start: +(i * 8.3).toFixed(3), end: +(i * 8.3 + 0.3).toFixed(3), speaker: 'S1' }]));
    const r = run(words.join(' '), timed, 'en', { duration: 120 });
    words.forEach((_, i) => {
      if (i % 3 !== 1) return;
      expect(r[i].match).toBe('interpolated');
      expect(r[i].end - r[i].start).toBeLessThan(1);
      expect(Math.abs(r[i].start - i * 8.3)).toBeLessThan(1);
    });
  });

  it('a chorus the timing side missed goes into the silence it left', () => {
    const chorus = 'oh we will carry on and on tonight'.split(' ');
    const words: string[] = [];
    const timed: TimedWord[] = [];
    const truth: number[] = [];
    let t = 0;
    for (let k = 1; k <= 6; k++) {
      for (const w of chorus) {
        words.push(w);
        truth.push(+t.toFixed(3));
        if (k !== 3) timed.push({ text: w, start: +t.toFixed(3), end: +(t + 0.3).toFixed(3), speaker: 'S1' });
        t += 0.4;
      }
      t += 2;
    }
    const r = run(words.join(' '), timed);
    expect(r.filter((w, i) => Math.abs(w.start - truth[i]) > 0.5).map((w) => w.text)).toEqual([]);
  });

  it('a misheard word is not stretched over a sentence only the timing side has', () => {
    const r = run('Hello there. Fabulous news.', cat(az('hello there'), az('some extra words azure heard', { start: 1 }), az('abyss news', { start: 4 })));
    expect(span(word(r, 'Fabulous'))).toEqual([4, 4.4]);
    const r2 = run('Hello Qxyz. Thank you.', cat(az('hello kite'), az('some extra words azure heard', { start: 1 }), az('thank you', { start: 4 })));
    // nothing in the extra words resembles "Qxyz."; it ends its sentence, so it stays with "Hello" on "kite"
    expect(span(word(r2, 'Qxyz.'))).toEqual([0.5, 0.9]);
  });

  it('a long block only the timing side has next to a few garbled words stays fast', () => {
    const rnd = rng(7);
    const gib = (syl: string[]): string => Array.from({ length: 2 + Math.floor(rnd() * 2) }, () => syl[Math.floor(rnd() * syl.length)]).join('');
    const head = 'this is the beginning of a fairly normal sentence that everyone can follow'.split(' ');
    const tail = 'and now we are back on track with the regular programme for today'.split(' ');
    const mid = Array.from({ length: 18 }, () => gib(['ka', 'lo', 'mi', 'pa', 'ko']));
    const extra = Array.from({ length: 6018 }, () => gib(['stu', 'vre', 'dyn', 'gry', 'tweh', 'zug', 'brech', 'hund', 'wyt', 'sfer']));
    const timed = [...head, ...extra, ...tail].map((w, i) => ({ text: w, start: +(i * 0.4).toFixed(3), end: +(i * 0.4 + 0.3).toFixed(3), speaker: 'S1' }));
    const t0 = performance.now();
    const r = run([...head, ...mid, ...tail].join(' '), timed);
    // ~0.2 s alone; generous so parallel test load can't make it flaky
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(r[head.length + mid.length].match).toBe('exact');
  });

  it('a garbled stretch without pauses is still spread over its timing words', () => {
    const real = 'we have to make sure that every single customer gets a clear answer before the end of the week';
    const r = run(`Hello there. ${real}. Thank you.`, cat(az('hello there'), az('zorp blik fant quex dravo mirn tolk shup vemble grax', { start: 1, step: 0.9, dur: 0.8 }), az('thank you', { start: 10 })));
    const mid = r.slice(2, -2);
    expect(mid[0].start).toBe(1);
    expect(mid[mid.length - 1].end).toBe(9.9);
    expect(mid.every((w) => w.match === 'fuzzy')).toBe(true);
  });
});

describe('merges with a slightly misheard timing side', () => {
  it('CarCover ↔ car covers', () => {
    const r = run('Ask CarCover today.', az('ask car covers today'));
    expect(r.map((w) => w.match)).toEqual(['exact', 'merge', 'exact']);
    expect(span(r[1])).toEqual([0.5, 1.4]);
  });

  it('CarCover ↔ car cove', () => {
    const r = run('Ask CarCover about it.', az('ask car cove about it'));
    expect(r[1]).toMatchObject({ match: 'merge', start: 0.5, end: 1.4 });
  });

  it('car cover ↔ carcovers', () => {
    const r = run('Ask car cover today.', az('ask carcovers today', { step: 1, dur: 0.8 }));
    expect(r.map((w) => w.match)).toEqual(['exact', 'split', 'split', 'exact']);
    expect(r[1].start).toBe(1);
    expect(r[2].end).toBe(1.8);
  });

  it('a name of more than three pieces still merges whole', () => {
    const r = run('Try SafeDriveNowPlus today.', az('try safe drive now plus today'));
    expect(r[1]).toMatchObject({ match: 'merge', start: 0.5, end: 2.4 });
  });

  it('a stutter in the text is not merged', () => {
    expect(run('I I think', az('I think')).map((w) => w.match)).toEqual(['interpolated', 'exact', 'exact']);
  });
});

describe('segmented DP', () => {
  const cases = [
    [600, 150, 540, 'extra'], [600, 250, 300, 'extra'], [600, 200, 0, 'extra'], [600, 200, 600, 'extra'], [1000, 400, 100, 'drop'], [1000, 600, 0, 'drop'],
  ] as const;
  it.each(cases)('n=%i, one-sided gap of %i at %i (%s): same as the full matrix', (n, gap, pos, mode) => {
    const text = Array.from({ length: n }, (_, i) => `word${i}`);
    const az2 = [...text];
    if (mode === 'extra') az2.splice(pos, 0, ...Array.from({ length: gap }, (_, k) => `other${k}`));
    else az2.splice(pos, gap);
    const timed = az2.map((w, i) => ({ text: w, start: i * 0.4, end: i * 0.4 + 0.3, speaker: 'S1' }));
    const a = alignWords(text, timed, { language: 'en' });
    const b = alignWords(text, timed, { language: 'en', band: Infinity });
    expect(a).toEqual(b);
    expect(a.filter((w) => w.match === 'exact')).toHaveLength(mode === 'extra' ? n : n - gap);
  });

  it('a large one-sided gap near the start aligns fast (5 000 words, 600 missing)', () => {
    const { text, timed } = synthetic(5000, 'gapstart', 600, 3);
    const t0 = performance.now();
    const r = alignWords(text, timed, { language: 'en' });
    const took = performance.now() - t0;
    expect(r).toHaveLength(5000);
    expect(r.slice(700).filter((w) => w.match === 'exact').length).toBeGreaterThan(3600);
    expect(took).toBeLessThan(2000);
  });

  it('9 000 words with a 1 000-word one-sided gap align in < 3 s', () => {
    for (const scenario of ['gapstart', 'gapmid', 'extra'] as const) {
      const { text, timed } = synthetic(9000, scenario, 1000, 1);
      const t0 = performance.now();
      const r = alignWords(text, timed, { language: 'en' });
      expect(performance.now() - t0).toBeLessThan(3000);
      expect(r).toHaveLength(9000);
    }
  });
});

/** Random-vocabulary transcript with 10% substitutions and one one-sided gap (`gapstart`, `gapmid`, `extra`). */
function synthetic(n: number, scenario: 'clean' | 'gapstart' | 'gapmid' | 'extra', gap: number, seed: number): { text: string[]; timed: TimedWord[] } {
  const rnd = rng(seed);
  const vocab = 'the a we to and of that is in it you for on with as be have this at by from they or one but not what all were when your can said there use each which she do how their if will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part'.split(' ');
  const pick = (): string => vocab[Math.floor(rnd() * vocab.length)];
  const text = Array.from({ length: n }, pick);
  let b = text.map((w) => (rnd() < 0.1 ? pick() : w));
  const q = Math.floor(n / 4);
  if (scenario === 'gapstart') b = b.slice(gap);
  if (scenario === 'gapmid') b = [...b.slice(0, q), ...b.slice(q + gap)];
  if (scenario === 'extra') b = [...b.slice(0, q), ...Array.from({ length: gap }, pick), ...b.slice(q)];
  return { text, timed: b.map((t, i) => ({ text: t, start: +(i * 0.4).toFixed(3), end: +(i * 0.4 + 0.3).toFixed(3), speaker: 'S1' })) };
}

describe('finalize keeps words ordered and non-empty', () => {
  it('an over-long timing word yields to the next words', () => {
    const r = run('One two three four.', [
      { text: 'one', start: 0, end: 5, speaker: 'S1' }, { text: 'two', start: 1, end: 1.4, speaker: 'S1' },
      { text: 'three', start: 1.5, end: 1.9, speaker: 'S1' }, { text: 'four', start: 2, end: 2.4, speaker: 'S1' }]);
    expect(r.map(span)).toEqual([[0, 1], [1, 1.4], [1.5, 1.9], [2, 2.4]]);
  });

  it('overlapping speech keeps both speakers and positive durations', () => {
    const r = run('Can you hear me? Yes I can. Good.', [
      { text: 'can', start: 0, end: 0.3, speaker: 'S1' }, { text: 'you', start: 0.3, end: 0.5, speaker: 'S1' },
      { text: 'hear', start: 0.5, end: 0.8, speaker: 'S1' }, { text: 'yes', start: 0.6, end: 0.9, speaker: 'S2' },
      { text: 'me', start: 0.8, end: 1.2, speaker: 'S1' }, { text: 'I', start: 0.95, end: 1.0, speaker: 'S2' },
      { text: 'can', start: 1.0, end: 1.3, speaker: 'S2' }, { text: 'good', start: 1.5, end: 1.8, speaker: 'S1' }]);
    expect(word(r, 'I').speaker).toBe('S2');
    expect(word(r, 'can.').speaker).toBe('S2');
    expect(word(r, 'Good.')).toMatchObject({ start: 1.5, end: 1.8, speaker: 'S1' });
  });

  it('zero-length timing words get a small positive duration', () => {
    const r = run('A b c.', [{ text: 'a', start: 1, end: 1, speaker: 'S1' }, { text: 'b', start: 1, end: 1, speaker: 'S1' }, { text: 'c', start: 1, end: 1.2, speaker: 'S1' }]);
    expect(r[0].start).toBe(1);
    expect(r[2].end).toBe(1.2);
  });

  it('words never run past the media duration', () => {
    const timed = [{ text: 'hello', start: 0, end: 0.5, speaker: 'S1' }, { text: 'world', start: 0.6, end: 2.4, speaker: 'S1' }];
    const r = run('Hello world and more words here.', timed, 'en', { duration: 2 });
    expect(r[r.length - 1].end).toBeLessThanOrEqual(2);
  });
});

describe('a media duration too short for the text', () => {
  it('words are compressed to fit instead of running past it', () => {
    const words = Array.from({ length: 300 }, (_, i) => `w${i}`);
    const r = alignWords(words, [], { language: 'en', duration: 1 });
    expect(violations(words, [], r, 1)).toEqual([]);
    expect(Math.max(...r.map((w) => w.end - w.start))).toBeLessThan(0.01);
  });

  it('timing words past the duration are pulled back inside it', () => {
    const text = 'so this is a sentence with some words in it and more words after that';
    const r = run(text, text.split(' ').map((w, i) => ({ text: w, start: i * 0.5, end: i * 0.5 + 0.4, speaker: 'S1' })), 'en', { duration: 3 });
    expect(r[r.length - 1].end).toBeLessThanOrEqual(3);
  });
});

describe('words only the text has at the edges', () => {
  it('trailing words get natural durations up to the media duration', () => {
    const r = run('Hello there. And goodbye to everyone here.', az('hello there'), 'en', { duration: 10 });
    const tail = r.slice(2);
    expect(tail[0].start).toBeGreaterThanOrEqual(0.9);
    expect(tail.every((w) => w.match === 'interpolated' && w.end - w.start >= 0.1 && w.end - w.start <= 1)).toBe(true);
    expect(tail[tail.length - 1].end - tail[0].start).toBeGreaterThan(1);
  });

  it('trailing words are squeezed rather than run past a short media duration', () => {
    const r = run('Hello there. And goodbye to everyone here.', az('hello there'), 'en', { duration: 1.5 });
    expect(r[r.length - 1].end).toBeLessThanOrEqual(1.5);
  });

  it('leading words get natural durations before the first timing word', () => {
    const r = run('So, well, hello there.', az('hello there', { start: 3 }));
    expect(r[0].start).toBeLessThan(2.8);
    expect(r[1].end).toBeLessThanOrEqual(3);
  });
});

describe('number phrases map by spoken parts', () => {
  it('digits ↔ number words: the number takes the number words, the unit its word', () => {
    const r = run('It costs 25 percent more.', az('it costs twenty five percent more'));
    expect(span(word(r, '25'))).toEqual([1, 1.9]);
    expect(span(word(r, 'percent'))).toEqual([2, 2.4]);
  });

  it('scale words belong to the number', () => {
    const r = run('We paid 1,000 dollars.', az('we paid one thousand dollars'));
    expect(span(word(r, '1,000'))).toEqual([1, 1.9]);
    expect(span(word(r, 'dollars.'))).toEqual([2, 2.4]);
  });

  it('number words ↔ digits', () => {
    const r = run('It costs twenty five percent more.', az('it costs 25 percent more'));
    expect(word(r, 'twenty').start).toBe(1);
    expect(word(r, 'five').end).toBe(1.4);
    expect(span(word(r, 'percent'))).toEqual([1.5, 1.9]);
  });
});

describe('short words do not anchor inside garbled stretches', () => {
  it('"to" ↔ "go" is not trusted', () => {
    const r = run('Hello there. We have to make sure that every customer. Thank you.',
      cat(az('hello there'), az('go zorp blik fant', { start: 1 }), az('thank you', { start: 3 })));
    const mid = r.slice(2, -2);
    expect(mid.every((w) => w.match === 'fuzzy' && w.confidence < 0.5)).toBe(true);
    expect(mid[0].start).toBe(1);
    expect(mid[mid.length - 1].end).toBe(2.9);
  });
});

// Probe set: every case must satisfy the invariants (exact timings are covered above).
const garbage = 'zorp blik fant quex dravo mirn tolk shup vemble grax plon dwik sarn fobble kerv mipt yonx brel quazz tisk vorp nulm gesh trog wibbel frunk zist hapt lorm crev';
const real = 'we have to make sure that every single customer gets a clear answer before the end of the week because otherwise they will call us again';
const PROBES: Array<[string, string, TimedWord[], string?, AlignOptions?]> = [
  ['brand merge', 'Insure your car with CarCover today.', az('insure your car with car cover today')],
  ['brand allianz', 'Allianz pays the claim.', az('alliance pays the claim')],
  ['brand garbled short', 'Ask Qover for a quote.', az('ask cover for a quote')],
  ['dropped word', 'I really think that we should go.', az('I think that we should go')],
  ['fillers+stutters', 'I think we should go now.', az('I uh I think um we we should go now')],
  ['stutter partial', 'The theory is sound.', az('the the- theory is sound')],
  ['nl compound merge+brand', 'Dit is de autoverzekering van CarCover.', az('dit is de auto verzekering van car cover'), 'nl'],
  ['nl compound split', 'Dit is de auto verzekering.', az('dit is de autoverzekering'), 'nl'],
  ['numbers en', 'It costs twelve euros, or 25 percent more in 2024.', az('it costs €12 or twenty five percent more in twenty twenty four')],
  ['numbers en rev', 'It costs €12, or twenty-five percent more.', az('it costs twelve euros or 25% more')],
  ['numbers nl', 'Het kost vijfentwintig euro in 2024.', az('het kost 25 euro in tweeduizend vierentwintig'), 'nl'],
  ['numbers nl rev', 'Het kost 25 euro, 3 keer.', az('het kost vijfentwintig euro drie keer'), 'nl'],
  ['punct', 'Well—I mean, it\'s fine... "really".', az('well I mean it is fine really')],
  ['nl er', 'Er is een probleem, er zijn er twee.', az('er is een probleem er zijn er twee'), 'nl'],
  ['nl er timing-only', 'Is dat een probleem?', az('er is dat een probleem'), 'nl'],
  ['nl er text-only', 'Er is een probleem.', az('is een probleem'), 'nl'],
  ['en er filler', 'So I think it works.', az('so er I think er it works')],
  ['nl euh', 'Dus we gaan.', az('dus euh we gaan'), 'nl'],
  ['30-word garbage', `Hello there. ${real}. Thank you.`, cat(az('hello there'), az(garbage, { start: 1.0, step: 0.3, dur: 0.25 }), az('thank you', { start: 10.0 }))],
  ['missed sentence', 'Hello there. This sentence was missed entirely. Thank you.', cat(az('hello there'), az('thank you', { start: 5.0 }))],
  ['timing-only sentence', 'Hello there. Thank you.', cat(az('hello there'), az('some extra words azure heard', { start: 1.0 }), az('thank you', { start: 4.0 }))],
  ['text extra at start', 'So, well, hello there.', az('hello there')],
  ['text extra at end, no duration', 'Hello there. And goodbye to everyone here.', az('hello there')],
  ['speaker change mid-sentence', 'I think we should, yes I agree completely.', az('I think we should yes I agree completely', { speakers: ['S1', 'S1', 'S1', 'S1', 'S2', 'S2', 'S2', 'S2'] })],
  ['speaker change inside merge', 'CarCover is great', az('car cover is great', { speakers: ['S1', 'S2', 'S2', 'S2'] })],
  ['many text-only words between tight anchors', 'Go one two three four five six seven now.', az('go now', { step: 0.4, dur: 0.4 })],
  ['empty timing', 'Hello there.', [], 'en', { duration: 5 }],
  ['empty timing, no duration', 'Hello there.', []],
  ['unknown language', 'Bonjour à tous, merci.', az('bonjour a tous merci'), 'fr'],
  ['punctuation only', '¡ … !', az('hello')],
  ['repeated phrase', 'the cat the cat the cat sat', az('the cat the cat sat')],
  ['brand 3-way', 'Try SafeDriveNow today.', az('try safe drive now today')],
  ['brand 4-way', 'Try SafeDriveNowPlus today.', az('try safe drive now plus today')],
  ['ok/okay, dr/doctor', 'OK, Dr. Smith will see you.', az('okay doctor smith will see you')],
  ['1,000 vs one thousand', 'We paid 1,000 dollars or $5 million total.', az('we paid one thousand dollars or five million dollars total')],
  ['10:30 vs ten thirty', 'Meet at 10:30 tomorrow.', az('meet at ten thirty tomorrow')],
  ['COVID-19', 'After COVID-19 things changed.', az('after covid nineteen things changed')],
  ['nl tijd', 'Om 10.30 uur beginnen we.', az('om half elf beginnen we'), 'nl'],
  ['contractions', "We're sure it won't fail.", az('we are sure it will not fail')],
  ['contractions rev', 'We are sure it will not fail.', az("we're sure it won't fail")],
  ['timing merges two words', 'a lot of every day things', az('alot of everyday things')],
  ['timing partial stutter', 'Insurance matters.', az('in insurance matters')],
  ['nl zijn er er', 'Zijn er vragen?', az('zijn er er vragen'), 'nl'],
  ['text er (en)', 'Er, I think so.', az('I think so')],
  ['timing beyond duration', 'Hello there.', az('hello there'), 'en', { duration: 0.6 }],
  ['timing words unsorted', 'one two three', [{ text: 'three', start: 1, end: 1.4 }, { text: 'one', start: 0, end: 0.4 }, { text: 'two', start: 0.5, end: 0.9 }]],
];

describe('probe set: invariants', () => {
  it.each(PROBES)('%s', (_name, text, timed, lang, extra) => {
    run(text, timed, lang ?? 'en', extra ?? {});
  });
});

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('seeded random stress', () => {
  /** Random text, and a timing side with substitutions, drops, insertions, fillers, merged words and one-sided gaps. */
  function scenario(seed: number, minVocab = 8): { words: string[]; timed: TimedWord[]; duration?: number } {
    const rnd = rng(seed);
    const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
    const letters = 'abcdefghijklmnoprstuvwyz';
    const vocab = Array.from({ length: int(minVocab, 80) }, () => Array.from({ length: int(1, 8) }, () => letters[int(0, letters.length - 1)]).join(''));
    const pick = (): string => vocab[int(0, vocab.length - 1)];
    const n = int(1, 300);
    const words = Array.from({ length: n }, () => {
      const w = pick();
      const r = rnd();
      return r < 0.05 ? `${w[0].toUpperCase()}${w.slice(1)}.` : r < 0.1 ? `${w},` : r < 0.12 ? String(int(1, 99)) : w;
    });
    const b: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const r = rnd();
      if (r < 0.06) continue; // dropped
      if (r < 0.14) b.push(rnd() < 0.5 ? pick() : w.slice(0, -1) + 'x'); // substituted / misheard
      else if (r < 0.17 && i + 1 < words.length) { b.push(w + words[i + 1]); i++; } // merged
      else b.push(w);
      if (rnd() < 0.04) b.push(rnd() < 0.5 ? 'uh' : pick()); // filler or extra word
    }
    const g = rnd();
    const at = int(0, b.length);
    if (g < 0.25) b.splice(at, int(5, 80));
    else if (g < 0.5) b.splice(at, 0, ...Array.from({ length: int(5, 80) }, pick));
    let t = rnd() * 2;
    let speaker = 'S1';
    const timed: TimedWord[] = b.map((text) => {
      if (rnd() < 0.03) t += 2 + rnd() * 4; // long pause
      if (rnd() < 0.05) speaker = speaker === 'S1' ? 'S2' : 'S1';
      const start = +t.toFixed(3);
      const dur = rnd() < 0.02 ? 0 : 0.05 + rnd() * 0.6;
      t += dur + rnd() * 0.3 - (rnd() < 0.05 ? 0.4 : 0); // occasional overlap
      t = Math.max(t, start);
      return { text, start, end: +(start + dur).toFixed(3), speaker };
    });
    const last = timed.length ? Math.max(...timed.map((w) => w.end)) : 0;
    const d = rnd();
    return { words, timed, duration: d < 0.4 ? undefined : d < 0.8 ? +(last + rnd() * 5).toFixed(3) : +(last * 0.9).toFixed(3) };
  }

  it('alignWords keeps its invariants on random input', () => {
    for (let seed = 1; seed <= 250; seed++) {
      const { words, timed, duration } = scenario(seed);
      const r = alignWords(words, timed, { language: 'en', duration });
      const p = violations(words, timed, r, duration);
      if (p.length) throw new Error(`seed ${seed}: ${p.slice(0, 5).join('; ')}`);
    }
  });

  const unit = (w: string): Unit => ({ key: w.toLowerCase().replace(/[.,]/g, ''), filler: w === 'uh' });
  const sides = (seed: number, minVocab: number): [Unit[], Unit[]] => {
    const { words, timed } = scenario(seed, minVocab);
    return [words.map(unit), timed.map((w) => unit(w.text))];
  };

  it('anchored segmentation finds an optimal alignment (same cost as the full matrix)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const [A, B] = sides(seed, 25);
      const full = opsCost(alignUnits(A, B, { band: Infinity }), B);
      // anchors at every level, then the full matrix per segment …
      expect(opsCost(alignUnits(A, B, { directCells: 16 }), B), `seed ${seed}`).toBeCloseTo(full, 9);
      // … or a band of ±8 around each anchor-free segment's diagonal
      expect(opsCost(alignUnits(A, B, { band: 8, directCells: 16, fullCells: 0 }), B), `seed ${seed}`).toBeCloseTo(full, 9);
      // the default path for inputs this small is the full matrix itself
      if (seed <= 30) expect(alignUnits(A, B)).toEqual(alignUnits(A, B, { band: Infinity }));
    }
  });

  it('with a tiny vocabulary anchors stay close to the optimum', () => {
    // 8-word vocabularies make chance matches everywhere; the cost optimum then scatters words over a gap while the
    // anchors keep runs together, so a few seeds may cost slightly more (never more than 5%).
    let worse = 0;
    for (let seed = 1; seed <= 100; seed++) {
      const [A, B] = sides(seed, 8);
      const full = opsCost(alignUnits(A, B, { band: Infinity }), B);
      const seg = opsCost(alignUnits(A, B, { directCells: 16 }), B);
      expect(seg, `seed ${seed}`).toBeLessThanOrEqual(full * 1.05 + 1e-9);
      if (seg > full + 1e-9) worse++;
    }
    expect(worse).toBeLessThanOrEqual(4);
  });
});
