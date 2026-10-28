import { describe, expect, it } from 'vitest';
import { renderFrames, type CaptionPage } from '../src/burn/frames.js';
import { tempDir } from './tmp.js';

/**
 * A fake page whose animations are tracked one by one: an animation of `animated[t]` seconds starts at each time in
 * `animated`, and setTime reports `started` when it starts one (as the real page does).
 */
function restartingPage(states: Record<number, string>, animated: Record<number, number>): CaptionPage {
  const ends: number[] = [];
  const running = (t: number) => ends.some((end) => t < end);
  return {
    async setTime(t: number) {
      const started = animated[t] !== undefined;
      if (started) ends.push(t + animated[t]);
      return { key: states[t] ?? 'same', animating: running(t), ...(started ? { started: true } : {}) };
    },
    async step(t: number) {
      return running(t);
    },
    async screenshot() {
      return Buffer.from('png');
    },
  };
}

describe('renderFrames with animations that overlap', () => {
  it('follows every new transition, also after the first one began more than two seconds ago', async () => {
    const dir = await tempDir('ot-frames-');
    // a word highlight every 0.1 s, each with a 0.15 s transition: the page never stops animating for 4 s
    const events = [0, ...Array.from({ length: 40 }, (_, i) => Math.round((i + 1) * 10) / 100)];
    const states: Record<number, string> = {};
    const animated: Record<number, number> = {};
    events.forEach((t, i) => {
      states[t] = `0:${i}`;
      if (t > 0) animated[t] = 0.15;
    });
    const long: number[] = [];
    const entries = await renderFrames(restartingPage(states, animated), events, { fps: 25, duration: 5, dir, onLongAnimation: (t) => long.push(t) });
    const starts = entries.map((e) => e.start);
    // the transition that starts at 3.0 is sampled between the events, like the one at 0.5
    expect(starts.filter((t) => t > 0.5 && t < 0.6).length).toBeGreaterThan(0);
    expect(starts.filter((t) => t > 3 && t < 3.1).length).toBeGreaterThan(0);
    // the last one is followed to its end
    expect(starts.filter((t) => t > 4 && t <= 4.16).length).toBeGreaterThan(2);
    expect(long).toEqual([]);
  });

  it('still stops following one long animation that later events do not restart', async () => {
    const dir = await tempDir('ot-frames-');
    const long: number[] = [];
    const page = restartingPage({ 0: '-1:', 1: '0:0', 2: '0:1', 5: '0:2' }, { 1: 1000 });
    const entries = await renderFrames(page, [0, 1, 2, 5], { fps: 25, duration: 10, dir, onLongAnimation: (t) => long.push(t) });
    expect(long).toEqual([1]);
    const starts = entries.map((e) => e.start);
    expect(starts.filter((t) => t > 3 + 1e-6 && t < 5)).toEqual([]);
    expect(starts.at(-1)).toBe(5);
  });

  it('follows a transition that starts while a long animation is capped, for at most two seconds', async () => {
    const dir = await tempDir('ot-frames-');
    const long: number[] = [];
    const page = restartingPage({ 0: '-1:', 1: '0:0', 5: '0:1' }, { 1: 1000, 5: 0.2 });
    const entries = await renderFrames(page, [0, 1, 5], { fps: 25, duration: 10, dir, onLongAnimation: (t) => long.push(t) });
    const starts = entries.map((e) => e.start);
    expect(starts.filter((t) => t > 5 && t < 5.2).length).toBeGreaterThan(3);
    // the long one still runs, so sampling stops 2 s after the new start, and that is reported
    expect(starts.at(-1)).toBeCloseTo(7, 5);
    expect(long).toEqual([1, 5]);
  });
});
