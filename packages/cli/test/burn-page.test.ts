import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OvertoneDocument } from 'overtone-format';
import { burnAssetsDir, builtInStyles, fontCss, loadStyle } from '../src/burn/assets.js';
import { findChrome, launchChrome, type ChromeTab } from '../src/burn/chrome.js';
import { openCaptionPage } from '../src/burn/caption-page.js';
import { UserError } from '../src/errors.js';
import { tempDir } from './tmp.js';

const built = (() => {
  try {
    return existsSync(join(burnAssetsDir(), 'page.js'));
  } catch {
    return false;
  }
})();
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasChrome = (() => {
  try {
    findChrome();
    return true;
  } catch {
    return false;
  }
})();

/** The smallest .ttf among the usual system font folders, if any (macOS's LastResort font is one Chrome rejects). */
const systemFont = (() => {
  const found: { path: string; size: number }[] = [];
  for (const dir of ['/System/Library/Fonts/Supplemental', '/System/Library/Fonts', '/usr/share/fonts', 'C:\\Windows\\Fonts']) {
    let files: string[];
    try {
      files = readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    for (const file of files) {
      if (!/\.ttf$/i.test(file) || /lastresort/i.test(file)) continue;
      const path = join(dir, file);
      try {
        found.push({ path, size: statSync(path).size });
      } catch {
        // unreadable: skip
      }
    }
  }
  return found.sort((a, b) => a.size - b.size)[0]?.path;
})();

const rules = (maxCharsPerLine: number) => ({ maxCharsPerLine, maxLines: 2 });
const doc: OvertoneDocument = {
  format: 'overtone', version: 1, language: 'en', duration: 3,
  speakers: [{ id: 'S1' }],
  turns: [{ speaker: 'S1', start: 0.5, end: 1.5, words: [
    { text: 'Hello', start: 0.5, end: 0.9 },
    { text: 'world', start: 0.9, end: 1.5, classes: ['key'] },
  ] }],
  profiles: [
    { id: 'horizontal', aspect: '16:9', rules: rules(42), cues: [{ start: 0.5, end: 1.5, speaker: 'S1', lines: [{ words: [0, 1], text: 'Hello world' }] }] },
    { id: '1x1', aspect: '1:1', rules: rules(32), cues: [{ start: 0.5, end: 1.5, speaker: 'S1', lines: [{ words: [0, 1], text: 'Hello world' }] }] },
  ],
};

/** Pop timing: "world" (a key word) is spoken 0.9–0.95, then the cue changes at 1.0. */
const popDoc: OvertoneDocument = {
  format: 'overtone', version: 1, language: 'en', duration: 3,
  speakers: [{ id: 'S1' }],
  turns: [{ speaker: 'S1', start: 0.5, end: 2, words: [
    { text: 'Hello', start: 0.5, end: 0.9 },
    { text: 'world', start: 0.9, end: 0.95, classes: ['key'] },
    { text: 'there', start: 0.95, end: 1 },
    { text: 'again', start: 1, end: 2 },
  ] }],
  profiles: [{ id: 'horizontal', aspect: '16:9', rules: rules(42), cues: [
    { start: 0.5, end: 1, speaker: 'S1', lines: [{ words: [0, 2], text: 'Hello world there' }] },
    { start: 1, end: 2, speaker: 'S1', lines: [{ words: [3, 3], text: 'again' }] },
  ] }],
};

describe('fontCss', () => {
  it('rejects a file that is not a font', async () => {
    await expect(fontCss('logo.png', process.cwd())).rejects.toThrow(UserError);
    await expect(fontCss('logo.png', process.cwd())).rejects.toThrow(/expected a \.woff2, \.woff, \.ttf or \.otf file/);
  });

  it('reports a missing font file', async () => {
    await expect(fontCss('missing.woff2', process.cwd())).rejects.toThrow(/Font file not found or unreadable: .*missing\.woff2 \(ENOENT\)/);
  });

  it('embeds the font as a data URL', async () => {
    const dir = await tempDir('ot-font-');
    await writeFile(join(dir, 'brand.woff2'), Buffer.from('fake font'));
    const css = await fontCss('brand.woff2', dir);
    expect(css).toContain(`url(data:font/woff2;base64,${Buffer.from('fake font').toString('base64')}) format('woff2')`);
    expect(css).toContain("--ot-font: 'overtone-burn', sans-serif;");
  });
});

describe.skipIf(!built)('loadStyle', () => {
  it('reads a built-in pack', async () => {
    expect(builtInStyles()).toContain('social');
    expect((await loadStyle('social', process.cwd())).theme).toBe('social');
  });

  it('reads a custom pack and takes its theme name from the CSS', async () => {
    const dir = await tempDir('ot-style-');
    await writeFile(join(dir, 'style.css'), '.ot-layer.ot-theme-brand { --ot-color: #fff; }');
    expect(await loadStyle(join(dir, 'style.css'), process.cwd())).toEqual({ theme: 'brand', css: '.ot-layer.ot-theme-brand { --ot-color: #fff; }' });
  });

  it('ignores comments when it looks for the theme name', async () => {
    const dir = await tempDir('ot-style-');
    const css = '/* Based on .ot-theme-example */\n.ot-layer.ot-theme-brand { --ot-color: #fff; }';
    await writeFile(join(dir, 'style.css'), css);
    expect(await loadStyle(join(dir, 'style.css'), process.cwd())).toEqual({ theme: 'brand', css });
    await writeFile(join(dir, 'only-comment.css'), '/* .ot-theme-example */ .ot-layer { --ot-color: #fff; }');
    await expect(loadStyle(join(dir, 'only-comment.css'), process.cwd())).rejects.toThrow(/does not style a theme/);
  });

  it('rejects a style file without a theme', async () => {
    const dir = await tempDir('ot-style-');
    await writeFile(join(dir, 'style.css'), '.ot-layer { --ot-color: #fff; }');
    await expect(loadStyle(join(dir, 'style.css'), process.cwd())).rejects.toThrow(UserError);
    await expect(loadStyle(join(dir, 'style.css'), process.cwd())).rejects.toThrow(/does not style a theme/);
  });

  it('reports a missing style file', async () => {
    await expect(loadStyle('missing/style.css', process.cwd())).rejects.toThrow(UserError);
    await expect(loadStyle('missing/style.css', process.cwd())).rejects.toThrow(/Style file not found or unreadable: .*style\.css \(ENOENT\)/);
  });

  it('rejects a style file that loads something', async () => {
    const dir = await tempDir('ot-style-');
    const check = async (css: string) => {
      await writeFile(join(dir, 'style.css'), `.ot-layer.ot-theme-brand { --ot-color: #fff; }\n${css}`);
      return loadStyle(join(dir, 'style.css'), process.cwd());
    };
    await expect(check("@import url('https://fonts.example.com/brand.css');")).rejects.toThrow(
      /style\.css loads @import url\('https:\/\/fonts\.example\.com\/brand\.css'\); style files for burn must be self-contained \(no @import or remote url\(\)\); use --font for a font file\./,
    );
    await expect(check('.ot-theme-brand .ot-key { background: url( "logo.png") }')).rejects.toThrow(/loads url\( "logo\.png"\);/);
    await expect(check("@font-face { font-family: b; src: url(https://example.com/b.woff2) format('woff2'); }")).rejects.toThrow(/loads url\(https:\/\/example\.com\/b\.woff2\);/);
    // data: URLs and anything inside a comment are fine.
    await expect(check('/* url(https://example.com/x.png) @import "x.css"; */ .ot-theme-brand .ot-key { background: url( "data:image/png;base64,AAAA") }')).resolves.toMatchObject({ theme: 'brand' });
  });

  it('lists the packs for an unknown name', async () => {
    await expect(loadStyle('nope', process.cwd())).rejects.toThrow(UserError);
    await expect(loadStyle('nope', process.cwd())).rejects.toThrow(/Unknown style "nope"; built-in styles: .*social/);
  });
});

describe.skipIf(!built || !hasChrome)('caption page in Chrome', () => {
  let tab: ChromeTab;
  beforeAll(async () => {
    tab = await launchChrome();
  });
  afterAll(async () => {
    await tab?.close();
  });

  const open = async (
    profileId: string, width: number, height: number, extraCss: string[] = [],
    { styleName = 'social', document = doc, fontPath }: { styleName?: string; document?: OvertoneDocument; fontPath?: string } = {},
  ) => {
    const style = await loadStyle(styleName, process.cwd());
    return openCaptionPage(tab, { doc: document, profileId, mode: 'styled', speakers: 'never', width, height, theme: style.theme, css: [style.css, ...extraCss], fontPath });
  };
  const keyScale = (page: { evaluate<T>(e: string): Promise<T> }) =>
    page.evaluate<number>('new DOMMatrix(getComputedStyle(document.querySelector(".ot-key")).transform).a');

  it('steps the pop transition on a virtual clock', async () => {
    const page = await open('horizontal', 640, 360);
    expect((await page.setTime(0.5)).animating).toBe(false);
    const started = await page.setTime(0.9);
    expect(started.animating).toBe(true);
    const scale = () => keyScale(page);
    expect(await page.step(0.96)).toBe(true);
    const mid = await scale();
    expect(mid).toBeGreaterThan(1.001);
    expect(mid).toBeLessThan(1.069);
    expect(await page.step(1.2)).toBe(false);
    expect(await scale()).toBeCloseTo(1.07, 3);
  });

  it('reverses a pop that is cut short', async () => {
    const page = await open('horizontal', 640, 360, [], { document: popDoc });
    await page.setTime(0.5);
    expect((await page.setTime(0.9)).animating).toBe(true);
    // "world" stops being spoken 50 ms into its 120 ms pop: the transition turns back from where it is.
    expect((await page.setTime(0.95)).animating).toBe(true);
    const turned = await keyScale(page);
    expect(turned).toBeGreaterThan(1.001);
    expect(turned).toBeLessThan(1.069);
    expect(await page.step(0.96)).toBe(true);
    const back = await keyScale(page);
    expect(back).toBeLessThan(turned);
    expect(back).toBeGreaterThan(1);
    expect(await page.step(1.2)).toBe(false);
    expect(await keyScale(page)).toBeCloseTo(1, 3);
  });

  it('drops the animations of a cue that is replaced', async () => {
    const page = await open('horizontal', 640, 360, [], { document: popDoc });
    await page.setTime(0.5);
    expect((await page.setTime(0.9)).animating).toBe(true);
    const next = await page.setTime(1);
    expect(next).toEqual({ key: '1:0', animating: false });
  });

  it('sizes text by line length', async () => {
    const size = async (id: string) => {
      const page = await open(id, 600, 600);
      await page.setTime(0.6);
      return page.evaluate<number>('parseFloat(getComputedStyle(document.querySelector(".ot-layer")).fontSize)');
    };
    expect((await size('1x1')) / (await size('horizontal'))).toBeCloseTo(42 / 32, 2);
  });

  it('takes transparent screenshots', async () => {
    const page = await open('horizontal', 320, 180);
    await page.setTime(0);
    const png = await page.screenshot();
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png[25]).toBe(6); // IHDR color type 6 = RGBA
  });

  it.skipIf(!hasFfmpeg)('is transparent outside the caption', async () => {
    const page = await open('horizontal', 320, 180);
    await page.setTime(0.6);
    const file = join(await tempDir('ot-shot-'), 'frame.png');
    await writeFile(file, await page.screenshot());
    const pixel = (x: number, y: number) =>
      spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `crop=1:1:${x}:${y},format=rgba`, '-f', 'rawvideo', '-']).stdout;
    expect([...pixel(0, 0)]).toEqual([0, 0, 0, 0]);
    // The caption itself is drawn: some pixel on its line is opaque.
    const rect = await page.evaluate<{ x: number; y: number; w: number; h: number }>(
      '(() => { const r = document.querySelector(".ot-key").getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()',
    );
    expect(pixel(Math.round(rect.x + rect.w / 2), Math.round(rect.y + rect.h / 2))[3]).toBeGreaterThan(200);
  });

  it('never requests remote URLs', async () => {
    let hits = 0;
    const server = createServer((_, res) => {
      hits++;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const remote = `.ot-theme-social .ot-line { background-image: url(http://127.0.0.1:${port}/x.png); }`;
      const page = await open('horizontal', 320, 180, [remote]);
      await page.setTime(0.6);
      await page.screenshot();
      await page.evaluate('new Promise((resolve) => setTimeout(resolve, 100))');
      expect(hits).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('ignores infinite animations', async () => {
    const spin = '@keyframes ot-social-spin { to { opacity: 0.5; } } .ot-theme-social .ot-line { animation: ot-social-spin 1s infinite; }';
    const page = await open('horizontal', 320, 180, [spin]);
    expect((await page.setTime(0.6)).animating).toBe(false);
  });

  it.skipIf(!systemFont)('uses --font over the pack font', async () => {
    const page = await open('horizontal', 320, 180, [await fontCss(systemFont!, process.cwd())], { styleName: 'lumora', fontPath: systemFont });
    await page.setTime(0.6);
    expect(await page.evaluate<string>('getComputedStyle(document.querySelector(".ot-layer")).fontFamily')).toMatch(/^["']?overtone-burn\b/);
  });

  it('reports a --font file Chrome cannot load', async () => {
    const font = join(await tempDir('ot-font-'), 'broken.woff2');
    await writeFile(font, Buffer.from('not a font'));
    const opening = open('horizontal', 320, 180, [await fontCss(font, process.cwd())], { fontPath: font });
    await expect(opening).rejects.toThrow(UserError);
    await expect(opening).rejects.toThrow(`The --font file could not be loaded as a font: ${font}`);
  });

  it('lets other fonts that fail fall back silently', async () => {
    const broken = `@font-face { font-family: 'pack-font'; src: url(data:font/woff2;base64,${Buffer.from('not a font').toString('base64')}) format('woff2'); }`;
    const page = await open('horizontal', 320, 180, [broken, '.ot-layer.ot-theme-social { --ot-font: pack-font, sans-serif; }']);
    expect((await page.setTime(0.6)).key).toBe('0:0');
  });
});
