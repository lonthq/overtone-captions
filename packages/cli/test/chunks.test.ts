import { describe, expect, it } from 'vitest';
import { parseSilences, planChunks } from '../src/media/chunks.js';

const STDERR = `
[silencedetect @ 0x7f] silence_start: 2.00063
[silencedetect @ 0x7f] silence_end: 3.9971 | silence_duration: 1.99647
size=N/A time=00:00:06.00 bitrate=N/A speed= 812x
[silencedetect @ 0x7f] silence_start: -0.01
[silencedetect @ 0x7f] silence_end: 0.5 | silence_duration: 0.51
[silencedetect @ 0x7f] silence_start: 5.5
`;

describe('parseSilences', () => {
  it('pairs starts and ends, clamps negatives and closes a trailing silence', () => {
    expect(parseSilences(STDERR, 6)).toEqual([
      { start: 2.00063, end: 3.9971 },
      { start: 0, end: 0.5 },
      { start: 5.5, end: 6 },
    ]);
  });
  it('returns nothing for no silences', () => {
    expect(parseSilences('size=N/A time=00:00:06.00', 6)).toEqual([]);
  });
});

describe('planChunks', () => {
  const base = { bytesPerSecond: 6000, maxBytes: 24 * 1024 * 1024, maxSeconds: 1400, silences: [] };

  it('keeps short media in one chunk', () => {
    expect(planChunks(600, base)).toEqual([{ start: 0, end: 600 }]);
  });

  it('cuts at the middle of the latest silence before the limit', () => {
    // limit = 1400 × 0.95 = 1330 s; silences at 1000–1002 and 1200–1210 (mid 1205)
    const plan = planChunks(2000, { ...base, silences: [{ start: 1000, end: 1002 }, { start: 1200, end: 1210 }] });
    expect(plan).toEqual([{ start: 0, end: 1205 }, { start: 1205, end: 2000 }]);
  });

  it('cuts hard at the limit when there is no silence nearby', () => {
    const plan = planChunks(3000, { ...base, silences: [{ start: 100, end: 101 }] });
    expect(plan.map((c) => +c.end.toFixed(1))).toEqual([1330, 2660, 3000]);
  });

  it('respects the byte limit when it is stricter than the duration limit', () => {
    // 10 000 B/s, 5 MB → 524.288 s × 0.95 = 498.07 s per chunk
    const plan = planChunks(1000, { ...base, bytesPerSecond: 10_000, maxBytes: 5 * 1024 * 1024 });
    expect(plan).toHaveLength(3);
    expect(plan[0].end).toBeCloseTo(498.07, 1);
    expect(plan.at(-1)!.end).toBe(1000);
  });

  it('does not leave a tiny last chunk', () => {
    // limit 1330 s; a hard cut would leave a 0.05 s tail
    const plan = planChunks(1330.05, base);
    expect(plan).toHaveLength(2);
    expect(plan[0].end).toBeCloseTo(1325.05, 5);
    expect(plan[1]).toEqual({ start: plan[0].end, end: 1330.05 });
    expect(plan[1].end - plan[1].start).toBeGreaterThanOrEqual(5);
  });

  it('moves the previous cut to an earlier silence, not into the middle of speech', () => {
    // limit 1330 s: the first cut goes to the silence at 1330, which leaves a 4 s tail
    const silences = [{ start: 1309, end: 1311 }, { start: 1329.5, end: 1330.5 }];
    expect(planChunks(1334, { ...base, silences })).toEqual([{ start: 0, end: 1310 }, { start: 1310, end: 1334 }]);
  });

  it('takes the latest silence in the allowed range for the tail fix', () => {
    const silences = [{ start: 1000, end: 1002 }, { start: 1309, end: 1311 }, { start: 1329, end: 1331 }];
    const plan = planChunks(1334, { ...base, silences });
    expect(plan.map((c) => c.end)).toEqual([1310, 1334]);
  });

  it('ignores silences that would make the chunks too long or the tail too short', () => {
    // only silence in the window [duration - limit, duration - minTail] counts; 1331 would leave a 3 s tail
    const plan = planChunks(1334, { ...base, silences: [{ start: 1330, end: 1332 }] });
    expect(plan).toEqual([{ start: 0, end: 1329 }, { start: 1329, end: 1334 }]);
  });

  it('keeps contiguous chunks that all respect the limit after moving the last cut', () => {
    const plan = planChunks(2662, base);
    for (const [i, c] of plan.entries()) {
      expect(c.end - c.start).toBeLessThanOrEqual(1330 + 1e-9);
      if (i > 0) expect(c.start).toBe(plan[i - 1].end);
    }
    expect(plan.at(-1)!.end - plan.at(-1)!.start).toBeGreaterThanOrEqual(5);
  });
});
