import { beforeAll, describe, expect, it } from 'vitest';
import type { LlmRequest } from '../src/providers/types.js';
import { loadPhonetics } from '../src/reconcile/phonetics.js';
import type { Region, TextWord } from '../src/reconcile/regions.js';
import { acceptChange, assessVote, vote } from '../src/reconcile/vote.js';
import type { TimedWord } from '../src/types.js';

/** Words of `text` from `start`, one every `step` seconds, each 80 % of a step long. */
const said = (text: string, start: number, step = 0.3): TimedWord[] =>
  text.split(' ').map((t, i) => ({ text: t, start: +(start + i * step).toFixed(3), end: +(start + i * step + step * 0.8).toFixed(3), speaker: 'S1' }));
const caption = (text: string, start: number, step = 0.3): TextWord[] => said(text, start, step).map(({ text: t, start: s, end: e }) => ({ text: t, start: s, end: e }));

const region = (cls: Region['cls'], text: string, first = 0): Region => ({
  id: 0, cls, sub: '', first, last: text ? first + text.split(' ').length - 1 : first - 1, start: 0, end: 1, text, heard: [], around: {},
});
const change = (text: string) => ({ id: 0, decision: 'change' as const, text, basis: '' });

/** A chooser that answers "change to `text`" for every region whose caption stretch is `from`. */
const chooser = (to: (from: string) => string | undefined) => ({
  id: 'fake',
  async complete<T>(req: LlmRequest): Promise<T> {
    const spans = [...req.user.matchAll(/^### (\d+) [^\n]*\n[^\n]*\n- CURRENT CAPTION[^\n]*→ stretch: "([^"]*)"/gm)].flatMap((m) => {
      const text = to(m[2]!);
      return text === undefined ? [] : [{ id: m[1]!, decision: 'change', text, basis: 'engines' }];
    });
    return { spans } as T;
  },
});

beforeAll(async () => { await loadPhonetics(); });

describe('the chooser is trusted: no word lists, no value or name checks', () => {
  const o = { language: 'en', relisten: '', showRelisten: true } as const;
  it('applies a changed value, name or currency an engine heard, without listing it', () => {
    expect(assessVote(region('c', 'Pay 12 euros today.'), change('Pay 12 dollars today.'), { ...o, engineText: ['Pay 12 dollars today.'] })).toEqual({ why: null });
    expect(assessVote(region('c', 'John'), change('Dan'), { ...o, engineText: ['Dan'] })).toEqual({ why: null });
  });

  it('lists a reading no engine heard', () => {
    const words = caption('and then John came home.', 1);
    const v = assessVote(region('c', 'John came', 2), change('Jon came'), { ...o, engineText: ['Dan came'], words });
    expect(v.why).toBeNull();
    expect(v.review).toMatch(/the chooser wrote "Jon came"/);
  });

  it('lets an ordinary sentence-initial word change ("The" → "A", "Then" → "And")', () => {
    const words = caption('Okay. The cat sat.', 1);
    expect(acceptChange(region('b', 'The cat sat.', 1), change('A cat sat.'), { language: 'en', engineText: ['a cat sat.', 'A cat sat.'], relisten: '', showRelisten: false, words })).toBeNull();
    expect(acceptChange(region('b', 'Then we go.'), change('And we go.'), { language: 'en', engineText: ['and we go', 'And we go.'], relisten: '', showRelisten: false })).toBeNull();
  });
});

describe('the vote does not insert words the caption already has', () => {
  const engineSet = (ws: TimedWord[]) => [{ id: 'azure', label: 'Azure Speech', words: ws }, { id: 'scribe', label: 'ElevenLabs Scribe', words: ws }];

  it('rejects an insert of the caption\'s own words that the engines timed more than 3 s later', async () => {
    const T = [...caption('Well, I told you so.', 10), ...caption("Okay, let's go.", 16)];
    const heard = [...said('Well,', 10), ...said('I told you so.', 14.5), ...said("Okay, let's go.", 16)];
    const res = await vote({ words: T, engines: engineSet(heard), language: 'en', duration: 30, precise: 1 }, { llm: chooser((from) => (from === '' ? 'I told you so.' : undefined)) });
    expect(res.words.join(' ')).toBe("Well, I told you so. Okay, let's go.");
    expect(res.votes).toEqual([expect.objectContaining({ from: '', result: 'rejected:repeat' })]);
  });

  it('rejects an insert that repeats the caption words right after the insertion point', () => {
    const words = [...caption('Wait.', 10), ...caption('I told you so.', 14)];
    const r: Region = { ...region('a', '', 1), start: 11, end: 12 };
    const engines = [said('Wait. I told you so.', 10), said('Wait. I told you so.', 10)];
    expect(acceptChange(r, change('I told you so.'), { language: 'en', engineText: ['I told you so.', 'I told you so.'], relisten: '', showRelisten: false, words, engineWords: engines })).toBe('repeat');
  });

  it('keeps a repetition the engines heard twice where the caption has it once', async () => {
    const T = [...caption('I told you so.', 10), ...caption("Okay, let's go.", 16)];
    const heard = [...said('I told you so.', 10), ...said('I told you so.', 14.5), ...said("Okay, let's go.", 16)];
    const res = await vote({ words: T, engines: engineSet(heard), language: 'en', duration: 30, precise: 1 }, { llm: chooser((from) => (from === '' ? 'I told you so.' : undefined)) });
    expect(res.words.join(' ')).toBe("I told you so. I told you so. Okay, let's go.");
    expect(res.votes).toEqual([expect.objectContaining({ from: '', to: 'I told you so.', result: 'changed' })]);
  });

  it('still inserts a line the caption does not have', async () => {
    const T = caption('Go! Go, go, go!', 10);
    const heard = [...said('Go! Go, go, go!', 10), ...said('Move your asses!', 12)];
    const res = await vote({ words: T, engines: engineSet(heard), language: 'en', duration: 30 }, { llm: chooser((from) => (from === '' ? 'Move your asses!' : undefined)) });
    expect(res.words.join(' ')).toBe('Go! Go, go, go! Move your asses!');
  });
});
