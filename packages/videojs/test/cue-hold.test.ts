import { describe, expect, it } from 'vitest';
import type { Cue } from 'overtone-format';
import { CUE_HOLD_SECONDS, cueIndexWithHold } from '../src/core/cue-hold';

function cue(start: number, end: number): Cue {
  return { start, end, speaker: 'S1', lines: [{ words: [0, 0], text: 'x' }] };
}

// Gaps: 2.0 → 2.05 (0.05 s), 4.0 → 4.3 (0.3 s); the last cue ends at 6.
const cues = [cue(1, 2), cue(2.05, 4), cue(4.3, 6)];

describe('cueIndexWithHold', () => {
  it('holds for 0.1 s', () => {
    expect(CUE_HOLD_SECONDS).toBe(0.1);
  });

  it('returns the active cue when there is one', () => {
    expect(cueIndexWithHold(cues, 1.5)).toBe(0);
    expect(cueIndexWithHold(cues, 2.05)).toBe(1);
    expect(cueIndexWithHold(cues, 5)).toBe(2);
  });

  it('keeps showing the previous cue through a gap shorter than 0.1 s', () => {
    expect(cueIndexWithHold(cues, 2)).toBe(0);
    expect(cueIndexWithHold(cues, 2.04)).toBe(0);
  });

  it('shows nothing in a gap of 0.1 s or more', () => {
    expect(cueIndexWithHold(cues, 4)).toBe(-1);
    expect(cueIndexWithHold(cues, 4.05)).toBe(-1);
    expect(cueIndexWithHold([cue(1, 2), cue(2.1, 3)], 2.05)).toBe(-1);
  });

  it('treats an exact 0.1 s gap the same at any offset (whole milliseconds)', () => {
    // 8.1 - 8.0 is 0.0999999999999996 in floating point; 2.1 - 2.0 is 0.10000000000000009.
    expect(cueIndexWithHold([cue(7, 8), cue(8.1, 9)], 8.05)).toBe(-1);
    expect(cueIndexWithHold([cue(1, 2), cue(2.1, 3)], 2.05)).toBe(-1);
    expect(cueIndexWithHold([cue(7, 8), cue(8.099, 9)], 8.05)).toBe(0);
    expect(cueIndexWithHold([cue(1, 2), cue(2.099, 3)], 2.05)).toBe(0);
  });

  it('does not hold a cue that ends at or before the profile window start', () => {
    const window = { start: 2.03, end: 10 };
    expect(cueIndexWithHold(cues, 2.04, window)).toBe(-1); // cue 0 ends at 2.0, outside the window
    expect(cueIndexWithHold(cues, 2.04, { start: 2, end: 10 })).toBe(-1); // ends exactly at the start
    expect(cueIndexWithHold(cues, 2.04, { start: 1.5, end: 10 })).toBe(0); // cue 0 overlaps the window
  });

  it('does not hold after the last cue', () => {
    expect(cueIndexWithHold(cues, 6)).toBe(-1);
    expect(cueIndexWithHold(cues, 6.05)).toBe(-1);
  });

  it('shows nothing before the first cue, far from any cue, or without cues', () => {
    expect(cueIndexWithHold(cues, 0.95)).toBe(-1);
    expect(cueIndexWithHold([cue(1, 2), cue(2.05, 4), cue(9, 10)], 6)).toBe(-1);
    expect(cueIndexWithHold([], 1)).toBe(-1);
  });
});
