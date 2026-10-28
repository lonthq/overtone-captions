import { beforeAll, describe, expect, it } from 'vitest';
import { assignSpeakers } from '../src/align/speakers.js';
import { hear, speakerEngine, speakersHeard, textBase, trimStretched, withSnippets, type EngineHearing } from '../src/hearings.js';
import type { LlmRequest } from '../src/providers/types.js';
import { loadPhonetics, phrase, soundSimilarity } from '../src/reconcile/phonetics.js';
import { agree, findRegions, wordSimilarity, type TextWord } from '../src/reconcile/regions.js';
import { acceptChange, assessVote, mapBack, soundsLike } from '../src/reconcile/vote.js';
import type { TimedWord } from '../src/types.js';

/** Words of `text` from `start`, one every `step` seconds, each 80 % of a step long. */
const said = (text: string, start: number, step = 0.3, speaker = 'S1'): TimedWord[] =>
  text.split(' ').map((t, i) => ({ text: t, start: +(start + i * step).toFixed(3), end: +(start + i * step + step * 0.8).toFixed(3), speaker }));
const caption = (text: string, start: number, step = 0.3): TextWord[] => said(text, start, step).map(({ text: t, start: s, end: e }) => ({ text: t, start: s, end: e }));

beforeAll(async () => { await loadPhonetics(); });

describe('how words sound', () => {
  it('spells English from the CMU dictionary, other languages by rules, and counts syllables', () => {
    expect(phrase('jerk', 'en')).toEqual({ phones: ['JH', 'ER', 'K'], syllables: 1 });
    expect(phrase('adlib', 'en').syllables).toBe(2); // a compound of two dictionary words
    expect(phrase('weersverschijnselen', 'nl').syllables).toBeGreaterThanOrEqual(4);
    expect(phrase('Zwölf', 'de').phones.length).toBeGreaterThan(2);
  });

  it('lets names and numbers that sound the same agree, and near homophones not (glass/class)', () => {
    expect(agree('Thom', 'Tom', 'en')).toBe(true);
    expect(agree('ten', '10', 'en')).toBe(true);
    expect(agree('glass.', 'class.', 'en')).toBe(false);
    expect(wordSimilarity('glass', 'class', 'en')).toBeGreaterThan(0.9);
    expect(soundSimilarity('You jerked up.', "You're a jerk, Thom.", 'en').similarity).toBeGreaterThan(0.6);
  });
});

describe('disagreement regions', () => {
  const T = caption('All systems go. You jerked up. Look, Celia.', 1);
  const azure = said("All systems go. You're a jerk, Tom. Look, Celia.", 1);
  const scribe = said("All systems go. You're a jerk, Thom. Look, Celia.", 1);
  const engines = [{ id: 'azure', label: 'Azure Speech', words: azure }, { id: 'scribe', label: 'ElevenLabs Scribe', words: scribe }];

  it('finds where the caption differs from two engines that agree (class b), with the words each heard', () => {
    const [r, ...rest] = findRegions(T, engines, { language: 'en', precise: 1 });
    expect(rest).toEqual([]);
    expect(r).toMatchObject({ cls: 'b', text: 'You jerked up.' });
    expect(r!.heard.map((ws) => ws.map((w) => w.text).join(' '))).toEqual(["You're a jerk, Tom.", "You're a jerk, Thom."]);
  });

  it('returns (does not hang) when the text\'s times go backwards', () => {
    const backwards: TextWord[] = [{ text: 'late', start: 1000, end: 1000.3 }, { text: 'early', start: 0, end: 0.3 }, { text: 'again', start: 0.5, end: 0.8 }];
    const many = Array.from({ length: 200 }, (_, k) => ({ text: `w${k}`, start: k * 0.5, end: k * 0.5 + 0.4, speaker: 'S1' }));
    expect(Array.isArray(findRegions(backwards, [{ id: 'e', label: 'E', words: many }], { language: 'en' }))).toBe(true);
  }, 5000);

  it('a stretch only the engines heard is class a when they agree, c when only one heard it', () => {
    const caption2 = caption('Go! Go, go, go!', 10);
    const extra = (ws: TimedWord[]) => [...ws, ...said('Move your asses!', 12)].sort((a, b) => a.start - b.start);
    const two = findRegions(caption2, [{ id: 'a', label: 'A', words: extra(said('Go! Go, go, go!', 10)) }, { id: 'e', label: 'E', words: extra(said('Go! Go, go, go!', 10)) }], { language: 'en' });
    expect(two.map((r) => [r.cls, r.text, r.first - r.last])).toEqual([['a', '', 1]]);
    const one = findRegions(caption2, [{ id: 'a', label: 'A', words: said('Go! Go, go, go!', 10) }, { id: 'e', label: 'E', words: extra(said('Go! Go, go, go!', 10)) }], { language: 'en' });
    expect(one.map((r) => r.cls)).toEqual(['c']);
  });

  it('is no disagreement when one word is written as two ("$12" ↔ "12 dollars")', () => {
    const c = caption('for just $12 a month.', 1);
    const heard = said('for just 12 dollars a month.', 1);
    expect(findRegions(c, [{ id: 'a', label: 'A', words: heard }], { language: 'en' })).toEqual([]);
  });

  it('an engine whose words are the caption (the text engine gave none) does not vote', () => {
    const c = caption('he said yes', 1);
    expect(findRegions(c, [{ id: 'a', label: 'A', words: said('he said no', 1) }], { language: 'en', textIsEngine: 0 })).toEqual([]);
  });
});

