// The vote applies only changes that do not overlap (vote.ts, util/ranges.ts nonOverlapping), whatever the regions.
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { LlmRequest } from '../src/providers/types.js';
import { loadPhonetics } from '../src/reconcile/phonetics.js';
import type { Region, TextWord } from '../src/reconcile/regions.js';
import type { TimedWord } from '../src/types.js';

const w = (text: string, start: number): TimedWord => ({ text, start, end: start + 0.4, speaker: 'S1' });
const region = (id: number, first: number, last: number, text: string, heard: TimedWord[]): Region => ({
  id, cls: 'b', sub: 'replace', first, last, start: heard[0]!.start, end: heard[heard.length - 1]!.end, text, heard: [heard, heard], around: {},
});
// the regions of the audit: [0, 3] and [1, 4] over "alpha bravo charlie delta echo"
const REGIONS = [
  region(0, 0, 3, 'alpha bravo charlie delta', [w('zulu', 0), w('yankee', 0.5), w('xray', 1)]),
  region(1, 1, 4, 'bravo charlie delta echo', [w('whiskey', 6)]),
];
vi.mock('../src/reconcile/regions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/reconcile/regions.js')>()),
  findRegions: () => REGIONS,
}));
const { vote } = await import('../src/reconcile/vote.js');

beforeAll(async () => { await loadPhonetics(); });

describe('two changes whose caption words overlap', () => {
  it('apply the first; the second is rejected and spliced nowhere', async () => {
    const T: TextWord[] = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((text, i) => ({ text, start: i, end: i + 0.4 }));
    const llm = {
      id: 'fake',
      async complete<X>(req: LlmRequest): Promise<X> {
        const spans = [...req.user.matchAll(/^### (\d+) /gm)].map((m) => ({ id: m[1]!, decision: 'change', text: REGIONS[+m[1]!]!.heard[0]!.map((x) => x.text).join(' '), basis: 'engines' }));
        return { spans } as X;
      },
    };
    const engines = [{ id: 'a', label: 'A', words: [w('x', 0)] }, { id: 'b', label: 'B', words: [w('x', 0)] }];
    const res = await vote({ words: T, engines, language: 'en', duration: 10, precise: 0 }, { llm });
    expect(res.words).toEqual(['zulu', 'yankee', 'xray', 'echo']);
    expect(res.votes.map((v) => [v.result, v.to])).toEqual([['changed', 'zulu yankee xray'], ['rejected:overlap', 'bravo charlie delta echo']]);
  });
});
