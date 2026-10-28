import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { UserError } from '../errors.js';
import { BURN_FONT_FAMILY, baseCss, burnAssetsDir } from './assets.js';
import type { ChromeTab } from './chrome.js';
import type { CaptionPage } from './frames.js';
import type { PageOptions } from './page/page.js';

export interface CaptionPageOptions extends PageOptions {
  /** The --font file, named in the error when Chrome cannot load it. */
  fontPath?: string;
}

/** Remote requests are blocked: a safety net behind the style-file check. */
const BLOCKED_PATTERNS = ['http', 'https', 'ws', 'wss'].map((scheme) => `${scheme}://*:*/*`);

export interface OpenedCaptionPage extends CaptionPage {
  /** Evaluates `expression` in the page; returns its (awaited) value as JSON. */
  evaluate<T>(expression: string): Promise<T>;
}

/** Loads the caption page into `tab` at the video's size and returns its driver. `o.css` excludes base.css (added first). */
export async function openCaptionPage(tab: ChromeTab, options: CaptionPageOptions): Promise<OpenedCaptionPage> {
  const { fontPath, ...o } = options;
  const evaluate = async <T>(expression: string): Promise<T> => {
    const res = await tab.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res.exceptionDetails) throw new Error(`caption page: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    return res.result.value as T;
  };
  // reset the document: tests open several pages in one tab
  await evaluate('document.getAnimations().forEach((a) => a.cancel()); document.head.replaceChildren(); document.body.replaceChildren(); document.body.removeAttribute("style"); document.documentElement.removeAttribute("style")');
  // `urls` for older Chrome; newer Chrome deprecates it and prefers `urlPatterns`
  await tab.send('Network.enable');
  await tab.send('Network.setBlockedURLs', {
    urlPatterns: BLOCKED_PATTERNS.map((urlPattern) => ({ urlPattern, block: true })),
    urls: ['http://*', 'https://*', 'ws://*', 'wss://*'],
  });
  await tab.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: false });
  await tab.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await tab.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await evaluate(await readFile(resolve(burnAssetsDir(), 'page.js'), 'utf8'));
  const failedFonts = await evaluate<string[]>(`window.overtoneBurn.init(${JSON.stringify({ ...o, css: [await baseCss(), ...o.css] })})`);
  // other faces fall back silently, as in the player; the --font file must load
  if (failedFonts.includes(BURN_FONT_FAMILY)) throw new UserError(`The --font file could not be loaded as a font: ${fontPath ?? BURN_FONT_FAMILY}`);
  return {
    evaluate,
    setTime: (t) => evaluate(`window.overtoneBurn.setTime(${t})`),
    step: (t) => evaluate(`window.overtoneBurn.step(${t})`),
    screenshot: async () => {
      const { data } = await tab.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, fromSurface: true });
      return Buffer.from(data, 'base64');
    },
  };
}