describe('the gate of the vote', () => {
  const region = (cls: 'a' | 'b' | 'c', text: string) => ({ id: 0, cls, sub: '', first: 0, last: text ? 0 : -1, start: 0, end: 1, text, heard: [], around: {} });
  const ok = { id: 0, decision: 'change' as const, basis: '' };

  it('trusts the chooser\'s change, never an empty one, and lists a reading no engine heard', () => {
    expect(acceptChange(region('c', 'You jerked up.'), { ...ok, text: "You're a jerk, Thom." }, { language: 'en', engineText: ["You're a jerk, Tom."], relisten: '', showRelisten: true })).toBeNull();
    expect(acceptChange(region('c', 'You jerked up.'), { ...ok, text: '' }, { language: 'en', engineText: ['x'], relisten: '', showRelisten: true })).toBe('empty');
    const v = assessVote(region('c', 'Do the'), { ...ok, text: 'Something else entirely here' }, { language: 'en', engineText: ['Good'], relisten: '', showRelisten: true });
    expect(v).toEqual({ why: null, review: 'the chooser wrote "Something else entirely here"; no engine heard it so there' });
    expect(assessVote(region('c', 'twelve dollars'), { ...ok, text: '$15' }, { language: 'en', engineText: ['$15'], relisten: '', showRelisten: true })).toEqual({ why: null });
  });

  it('does not count an empty hearing against a change', () => {
    expect(soundsLike('Move your asses!', ['', 'Move your asses!'], 'en')).toBe(1);
    expect(acceptChange(region('c', ''), { ...ok, text: 'Move your asses!' }, { language: 'en', engineText: ['', 'Move your asses!'], relisten: '', showRelisten: true })).toBeNull();
  });

  it('vetoes a class a or b change when the re-listen sounds more like the caption (LibriSpeech "then", not "and")', () => {
    const r = region('b', 'then');
    expect(acceptChange(r, { ...ok, text: 'and' }, { language: 'en', engineText: ['and', 'and'], relisten: 'then', showRelisten: false })).toBe('relisten');
    // an empty re-listen decides nothing
    expect(acceptChange(r, { ...ok, text: 'and' }, { language: 'en', engineText: ['and', 'and'], relisten: '', showRelisten: false })).toBeNull();
  });

  it('maps a re-listen of the whole snippet back to the region', () => {
    const window = ['sorry.', 'Do', 'the', 'ad', 'lib.', 'Not', 'my'];
    expect(mapBack(window, 'sorry. Good ad lib. Not my'.split(' '), 1, 2).join(' ')).toBe('Good');
    expect(mapBack(['it', 'goes.'], 'it really goes.'.split(' '), 1, 0).join(' ')).toBe('really');
  });
});

