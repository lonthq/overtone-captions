import type { Cue, OvertoneDocument, Profile } from './types.js';

/** Index of the cue showing at `time` (start inclusive, end exclusive), or -1. Cues must be ordered and non-overlapping. */
export function findCueIndex(cues: readonly Cue[], time: number): number {
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].start <= time) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return candidate !== -1 && time < cues[candidate].end ? candidate : -1;
}

export function getProfile(doc: OvertoneDocument, id: string): Profile | undefined {
  return doc.profiles.find((profile) => profile.id === id);
}

/** The profile's cues limited to its `window`: cues outside are dropped, cues crossing an edge are clamped. */
export function clipCuesToWindow(profile: Profile): Cue[] {
  const window = profile.window;
  if (!window) return profile.cues;
  return profile.cues
    .filter((cue) => cue.end > window.start && cue.start < window.end)
    .map((cue) => ({ ...cue, start: Math.max(cue.start, window.start), end: Math.min(cue.end, window.end) }));
}
