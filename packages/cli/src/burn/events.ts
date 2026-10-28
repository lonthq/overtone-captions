import { flattenWords, type OvertoneDocument, type Profile } from 'overtone-format';

const ms = (t: number) => Math.round(t * 1000) / 1000;

/**
 * Times (s, ascending, unique to the ms, before `duration`) where what `profile` shows can change: 0, window bounds,
 * cue bounds and word bounds. In between, only CSS transitions move.
 */
export function captionEvents(doc: OvertoneDocument, profile: Profile, duration: number): number[] {
  const words = flattenWords(doc);
  const times = new Set<number>();
  const add = (t: number) => {
    const rounded = ms(t); // round first, so a time that rounds up to `duration` is dropped
    if (rounded >= 0 && rounded < duration) times.add(rounded);
  };
  add(0);
  if (profile.window) {
    add(profile.window.start);
    add(profile.window.end);
  }
  for (const cue of profile.cues) {
    add(cue.start);
    add(cue.end);
    for (const line of cue.lines) {
      for (let i = line.words[0]; i <= line.words[1]; i++) {
        add(words[i].start);
        add(words[i].end);
      }
    }
  }
  return [...times].sort((a, b) => a - b);
}
