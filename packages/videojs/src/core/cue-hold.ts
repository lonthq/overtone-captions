import { findCueIndex, type Cue, type TimeWindow } from 'overtone-format';

/** Gaps between cues shorter than this (seconds) keep the previous cue on screen. */
export const CUE_HOLD_SECONDS = 0.1;

/**
 * The active cue at `time`, else the previous one when the gap to the next is under `hold` seconds (in whole ms), so
 * captions don't blink. A cue ending at or before the `window` start is never held. -1 for nothing.
 */
export function cueIndexWithHold(
  cues: readonly Cue[],
  time: number,
  window?: TimeWindow,
  hold = CUE_HOLD_SECONDS,
): number {
  const active = findCueIndex(cues, time);
  if (active !== -1) return active;
  // The last cue started at or before `time` has ended, and the next starts after `time`, so a short gap
  // means it ended less than `hold` ago.
  let low = 0;
  let high = cues.length - 1;
  let previous = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].start <= time) {
      previous = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (previous === -1 || previous === cues.length - 1) return -1;
  const end = cues[previous].end;
  if (window && end <= window.start) return -1;
  const gapMs = Math.round((cues[previous + 1].start - end) * 1000);
  return gapMs < Math.round(hold * 1000) ? previous : -1;
}
