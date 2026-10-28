import type { AlignedWord, TimedWord } from '../types.js';

/** Only engine words within this many seconds of a word are candidates for its speaker (keeps the scan linear). */
const NEAREST_WITHIN_SECONDS = 30;

/**
 * Speakers from another engine's words, for when the timing engine is not the best at telling speakers apart
 * (hearings.ts `speakerEngine`). A word takes the speaker of the engine word it overlaps most. A word with no overlap
 * keeps its own speaker, mapped to the label it shared the most words with, else the nearest word's speaker. Without
 * engine speakers, words keep theirs.
 */
export function assignSpeakers<W extends Pick<AlignedWord, 'start' | 'end' | 'speaker'>>(words: readonly W[], heard: readonly TimedWord[]): W[] {
  const voiced = heard.filter((w) => w.speaker !== undefined).sort((a, b) => a.start - b.start);
  if (voiced.length === 0) return words.map((w) => ({ ...w }));
  let lo = 0;
  const found = words.map((w) => {
    while (lo < voiced.length && voiced[lo]!.end < w.start - NEAREST_WITHIN_SECONDS) lo++;
    let best: TimedWord | undefined;
    let bestScore = -Infinity;
    for (let k = lo; k < voiced.length && voiced[k]!.start <= w.end + NEAREST_WITHIN_SECONDS; k++) {
      const v = voiced[k]!;
      const overlap = Math.min(w.end, v.end) - Math.max(w.start, v.start);
      // overlap counts positive; otherwise the (negative) distance between the two
      if (overlap > bestScore) { bestScore = overlap; best = v; }
    }
    return { speaker: best?.speaker, overlaps: bestScore > 0 };
  });
  // own label → the other engine's label it shared the most overlapping words with
  const shared = new Map<string, Map<string, number>>();
  words.forEach((w, i) => {
    const f = found[i]!;
    if (!f.overlaps || f.speaker === undefined) return;
    const row = shared.get(w.speaker) ?? new Map<string, number>();
    row.set(f.speaker, (row.get(f.speaker) ?? 0) + 1);
    shared.set(w.speaker, row);
  });
  const mapped = new Map([...shared].map(([own, row]) => [own, [...row].sort((a, b) => b[1] - a[1])[0]![0]]));
  return words.map((w, i) => {
    const f = found[i]!;
    const speaker = f.overlaps ? f.speaker : mapped.get(w.speaker) ?? f.speaker;
    return speaker !== undefined ? { ...w, speaker } : { ...w };
  });
}