describe('hearings', () => {
  it('a chunk the text engine left empty takes the second engine\'s words, else the timing provider\'s', () => {
    const azure: EngineHearing = { id: 'azure-speech', label: 'Azure Speech', words: said('he said no', 1) };
    const scribe: EngineHearing = { id: 'elevenlabs', label: 'ElevenLabs Scribe', words: said('he said so', 1) };
    const chunks = [{ start: 0, end: 10, text: '' }];
    const both = textBase(chunks, [azure, scribe], { duration: 10 });
    expect(both.chunks[0]).toMatchObject({ text: 'he said so', source: 'elevenlabs' });
    expect(both.textIsEngine).toBe(1);
    expect(both.fallbacks).toEqual([expect.objectContaining({ start: 0, end: 10, source: 'elevenlabs' })]);
    expect(textBase(chunks, [azure], { duration: 10 }).chunks[0]).toMatchObject({ text: 'he said no', source: 'azure-speech' });
    expect(textBase([{ start: 0, end: 10, text: 'kept' }], [azure, scribe], { duration: 10 })).toEqual({ chunks: [{ start: 0, end: 10, text: 'kept' }], fallbacks: [] });
  });

  it('an empty chunk the preferred engine heard nothing in takes another engine\'s words there', () => {
    // Scribe heard words in the first chunk only, Azure heard the second chunk too
    const azure: EngineHearing = { id: 'azure-speech', label: 'Azure Speech', words: [...said('one two', 1), ...said('three four', 12)] };
    const scribe: EngineHearing = { id: 'elevenlabs', label: 'ElevenLabs Scribe', words: said('one too', 1) };
    const res = textBase([{ start: 0, end: 10, text: '' }, { start: 10, end: 20, text: '' }], [azure, scribe], { duration: 20 });
    expect(res.chunks.map((c) => [c.text, c.source])).toEqual([['one too', 'elevenlabs'], ['three four', 'azure-speech']]);
    expect(res.fallbacks.map((f) => f.source)).toEqual(['elevenlabs', 'azure-speech']);
    // two engines gave the text: neither one is the whole text
    expect(res.textIsEngine).toBeUndefined();
  });

  it('adds snippet words only where the whole-file hearing has none', () => {
    const merged = withSnippets(said('a b', 1), [...said('b', 1.3), ...said('c', 5)]);
    expect(merged.map((w) => w.text)).toEqual(['a', 'b', 'c']);
  });

  it('adds a word two overlapping snippets heard once, and keeps different words close together', () => {
    const fast = said('I am ready', 10, 0.1);
    const merged = withSnippets([], [...fast, { ...fast[1]!, text: 'Am,', start: 10.12, end: 10.2 }]);
    expect(merged.map((w) => w.text)).toEqual(['I', 'am', 'ready']);
  });

  it('takes the times of the most precise engine and the speakers of another', async () => {
    const text = 'Hello there. Hi Maya!'.split(' ');
    const azure: EngineHearing = { id: 'azure', label: 'Azure Speech', words: [...said('Hello there.', 1, 0.4, 'S1'), ...said('Hi Maya!', 3, 0.4, 'S2')] };
    const scribe: EngineHearing = { id: 'scribe', label: 'ElevenLabs Scribe', words: [...said('Hello there.', 1.05, 0.35, 'speaker_0'), ...said('Hi Maya!', 3.05, 0.35, 'speaker_0')] };
    const res = await hear({ text, engines: [azure, scribe], timeBy: 1, speakersBy: 0, language: 'en', duration: 5 });
    expect(res.words.map((w) => [w.text, w.start, w.speaker])).toEqual([['Hello', 1.05, 'S1'], ['there.', 1.4, 'S1'], ['Hi', 3.05, 'S2'], ['Maya!', 3.4, 'S2']]);
    expect(res.votes).toEqual([]); // no chooser: no vote
  });

  it('votes, and times the new words from the hearings without new requests', async () => {
    const text = 'All systems go. You jerked up. Look, Celia.'.split(' ');
    const azure: EngineHearing = { id: 'azure', label: 'Azure Speech', words: said("All systems go. You're a jerk, Tom. Look, Celia.", 1) };
    const scribe: EngineHearing = { id: 'scribe', label: 'ElevenLabs Scribe', words: said("All systems go. You're a jerk, Thom. Look, Celia.", 1) };
    const asked: string[] = [];
    const llm = {
      id: 'fake',
      async complete<T>(req: LlmRequest): Promise<T> {
        asked.push(req.name);
        const id = /^### (\d+) /m.exec(req.user)![1]!;
        return { spans: [{ id, decision: 'change', text: "You're a jerk, Thom.", basis: 'both engines' }] } as T;
      },
    };
    const res = await hear({ text, engines: [azure, scribe], timeBy: 1, speakersBy: 0, language: 'en', duration: 10 }, { llm, relistenText: async () => "You're a jerk, Thom." });
    expect(asked).toEqual(['choose']);
    expect(res.words.map((w) => w.text).join(' ')).toBe("All systems go. You're a jerk, Thom. Look, Celia.");
    expect(res.words.find((w) => w.text === 'jerk,')).toMatchObject({ start: 2.5, match: 'exact' });
    expect(res.votes).toEqual([expect.objectContaining({ class: 'b', from: 'You jerked up.', to: "You're a jerk, Thom.", result: 'changed' })]);
  });

  it('ends a word an engine stretched over the music after its natural length (Tears of Steel 8:58)', async () => {
    // from a live run: Scribe timed "complete." 19.8 s, up to the next word; Azure 0.6 s
    const text = 'Memory override complete. You go.'.split(' ');
    const heard = (complete: TimedWord): TimedWord[] => [
      { text: 'Memory', start: 538.268, end: 538.6, speaker: 'S1' }, { text: 'override', start: 538.6, end: 538.908, speaker: 'S1' },
      complete, ...said('You go.', 559.208),
    ];
    const azure: EngineHearing = { id: 'azure', label: 'Azure Speech', words: heard({ text: 'complete.', start: 538.87, end: 539.47, speaker: 'S1' }) };
    const scribe: EngineHearing = { id: 'scribe', label: 'ElevenLabs Scribe', words: heard({ text: 'complete.', start: 538.908, end: 558.708, speaker: 'S1' }) };
    const asked: string[] = [];
    const llm = { id: 'fake', async complete<T>(req: LlmRequest): Promise<T> { asked.push(req.name); return { spans: [] } as T; } };
    const res = await hear({ text, engines: [azure, scribe], timeBy: 1, speakersBy: 0, language: 'en', duration: 600 }, { llm, relistenText: async () => '' });
    const complete = res.words.find((w) => w.text === 'complete.')!;
    expect(complete.start).toBe(538.908);
    expect(complete.end).toBeCloseTo(538.908 + 9 * 0.047, 3); // "complete" and a pause, at Scribe's rate here (0.94 s for 20 characters)
    expect(asked).toEqual([]); // the engines agree: nothing to vote on
  });

  it('a word counts as stretched only when it is longer than 3 s and than 0.4 s per spoken character', () => {
    const words: TimedWord[] = [
      { text: 'But-', start: 0, end: 2.7, speaker: 'S1' }, // the longest word of the gate's fixtures
      { text: 'arbeidsongeschiktheidsverzekering', start: 3, end: 6.5, speaker: 'S1' },
      { text: 'Noooo!', start: 7, end: 10.5, speaker: 'S1' },
    ];
    expect(trimStretched(words, 'en').map((w) => w.end)).toEqual([2.7, 6.5, 7.42]); // 6 spoken characters × 0.07 s
    expect(trimStretched(words.slice(0, 2), 'en')).toEqual(words.slice(0, 2));
  });
});

