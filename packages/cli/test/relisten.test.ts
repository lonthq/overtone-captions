import { describe, expect, it } from 'vitest';
import { alignWords } from '../src/align/align.js';
import { RELISTEN, relisten, unheardStretches, windowOf, type Listener } from '../src/align/relisten.js';
import { memoryLogger } from '../src/log.js';
import { tokenizeDisplay } from '../src/text/normalize.js';
import type { AlignedWord, TimedWord } from '../src/types.js';

/** Timed words of `text` from `start`, one every `step` seconds, each 80 % of a step long. */
const said = (text: string, start: number, step = 0.3, speaker = 'S1'): TimedWord[] =>
  text.split(' ').map((t, i) => ({ text: t, start: +(start + i * step).toFixed(3), end: +(start + i * step + step * 0.8).toFixed(3), speaker }));

// Tears of Steel (Azure Speech): the timing provider heard nothing of the shouting over music in
// 207.7–224.6 s; the text has 15 words there. ElevenLabs Scribe heard them at 208.0–215.7 s and 222.9–223.8 s.
const BEFORE = said('All systems go. You go.', 205.4, 0.45, 'S8');
const AFTER = said('Nothing to worry about, Tom.', 224.64, 0.25, 'S8');
const SHOUTS = 'Go! Move your asses! Go, go, go! I love it. Come on! Go! That\'s nice.';
const TEXT = tokenizeDisplay(`All systems go. You go. ${SHOUTS} Nothing to worry about, Tom.`);
const HEARD_SHOUTS: TimedWord[] = [
  ...said('Go!', 208.04), ...said('Move your asses!', 209.92, 0.3), ...said('Go, go, go!', 211.18, 0.3), ...said('I love it.', 213.2, 0.32),
  ...said('Come on!', 214.24, 0.5), ...said('Go!', 215.44), ...said("That's nice.", 222.92, 0.4),
];
const DURATION = 240;
const first = (): AlignedWord[] => alignWords(TEXT, [...BEFORE, ...AFTER], { language: 'en', duration: DURATION });

/** A listener that answers `words` (absolute times) inside the window it is asked for, and records the windows. */
function listener(id: string, words: TimedWord[] | ((start: number, end: number) => TimedWord[])): Listener & { asked: Array<[number, number]> } {
  const asked: Array<[number, number]> = [];
  return {
    id, role: id.startsWith('second') ? 'second opinion' : 'timing provider', asked,
    listen: async (start, end) => {
      asked.push([start, end]);
      const all = typeof words === 'function' ? words(start, end) : words;
      return all.filter((w) => w.start >= start && w.end <= end);
    },
  };
}

describe('unheard stretches', () => {
  it('finds interpolated words in a gap of at least 2 s, or at least 4 interpolated words in a row', () => {
    expect(RELISTEN).toMatchObject({ minGap: 2, minWords: 4, pad: 0.5, maxWindow: 120 });
    const w = (start: number, end: number, match: AlignedWord['match'] = 'exact') => ({ start, end, match });
    // one word in a 1.5 s gap: no; one word in a 2 s gap: yes
    expect(unheardStretches([w(0, 1), w(1, 1.5, 'interpolated'), w(2.5, 3)], 10)).toEqual([]);
    expect(unheardStretches([w(0, 1), w(1, 1.5, 'interpolated'), w(3, 3.5)], 10)).toEqual([{ first: 1, last: 1, start: 1, end: 3 }]);
    // four words squeezed into 0.5 s
    const four = [w(0, 1), ...[0, 1, 2, 3].map((k) => w(1 + k * 0.1, 1.1 + k * 0.1, 'interpolated')), w(1.5, 2)];
    expect(unheardStretches(four, 10)).toEqual([{ first: 1, last: 4, start: 1, end: 1.5 }]);
    // at the start and the end of the media
    expect(unheardStretches([w(0, 0.3, 'interpolated'), w(4, 5)], 10)).toEqual([{ first: 0, last: 0, start: 0, end: 4 }]);
    expect(unheardStretches([w(0, 1), w(9.5, 9.9, 'interpolated')], 10)).toEqual([{ first: 1, last: 1, start: 1, end: 10 }]);
  });

  it('sends the gap with up to 3 context words on each side, padded by 0.5 s', () => {
    const words = first();
    const [s] = unheardStretches(words, DURATION);
    expect(words.slice(s.first, s.last + 1).map((w) => w.text).join(' ')).toBe(SHOUTS);
    expect([s.start, s.end]).toEqual([words[s.first - 1].end, 224.64]);
    // "go. You go." before (from 205.4 + 2 · 0.45 = 206.3 s), "Nothing to worry" after (to 225.34 s)
    expect(windowOf(words, s, DURATION)).toEqual({ start: 205.8, end: 225.84 });
  });
});

