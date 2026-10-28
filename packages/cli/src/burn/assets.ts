import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError, fsCode } from '../errors.js';

/** dist/burn next to the bundled cli.js, or packages/cli/dist/burn when running from source (tests). */
export function burnAssetsDir(): string {
  const candidates = [new URL('./burn/', import.meta.url), new URL('../../dist/burn/', import.meta.url)].map((u) => fileURLToPath(u));
  const found = candidates.find((dir) => existsSync(resolve(dir, 'page.js')));
  if (!found) throw new Error(`The burn assets are missing (looked in ${candidates.join(', ')}); run "npm run build".`);
  return found;
}

/** Built-in style names (the theme CSS files except base.css). */
export function builtInStyles(): string[] {
  return readdirSync(resolve(burnAssetsDir(), 'themes'))
    .filter((f) => f.endsWith('.css') && f !== 'base.css')
    .map((f) => f.slice(0, -'.css'.length))
    .sort();
}

async function readText(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    throw new UserError(`${what} not found or unreadable: ${path} (${fsCode(err) ?? 'error'}).`);
  }
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ');

/** The first `@import` or non-data `url()` outside comments; undefined when the CSS loads nothing. */
export function externalReference(css: string): string | undefined {
  const code = stripComments(css);
  const found = /@import\b[^;]*|\burl\((?!\s*['"]?\s*data:)[^)]*\)?/i.exec(code)?.[0].trim();
  return found && found.length > 80 ? `${found.slice(0, 77)}...` : found;
}

/** --style: a built-in name, or a .css path whose theme is its first `.ot-theme-<name>`. */
export async function loadStyle(style: string, cwd: string): Promise<{ theme: string; css: string }> {
  if (extname(style).toLowerCase() === '.css') {
    const css = await readText(resolve(cwd, style), 'Style file');
    const external = externalReference(css);
    if (external) {
      throw new UserError(`${style} loads ${external}; style files for burn must be self-contained (no @import or remote url()); use --font for a font file.`);
    }
    const theme = /\.ot-theme-([A-Za-z0-9_-]+)/.exec(stripComments(css))?.[1];
    if (!theme) throw new UserError(`${style} does not style a theme: scope its rules to .ot-layer.ot-theme-<name> (see the style-pack template).`);
    return { theme, css };
  }
  const names = builtInStyles();
  if (!names.includes(style)) throw new UserError(`Unknown style "${style}"; built-in styles: ${names.join(', ')}, or a path to a pack's style.css.`);
  return { theme: style, css: await readFile(resolve(burnAssetsDir(), 'themes', `${style}.css`), 'utf8') };
}

/** base.css of videojs-overtone, loaded before every pack. */
export async function baseCss(): Promise<string> {
  return readFile(resolve(burnAssetsDir(), 'themes', 'base.css'), 'utf8');
}

/** The family name of the --font face. */
export const BURN_FONT_FAMILY = 'overtone-burn';

const FONT_FORMATS: Record<string, string> = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' };
const FONT_TYPES: Record<string, string> = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'ttf', '.otf': 'otf' };

/** --font, embedded as a data URL (a file:// font would be blocked) for every caption layer. */
export async function fontCss(path: string, cwd: string): Promise<string> {
  const file = resolve(cwd, path);
  const ext = extname(file).toLowerCase();
  const format = FONT_FORMATS[ext];
  if (!format) throw new UserError(`--font ${path}: expected a .woff2, .woff, .ttf or .otf file.`);
  let data: Buffer;
  try {
    data = await readFile(file);
  } catch (err) {
    throw new UserError(`Font file not found or unreadable: ${file} (${fsCode(err) ?? 'error'}).`);
  }
  // the repeated class outranks a pack's `.ot-layer.ot-theme-<name>` (and `.ot-tall`), so the font wins
  return `@font-face { font-family: '${BURN_FONT_FAMILY}'; src: url(data:font/${FONT_TYPES[ext]};base64,${data.toString('base64')}) format('${format}'); }\n` +
    `.ot-picture .ot-layer.ot-layer.ot-layer { --ot-font: '${BURN_FONT_FAMILY}', sans-serif; }\n`;
}
