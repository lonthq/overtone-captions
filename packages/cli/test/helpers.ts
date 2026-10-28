import { tokenizeDisplay } from '../src/text/normalize.js';
import type { SpeakerWord } from '../src/turns.js';
import type { TimedWord } from '../src/types.js';

/** Timing-side words: "w1 w2 …", word k at start + k·step, lasting `dur`; speakers per word or one for all. */
export function az(spec: string, o: { start?: number; step?: number; dur?: number; speakers?: string | string[] } = {}): TimedWord[] {
  const start = o.start ?? 0;
  const step = o.step ?? 0.5;
  const dur = o.dur ?? 0.4;
  return spec.split(' ').filter(Boolean).map((text, k) => ({
    text,
    start: +(start + k * step).toFixed(3),
    end: +(start + k * step + dur).toFixed(3),
    speaker: Array.isArray(o.speakers) ? o.speakers[k] : (o.speakers ?? 'S1'),
  }));
}

/** Speech-like timing: 0.065 s per character + 0.08 s per word; `pauses[k]` seconds of silence before word k. */
export function talk(text: string, speaker = 'S1', start = 0, pauses: Record<number, number> = {}): SpeakerWord[] {
  let t = start;
  return tokenizeDisplay(text).map((w, k) => {
    t += pauses[k] ?? 0;
    const d = 0.065 * w.length + 0.08;
    const word = { text: w, start: +t.toFixed(3), end: +(t + d).toFixed(3), speaker };
    t += d + (/[.?!]["”]?$/.test(w) ? 0.35 : /[,;:]$/.test(w) ? 0.15 : 0.03);
    return word;
  });
}

/** Is a process with this pid still running? */
export const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
