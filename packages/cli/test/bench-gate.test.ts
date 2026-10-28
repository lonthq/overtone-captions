// Regression gate: the pipeline runs offline on frozen hearings of real clips (test/fixtures/bench/), is scored
// against human references and fails on a metric worse than baseline + tolerance. After a reviewed change that moves
// a metric, rewrite the baseline:
//
//   BENCH_GATE_WRITE=1 npx vitest run packages/cli/test/bench-gate.test.ts
//
// A private set in bench/private/ (git-ignored, own baseline.json) runs when present. Engine table: node bench/gate.mjs.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_DIR, loadFixtures, parseSrt, PRIVATE_DIR } from './bench/fixture.js';
import { compare, gateTable, readBaseline, scoreClip, writeBaseline, type ClipResult } from './bench/gate.js';
import { cueTiming, matchInOrder, wer, wordTiming } from './bench/score.js';

describe('regression gate scorer', () => {
  it('matches a repeated word to its nearest occurrence, in order and within the window', () => {
    const ref = [{ t: 'go', at: 10 }, { t: 'now', at: 11 }];
    const hyp = [{ t: 'go', at: 2 }, { t: 'go', at: 10.2 }, { t: 'now', at: 11.1 }, { t: 'go', at: 50 }];
    const pairs = matchInOrder(ref.map((r) => r.t), hyp.map((h) => h.t), (i, j) => Math.abs(hyp[j]!.at - ref[i]!.at));
    expect(pairs).toEqual([[0, 1], [1, 2]]);
    // a pair further apart than the window never matches
    expect(matchInOrder(['go'], ['go'], () => 31)).toEqual([]);
  });

  it('scores WER with the benchmark normalizer, word timing and cue timing', () => {
    const ref = [{ text: "Don't", start: 1, end: 1.3 }, { text: 'go', start: 1.3, end: 1.5 }, { text: 'there.', start: 1.5, end: 2 }];
    const hyp = [{ text: 'Do', start: 1.05, end: 1.2 }, { text: 'not', start: 1.2, end: 1.3 }, { text: 'go', start: 1.6, end: 1.8 }, { text: 'here', start: 2.5, end: 3 }];
    const t = wer(ref, hyp, 'en');
    expect(t.refWords).toBe(4); // do not go there
    expect(t.wer).toBeCloseTo(1 / 4);
    const w = wordTiming(ref, hyp, 'en');
    expect(w.matched).toBe(3); // "do" and "not" are two words here
    expect(w.within100).toBeCloseTo(1 / 3); // do 50 ms, not 200 ms, go 300 ms
    expect(w.within250).toBeCloseTo(2 / 3);
    const cues = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nDon\'t go\n\n2\n00:00:02,000 --> 00:00:03,000\nhere');
    expect(cues).toEqual([{ start: 1, end: 2, text: "Don't go" }, { start: 2, end: 3, text: 'here' }]);
    expect(cueTiming(cues, hyp, 'en')).toMatchObject({ cues: 2, matched: 2, over1s: 0 });
  });
});

const SETS = [
  { name: 'committed clips', dir: FIXTURE_DIR },
  { name: 'private clips (bench/private)', dir: PRIVATE_DIR },
];

for (const set of SETS) {
  const fixtures = loadFixtures(set.dir);
  describe.skipIf(fixtures.length === 0)(`regression gate: ${set.name}`, () => {
    it('is no worse than the baseline on any gated metric', async () => {
      const path = join(set.dir, 'baseline.json');
      const results: ClipResult[] = [];
      for (const f of fixtures) results.push(await scoreClip(f));
      if (process.env.BENCH_GATE_WRITE) writeBaseline(path, results);
      const rows = compare(results, readBaseline(path));
      // printed on every run (add --silent=false when vitest runs silent) and in the failure message
      const table = `regression gate, ${set.name}${process.env.BENCH_GATE_WRITE ? ' (baseline written)' : ''}\n${gateTable(rows)}`;
      console.log(table);
      const fmt = (rs: typeof rows) => rs.map((r) => `${r.clip} ${r.key}: ${r.baseline ?? '-'} → ${r.value}`).join('\n');
      const worse = rows.filter((r) => r.status === 'worse');
      expect(worse, `worse than the baseline (+ tolerance):\n${fmt(worse)}\n\n${table}\n`).toEqual([]);
      const unknown = rows.filter((r) => r.status === 'new');
      expect(unknown, `no baseline yet; write it with BENCH_GATE_WRITE=1:\n${fmt(unknown)}\n\n${table}\n`).toEqual([]);
    }, 60_000);
  });
}