describe('speakers from another engine', () => {
  it('takes the speaker of the engine word a word overlaps most', () => {
    const words = [{ start: 1, end: 1.5, speaker: 'x' }, { start: 5, end: 5.2, speaker: 'y' }];
    expect(assignSpeakers(words, [...said('a b', 1, 0.3, 'S1'), ...said('c', 5, 0.3, 'S2')]).map((w) => w.speaker)).toEqual(['S1', 'S2']);
    expect(assignSpeakers(words, said('a', 1).map(({ speaker: _s, ...w }) => w))).toEqual(words);
  });

  it('a word the engine did not hear keeps its own speaker, translated to the engine\'s labels', () => {
    // Scribe heard a reply ("Yeah.", speaker_1) that Azure did not; Azure calls that voice S2
    const words = [
      { start: 1, end: 1.4, speaker: 'speaker_0' }, { start: 2, end: 2.4, speaker: 'speaker_1' },
      { start: 2.6, end: 2.8, speaker: 'speaker_1' }, { start: 3, end: 3.4, speaker: 'speaker_0' },
    ];
    const azure = [{ text: 'a', start: 1, end: 1.4, speaker: 'S1' }, { text: 'b', start: 2, end: 2.4, speaker: 'S2' }, { text: 'd', start: 3, end: 3.4, speaker: 'S1' }];
    expect(assignSpeakers(words, azure).map((w) => w.speaker)).toEqual(['S1', 'S2', 'S2', 'S1']);
  });
});

describe('which engine tells the speakers', () => {
  const voices = (n: number, words = 30) => Array.from({ length: words }, (_, i) => ({ text: 'w', start: i, end: i + 0.5, speaker: `S${(i % n) + 1}` }));
  it('the one that told more voices apart, else the one that gives the times', () => {
    const azure: EngineHearing = { id: 'azure', label: 'Azure Speech', words: voices(4) };
    const scribe: EngineHearing = { id: 'scribe', label: 'ElevenLabs Scribe', words: voices(3) };
    expect(speakerEngine([azure, scribe], 1)).toBe(0);
    expect(speakerEngine([azure, { ...scribe, words: voices(4) }], 1)).toBe(1);
    // a speaker with a word or two (under 5 words and 2% of the words) does not count
    expect(speakersHeard([...voices(2, 300), { text: 'x', start: 400, end: 401, speaker: 'S9' }])).toBe(2);
  });
});
