// Words an engine timed far from the rest of their sentence (hearings.ts STRAY_FRAGMENT).
import { describe, expect, it } from 'vitest';
import { hear, type EngineHearing } from '../src/hearings.js';
import { FIXTURE_DIR, readFixture } from './bench/fixture.js';
import { runOvertone } from './bench/run.js';
import type { TimedWord } from '../src/types.js';
import { join } from 'node:path';

/** Words of `text` from `start`, one every `step` seconds, each 80 % of a step long. */
const said = (text: string, start: number, step = 0.3): TimedWord[] =>
  text.split(' ').map((t, i) => ({ text: t, start: +(start + i * step).toFixed(3), end: +(start + i * step + step * 0.8).toFixed(3), speaker: 'S1' }));
const engine = (id: string, words: TimedWord[]): EngineHearing => ({ id, label: id, words });
const timesOf = async (text: string, engines: EngineHearing[], timeBy = engines.length - 1) =>
  (await hear({ text: text.split(' '), engines, timeBy, speakersBy: timeBy, language: 'en', duration: 120 })).words;

describe('a fragment timed far from the rest of its sentence', () => {
  it('moves to just before the rest of the sentence when the engines disagree on it', async () => {
    // music-then-speech: "Volgens" said at 60.0 s, Scribe timed it at 0.62 s and Azure at 41.51 s
    const rest = said('Angel 2006 kunnen organisaties beter presteren.', 60.86);
    const words = await timesOf('Volgens Angel 2006 kunnen organisaties beter presteren.', [
      engine('azure', [{ text: 'Volgens', start: 41.51, end: 41.91, speaker: 'S1' }, ...rest]),
      engine('scribe', [{ text: 'Volgens', start: 0.62, end: 1.04, speaker: 'S1' }, ...rest]),
    ]);
    expect(words[0]!.start).toBeGreaterThan(59.5);
    expect(words[0]!.end).toBeLessThanOrEqual(60.86);
    expect(words[0]!.match).toBe('interpolated');
    expect(words[0]!.confidence).toBe(0);
    expect(words.slice(1).map((w) => w.start)).toEqual(rest.map((w) => w.start));
  });

  it('moves with one engine too, and a fragment of several words keeps its order', async () => {
    // Tears of Steel, Azure only: "You're a" at 9.5 and 12.2 s, "jerk, Thom." at 23.6 s
    const words = await timesOf("Four, three, two, one. You're a jerk, Thom.", [
      engine('azure', [...said('Four, three, two, one.', 6.9, 0.8), ...said("You're a", 9.5, 2.7), ...said('jerk, Thom.', 23.6, 0.4)]),
    ]);
    const [youre, a, jerk] = words.slice(4);
    expect(youre!.start).toBeGreaterThan(22);
    expect(youre!.end).toBeLessThanOrEqual(a!.start);
    expect(a!.end).toBeLessThanOrEqual(jerk!.start);
    expect(jerk!.start).toBe(23.6);
    expect(words[3]!.start).toBe(9.3); // "one." ends the sentence before: it stays
  });

  it('stays where another engine heard it at the same time', async () => {
    const words = await timesOf('Emo, close your eyes.', [
      engine('azure', [{ text: 'Emo,', start: 23.6, end: 24, speaker: 'S1' }, ...said('close your eyes.', 42.3)]),
      engine('scribe', [{ text: 'Emo,', start: 23.8, end: 24.2, speaker: 'S1' }, ...said('close your eyes.', 42.3)]),
    ]);
    expect(words[0]!.start).toBe(23.8);
    expect(words[0]!.match).toBe('exact');
  });

  it('leaves pauses up to 5 s, pauses after a sentence and long fragments alone', async () => {
    const pause = await timesOf('So we should go.', [engine('azure', [...said('So', 10), ...said('we should go.', 14.9)])]);
    expect(pause[0]!.start).toBe(10);
    const sentence = await timesOf('Hello. How are you?', [engine('azure', [...said('Hello.', 10), ...said('How are you?', 40)])]);
    expect(sentence[0]!.start).toBe(10);
    const long = await timesOf('We went to the shop and then home.', [engine('azure', [...said('We went to the', 10), ...said('shop and then home.', 30)])]);
    expect(long[0]!.start).toBe(10);
  });
});

describe('the frozen music-then-speech hearings', () => {
  it('no longer place the first word in the 60 s of music, with or without the second hearing', async () => {
    const f = readFixture(join(FIXTURE_DIR, 'music-then-speech.fixture.json.gz'));
    for (const noSecond of [false, true]) {
      const { words } = await runOvertone(f, { noSecond });
      expect(words[0]!.text).toBe('Volgens');
      expect(words[0]!.start).toBeGreaterThan(59.5);
    }
  });
});
