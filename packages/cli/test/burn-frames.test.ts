import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderFrames, type CaptionPage } from '../src/burn/frames.js';
import { tempDir } from './tmp.js';

/** A fake page: `states` maps a time to its key; an animation of `anim` seconds starts at the times in `animated`. */
function fakePage(states: Record<number, string>, animated: Record<number, number> = {}): CaptionPage & { shots: number } {
  let until = -1;
  const page = {
    shots: 0,
    async setTime(t: number) {
      if (animated[t] !== undefined) until = t + animated[t];
      return { key: states[t], animating: t < until };
    },
    async step(t: number) {
      return t < until;
    },
    async screenshot() {
      page.shots++;
      return Buffer.from('png');
    },
  };
  return page;
}

describe('renderFrames', () => {
  it('skips repeated states and reuses files of states seen before', async () => {
    const dir = await tempDir('ot-frames-');
    const page = fakePage({ 0: '-1:', 1: '0:', 2: '0:', 3: '-1:', 4: '0:' });
    const entries = await renderFrames(page, [0, 1, 2, 3, 4], { fps: 25, duration: 5, dir });
    expect(entries.map((e) => [e.start, basename(e.file)])).toEqual([
      [0, 'frame-000000.png'], [1, 'frame-000001.png'], [3, 'frame-000000.png'], [4, 'frame-000001.png'],
    ]);
    expect(page.shots).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(['frame-000000.png', 'frame-000001.png']);
  });

  it('adds one frame per source frame while an animation runs', async () => {
    const dir = await tempDir('ot-frames-');
    const page = fakePage({ 0: '-1:', 1: '0:0', 2: '0:' }, { 1: 0.12 });
    const entries = await renderFrames(page, [0, 1, 2], { fps: 25, duration: 3, dir });
    expect(entries.map((e) => e.start)).toEqual([0, 1, 1.04, 1.08, 1.12, 2]);
    expect(new Set(entries.map((e) => e.file)).size).toBe(6);
  });

  it('continues an animation that is still running at the next event', async () => {
    const dir = await tempDir('ot-frames-');
    const page = fakePage({ 0: '-1:', 1: '0:0', 1.05: '0:' }, { 1: 0.12 });
    const entries = await renderFrames(page, [0, 1, 1.05], { fps: 25, duration: 2, dir });
    expect(entries.map((e) => e.start)).toEqual([0, 1, 1.04, 1.05, 1.08, 1.12]);
  });
  it('samples animations at 60 fps at most, also on 120 fps video', async () => {
    const dir = await tempDir('ot-frames-');
    const page = fakePage({ 0: '-1:', 1: '0:0', 2: '0:' }, { 1: 0.05 });
    const entries = await renderFrames(page, [0, 1, 2], { fps: 120, duration: 3, dir });
    expect(entries.map((e) => e.start)).toHaveLength(6);
    [0, 1, 1 + 1 / 60, 1 + 2 / 60, 1.05, 2].forEach((expected, i) => expect(entries[i].start).toBeCloseTo(expected, 5));
  });

  it('stops following an endless animation after two seconds and says so once', async () => {
    const dir = await tempDir('ot-frames-');
    const page = fakePage({ 0: '-1:', 1: '0:0', 5: '0:0' }, { 1: 1000 });
    const long: number[] = [];
    const entries = await renderFrames(page, [0, 1, 5], { fps: 25, duration: 10, dir, onLongAnimation: (t) => long.push(t) });
    expect(long).toEqual([1]);
    const starts = entries.map((e) => e.start);
    expect(starts.at(-2)).toBeCloseTo(3, 5); // last sample, 2 s after the animation began
    expect(starts.at(-1)).toBe(5); // the later event is shot, but not sampled
    expect(starts.filter((t) => t > 3 && t < 5)).toEqual([]);
  });

  it('reuses the cached PNG of a state after its animation settled', async () => {
    const dir = await tempDir('ot-frames-');
    const page = fakePage({ 0: '-1:', 1: '0:0', 2: '-1:', 3: '0:0' }, { 1: 0.1 });
    const entries = await renderFrames(page, [0, 1, 2, 3], { fps: 25, duration: 4, dir });
    expect(entries.map((e) => e.start)).toEqual([0, 1, 1.04, 1.08, 1.12, 2, 3]);
    expect(entries[6].file).toBe(entries[4].file);
    expect(page.shots).toBe(5);
  });

  it('stops sampling an animation at the end of the video', async () => {
    const dir = await tempDir('ot-frames-');
    const page = fakePage({ 0: '-1:', 1: '0:0' }, { 1: 5 });
    const long: number[] = [];
    const entries = await renderFrames(page, [0, 1], { fps: 25, duration: 1.1, dir, onLongAnimation: (t) => long.push(t) });
    expect(entries.map((e) => e.start)).toEqual([0, 1, 1.04, 1.08]);
    expect(long).toEqual([]);
  });

  it('keeps frame times of 30000/1001 fps strictly increasing and before the next event', async () => {
    const dir = await tempDir('ot-frames-');
    const page = fakePage({ 0: '-1:', 1: '0:0', 1.5: '0:' }, { 1: 0.4 });
    const entries = await renderFrames(page, [0, 1, 1.5], { fps: 30000 / 1001, duration: 2, dir });
    const starts = entries.map((e) => e.start);
    starts.slice(1).forEach((t, i) => expect(t).toBeGreaterThan(starts[i]));
    expect(starts.filter((t) => t > 1 && t < 1.5).length).toBeGreaterThan(8);
    expect(starts.filter((t) => t > 1 && t < 1.5).every((t) => t < 1.5)).toBe(true);
    expect(starts).toContain(1.5);
  });
});
