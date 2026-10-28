// Vote regions whose caption words overlap (reconcile/regions.ts mergeOverlappingParts, vote.ts nonOverlapping).
import { beforeAll, describe, expect, it } from 'vitest';
import { loadPhonetics } from '../src/reconcile/phonetics.js';
import { findRegions, type EngineWords, type TextWord } from '../src/reconcile/regions.js';
import { vote } from '../src/reconcile/vote.js';
import type { LlmRequest } from '../src/providers/types.js';
import type { TimedWord } from '../src/types.js';
import { nonOverlapping } from '../src/util/ranges.js';

const w = (text: string, start: number, end = start + 0.4): TimedWord => ({ text, start, end, speaker: 'S1' });
const both = (words: TimedWord[]): EngineWords[] => [{ id: 'a', label: 'A', words }, { id: 'b', label: 'B', words }];
const ranges = (T: readonly TextWord[], engines: readonly EngineWords[]) =>
  findRegions(T, engines, { language: 'en', precise: 0 }).map((r) => [r.first, r.last, r.cls, r.text]);

/** A chooser that changes every region to what the first engine heard there. */
const followEngines = (T: readonly TextWord[], engines: readonly EngineWords[]) => {
  const rs = findRegions(T, engines, { language: 'en', precise: 0 });
  return {
    id: 'fake',
    async complete<X>(req: LlmRequest): Promise<X> {
      const spans = [...req.user.matchAll(/^### (\d+) /gm)]
        .map((m) => ({ id: m[1]!, decision: 'change', text: rs[+m[1]!]!.heard[0]!.map((x) => x.text).join(' '), basis: 'engines' }));
      return { spans } as X;
    },
  };
};

beforeAll(async () => { await loadPhonetics(); });

describe('caption words whose times go backwards (an untimed word\'s estimate)', () => {
  // "bravo" no engine heard: its estimated time (5 s) lies after "charlie" and "delta"
  const T: TextWord[] = [
    { text: 'alpha', start: 0, end: 0.4 },
    { text: 'bravo', start: 5, end: 5.4, untimed: true },
    { text: 'charlie', start: 0.5, end: 0.9 },
    { text: 'delta', start: 1.0, end: 1.4 },
    { text: 'echo', start: 6, end: 6.4 },
  ];
  const engines = both([w('zulu', 0), w('yankee', 0.5), w('xray', 1.0), w('whiskey', 6)]);

  it('give regions whose caption words do not overlap', () => {
    // unmerged, these would be [0, 3] and [1, 4]
    const rs = findRegions(T, engines, { language: 'en', precise: 0 });
    expect(rs.map((r) => [r.first, r.last])).toEqual([[0, 4]]);
    expect(rs[0]!.heard[0]!.map((x) => x.text)).toEqual(['zulu', 'yankee', 'xray', 'whiskey']);
  });

  it('lose no word in the vote', async () => {
    // applying the second, overlapping change too would splice "whiskey" away
    const res = await vote({ words: T, engines, language: 'en', duration: 10, precise: 0 }, { llm: followEngines(T, engines) });
    expect(res.words).toEqual(['zulu', 'yankee', 'xray', 'whiskey']);
    expect(res.votes.map((v) => v.result)).toEqual(['changed']);
  });
});

describe('caption words in time order', () => {
  it('give the same regions as before', () => {
    const T: TextWord[] = ['the', 'cat', 'sat', 'on', 'the', 'mat', 'and', 'then', 'we', 'went', 'home', 'now']
      .map((text, i) => ({ text, start: i * 0.5 + (i >= 6 ? 3 : 0), end: i * 0.5 + 0.4 + (i >= 6 ? 3 : 0) }));
    const heard = [w('the', 0), w('dog', 0.5), w('sat', 1), w('on', 1.5), w('the', 2), w('mat', 2.5), w('and', 6), w('then', 6.5), w('we', 7), w('ran', 7.5), w('home', 8), w('now', 8.5), w('okay', 9)];
    expect(ranges(T, both(heard))).toEqual([[1, 1, 'b', 'cat'], [9, 9, 'b', 'went'], [12, 11, 'a', '']]);
  });

  it('leave changes that do not overlap as they were', async () => {
    const T: TextWord[] = ['the', 'cat', 'sat', 'on', 'the', 'mat'].map((text, i) => ({ text, start: i * 2, end: i * 2 + 0.4 }));
    const engines = both([w('the', 0), w('bat', 2), w('sat', 4), w('on', 6), w('the', 8), w('hat', 10)]);
    const res = await vote({ words: T, engines, language: 'en', duration: 12, precise: 0 }, { llm: followEngines(T, engines) });
    expect(res.words).toEqual(['the', 'bat', 'sat', 'on', 'the', 'hat']);
  });
});

describe('nonOverlapping', () => {
  const r = (first: number, last: number) => ({ first, last });
  it('rejects a replacement or an insertion inside one accepted before', () => {
    const { accepted, overlapping } = nonOverlapping([r(0, 3), r(1, 4), r(3, 2), r(4, 3), r(4, 4), r(5, 4)], (x) => x);
    expect(accepted).toEqual([r(0, 3), r(4, 3), r(4, 4), r(5, 4)]);
    expect(overlapping).toEqual([r(1, 4), r(3, 2)]);
  });

  it('lets insertions stand at one place, also in front of a replacement there', () => {
    expect(nonOverlapping([r(2, 1), r(2, 1), r(2, 3)], (x) => x).overlapping).toEqual([]);
  });
});
