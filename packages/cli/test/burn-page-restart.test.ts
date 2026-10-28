import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OvertoneDocument } from 'overtone-format';
import { burnAssetsDir, loadStyle } from '../src/burn/assets.js';
import { openCaptionPage } from '../src/burn/caption-page.js';
import { findChrome, launchChrome, type ChromeTab } from '../src/burn/chrome.js';
import { captionEvents } from '../src/burn/events.js';
import { renderFrames } from '../src/burn/frames.js';
import { tempDir } from './tmp.js';

const built = (() => {
  try {
    return existsSync(join(burnAssetsDir(), 'page.js'));
  } catch {
    return false;
  }
})();
const hasChrome = (() => {
  try {
    findChrome();
    return true;
  } catch {
    return false;
  }
})();

/** 40 key words of 0.08 s from 0.5 s on: each pop (0.12 s in the social pack) starts before the last one ends. */
const WORD = 0.08;
const words = Array.from({ length: 40 }, (_, i) => ({
  text: `w${i}`, start: Math.round((0.5 + i * WORD) * 1000) / 1000, end: Math.round((0.5 + (i + 1) * WORD) * 1000) / 1000, classes: ['key' as const],
}));
const end = words.at(-1)!.end;
const fastDoc: OvertoneDocument = {
  format: 'overtone', version: 1, language: 'en', duration: 5,
  speakers: [{ id: 'S1' }],
  turns: [{ speaker: 'S1', start: 0.5, end, words }],
  profiles: [{ id: 'horizontal', aspect: '16:9', rules: { maxCharsPerLine: 400, maxLines: 2 }, cues: [
    { start: 0.5, end, speaker: 'S1', lines: [{ words: [0, 39], text: words.map((w) => w.text).join(' ') }] },
  ] }],
};

describe.skipIf(!built || !hasChrome)('caption page: overlapping transitions', () => {
  let tab: ChromeTab;
  beforeAll(async () => {
    tab = await launchChrome();
  });
  afterAll(async () => {
    await tab?.close();
  });
  const open = async () => {
    const style = await loadStyle('social', process.cwd());
    return openCaptionPage(tab, { doc: fastDoc, profileId: 'horizontal', mode: 'styled', speakers: 'never', width: 640, height: 360, theme: style.theme, css: [style.css] });
  };

  it('says when a change started transitions', async () => {
    const page = await open();
    await page.setTime(0.5);
    expect(await page.setTime(0.58)).toMatchObject({ animating: true, started: true }); // w0 shrinks, w1 pops
    const same = await page.setTime(0.6); // nothing changes: the running pops go on
    expect(same.animating).toBe(true);
    expect(same).not.toHaveProperty('started');
  });

  it('follows every pop, also more than two seconds after the first one', async () => {
    const page = await open();
    const events = captionEvents(fastDoc, fastDoc.profiles[0], 5);
    const long: number[] = [];
    // the frame times are what is tested; skipping the screenshots keeps the test fast
    const entries = await renderFrames({ ...page, screenshot: async () => Buffer.from('png') }, events, { fps: 25, duration: 5, dir: await tempDir('ot-frames-'), onLongAnimation: (t) => long.push(t) });
    const eventSet = new Set(events);
    const between = entries.map((e) => e.start).filter((t) => !eventSet.has(t));
    expect(between.filter((t) => t > 0.5 && t < 1).length).toBeGreaterThan(3);
    expect(between.filter((t) => t > 2.8 && t < end).length).toBeGreaterThan(3);
    expect(long).toEqual([]);
  }, 20_000);
});