describe('re-listening', () => {
  it('without re-listening, the 15 shouted words get unknown times: one block of natural length in the middle of the gap', () => {
    const words = first();
    const idx = words.map((_, i) => i).filter((i) => words[i].match === 'interpolated');
    expect(idx).toHaveLength(15);
    const go = words[idx[0]];
    const nice = words[idx[14]];
    expect(idx.every((i) => words[i].confidence === 0)).toBe(true);
    // centred in the gap (207.56–224.64 s), no punctuation or speaker rules
    expect((go.start + nice.end) / 2).toBeCloseTo((words[idx[0] - 1].end + words[idx[14] + 1].start) / 2, 0);
    expect(nice.end - go.start).toBeLessThan(10);
  });

  it("takes the times from another engine's whole-file words first, for every unheard stretch and without a request", async () => {
    const whole: Listener = { id: 'second-b', role: 'whole file', whole: true, listen: async (s, e) => HEARD_SHOUTS.filter((w) => w.end > s && w.start < e) };
    const a = listener('fake-a', HEARD_SHOUTS);
    const res = await relisten(first(), { language: 'en', duration: DURATION }, { listeners: [whole, a] });
    expect(a.asked).toEqual([]); // the whole-file words heard all of it: no snippet request
    expect(res.retries).toEqual([]); // only requests are recorded
    expect(res.words.find((w) => w.text === 'Go!')).toMatchObject({ start: 208.04, match: 'exact' });
    // a single unheard word in a short gap (below the snippet limits) is looked up too
    const short = alignWords(tokenizeDisplay('Hello there my friend.'), [...said('Hello there', 1), ...said('friend.', 1.9)], { language: 'en', duration: 5 });
    expect(short[2].match).toBe('interpolated');
    const my: Listener = { id: 'b', role: 'whole file', whole: true, listen: async () => said('my', 1.6) };
    const got = await relisten(short, { language: 'en', duration: 5 }, { listeners: [my] });
    expect(got.words[2]).toMatchObject({ text: 'my', start: 1.6, match: 'exact' });
  });

  it('takes the times the timing provider hears when the stretch is sent again (layer 1)', async () => {
    const a = listener('fake-a', HEARD_SHOUTS);
    const b = listener('second-b', []);
    const log = memoryLogger();
    const res = await relisten(first(), { language: 'en', duration: DURATION }, { listeners: [a, b], log });
    expect(a.asked).toEqual([[205.8, 225.84]]);
    expect(b.asked).toEqual([]); // everything heard: no second opinion
    expect(res.retries).toEqual([{ start: expect.closeTo(207.56, 2), end: 224.64, words: 15, provider: 'fake-a', heard: 15, result: 'heard' }]);
    const go = res.words.find((w) => w.text === 'Go!')!;
    expect(go).toMatchObject({ start: 208.04, match: 'exact', speaker: 'S8' });
    expect(res.words.find((w) => w.text === 'nice.')).toMatchObject({ start: 223.32, match: 'exact' });
    // the word keeps what the timing side heard
    expect(go.heard).toMatchObject({ text: 'Go!' });
    expect(log.lines).toContain('info:   timing: 15 words in 207.56–224.64 s ("Go! Move your asses! Go, go, go! I love it. Come on! Go!…") have no timing words; asking fake-a (timing provider) for 205.80–225.84 s');
    expect(log.lines).toContain('info:   timing: fake-a heard all 15');
    // the other words keep their times
    const before = first();
    res.words.forEach((w, i) => { if (before[i].match !== 'interpolated') expect([w.start, w.end]).toEqual([before[i].start, before[i].end]); });
  });

  it('asks the second opinion when the timing provider hears nothing again (layer 2)', async () => {
    const a = listener('fake-a', []);
    const b = listener('second-b', HEARD_SHOUTS);
    const res = await relisten(first(), { language: 'en', duration: DURATION }, { listeners: [a, b] });
    expect(b.asked).toEqual(a.asked);
    expect(res.retries.map((r) => [r.provider, r.heard, r.result])).toEqual([['fake-a', 0, 'none'], ['second-b', 15, 'heard']]);
    expect(res.words.find((w) => w.text === 'Move')).toMatchObject({ start: 209.92, match: 'exact' });
  });

  it('keeps the hearing with more words, and adds a word only the other one heard where it fits', async () => {
    // the timing provider hears the first lines only; the second opinion all but "Move"
    const a = listener('fake-a', HEARD_SHOUTS.slice(0, 4));
    const b = listener('second-b', HEARD_SHOUTS.filter((w) => w.text !== 'Move'));
    const res = await relisten(first(), { language: 'en', duration: DURATION }, { listeners: [a, b] });
    expect(res.retries.map((r) => [r.provider, r.heard, r.result])).toEqual([['fake-a', 4, 'partial'], ['second-b', 14, 'partial']]);
    expect(res.words.filter((w) => w.start > 207.6 && w.start < 224.6).every((w) => w.match === 'exact')).toBe(true);
    expect(res.words.find((w) => w.text === 'Move')).toMatchObject({ start: 209.92 });
  });

  it("does not take a word heard on top of an anchor: that is the anchor's own audio", async () => {
    // the window starts in "You go."; the provider hears only that "go." again
    const a = listener('fake-a', said('go.', 207.2));
    const res = await relisten(first(), { language: 'en', duration: DURATION }, { listeners: [a] });
    expect(res.retries).toEqual([expect.objectContaining({ provider: 'fake-a', heard: 0, result: 'none' })]);
  });

  it('keeps the unknown times of what no engine heard', async () => {
    const before = first();
    const res = await relisten(before, { language: 'en', duration: DURATION }, { listeners: [listener('fake-a', [])] });
    expect(res.retries).toEqual([{ start: expect.closeTo(207.56, 2), end: 224.64, words: 15, provider: 'fake-a', heard: 0, result: 'none' }]);
    expect(res.words.map((w) => [w.start, w.end])).toEqual(before.map((w) => [w.start, w.end]));
    expect(res.words.filter((w) => w.match === 'interpolated')).toHaveLength(15);
  });

  it('does not send a window longer than 120 s', async () => {
    const words = alignWords(tokenizeDisplay('Hello there. Are you there? Bye now.'), [...said('Hello there.', 1), ...said('Bye now.', 200)], { language: 'en', duration: 210 });
    const a = listener('fake-a', []);
    const log = memoryLogger();
    const res = await relisten(words, { language: 'en', duration: 210 }, { listeners: [a], log });
    expect(a.asked).toEqual([]);
    expect(res.retries).toEqual([]);
    expect(log.lines.some((l) => l.includes('the gap is longer than 120 s, so it is not sent again'))).toBe(true);
  });

  it('changes nothing when every word was heard', async () => {
    const words = alignWords(tokenizeDisplay('Hello there.'), said('Hello there.', 1), { language: 'en' });
    const a = listener('fake-a', []);
    const res = await relisten(words, { language: 'en', duration: 5 }, { listeners: [a] });
    expect(a.asked).toEqual([]);
    expect(res).toEqual({ words, retries: [] });
  });
});
