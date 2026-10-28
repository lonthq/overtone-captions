// Builds the static site for GitHub Pages into site/dist (git-ignored).
//   npm run site:build                   builds the packages, then the site
//   npm run site:build -- --record       also records a fresh hero clip (site/scripts/record-clip.mjs)
//   SITE_BASE=/other-repo/ npm run site:build
//
// site/dist (served under SITE_BASE, default /overtone-captions/):
//   index.html, 404.html, favicon.svg     landing page (site/src/)
//   demo/, styles/                         copies of examples/demo/ and examples/styles/
//   lib/                                   video.js, packages/videojs/dist, packages/format/dist
//   examples/fixtures/, examples/output/   caption files the pages load (no video)
//   media/                                 hero.webp, hero-still.webp (+ hero.mp4 when recorded), social.png
//
// The demo and gallery use root-absolute URLs for the repo-root dev server; their copies get them rewritten through
// PATH_MAP. The landing page uses relative links. verify() then reports URLs outside SITE_BASE or to missing files.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBase } from './preview.mjs';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const SITE = join(REPO, 'site');
const DIST = join(SITE, 'dist');
const BASE = normalizeBase(process.env.SITE_BASE);
const GITHUB = 'https://github.com/lonthq/overtone-captions';
const RECORD = process.argv.includes('--record');

/** Root-absolute URL prefix → place in site/dist (first match wins). */
const PATH_MAP = [
  ['/examples/demo/', 'demo/'],
  ['/examples/styles/', 'styles/'],
  ['/examples/', 'examples/'],
  ['/packages/videojs/dist/', 'lib/videojs-overtone/'],
  ['/packages/format/dist/', 'lib/overtone-format/'],
  ['/node_modules/video.js/dist/', 'lib/video.js/'],
];
/** Pages copied from examples/ (.html, .js and .css only). */
const PAGES = [
  { from: 'examples/demo', to: 'demo', name: 'Demo' },
  { from: 'examples/styles', to: 'styles', name: 'Style gallery' },
];
/** URLs the pages may name but the site does not host. */
const NOT_HOSTED = [/^examples\/media\/.+\.mp4$/];

const rel = (path) => relative(REPO, path);
const read = (path) => readFileSync(path, 'utf8');
function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function copy(from, to, filter) {
  cpSync(join(REPO, from), join(DIST, to), { recursive: true, filter });
}
const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Rewrites quoted root-absolute /examples/, /packages/ and /node_modules/ URLs to SITE_BASE locations. */
function rewriteUrls(text, file) {
  return text.replace(/(["'`(])(\/(?:examples|packages|node_modules)\/[^"'`)\s]*)/g, (all, quote, url) => {
    const entry = PATH_MAP.find(([prefix]) => url.startsWith(prefix) || `${url}/` === prefix);
    if (!entry) {
      console.warn(`  ! ${file}: no site location for ${url} (left as is)`);
      return all;
    }
    return `${quote}${BASE}${entry[1]}${url.slice(entry[0].length)}`;
  });
}

const NAV_CSS = `
.site-nav { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 18px; margin: 0 0 20px; padding: 8px 14px;
  border-radius: 10px; background: #1a1d24; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.site-nav a { color: #c9d1de; text-decoration: none; }
.site-nav a:hover, .site-nav a:focus-visible { color: #fff; text-decoration: underline; }
.site-nav a[aria-current="page"] { color: #fff; font-weight: 600; }
.site-nav .site-home { margin-right: auto; color: #fff; font-weight: 700; letter-spacing: 0.01em; }`;

function siteNav(current) {
  const link = (href, label) =>
    `<a href="${href}"${label === current ? ' aria-current="page"' : ''}>${label}</a>`;
  return (
    `<nav class="site-nav" aria-label="Overtone site"><a class="site-home" href="${BASE}">Overtone</a>` +
    PAGES.map((page) => link(`${BASE}${page.to}/`, page.name)).join('') +
    `<a href="${GITHUB}">GitHub</a></nav>`
  );
}

/** Site-only additions to a copied page: favicon and the site nav. */
function adaptHtml(html, page) {
  const head = `<style>${NAV_CSS}\n</style>`;
  const favicon = `<link rel="icon" href="${BASE}favicon.svg" type="image/svg+xml">`;
  html = /<link rel="icon"[^>]*>/.test(html) ? html.replace(/<link rel="icon"[^>]*>/, favicon) : html.replace('</head>', `${favicon}\n</head>`);
  html = html.replace('</head>', `${head}\n</head>`);
  return html.replace(/<body[^>]*>/, (body) => `${body}\n  ${siteNav(page.name)}`);
}

function buildPages() {
  for (const page of PAGES) {
    for (const name of readdirSync(join(REPO, page.from))) {
      const ext = extname(name);
      if (!['.html', '.js', '.css'].includes(ext) || name.endsWith('.test.js')) continue;
      let text = rewriteUrls(read(join(REPO, page.from, name)), `${page.from}/${name}`);
      if (ext === '.html') text = adaptHtml(text, page);
      write(join(DIST, page.to, name), text);
    }
  }
}

function copyLibraries() {
  for (const required of ['packages/videojs/dist/index.global.js', 'packages/videojs/dist/themes/packs.json', 'packages/format/dist/index.js']) {
    if (!existsSync(join(REPO, required))) throw new Error(`${required} is missing: run npm run build first`);
  }
  copy('packages/videojs/dist', 'lib/videojs-overtone');
  copy('packages/format/dist', 'lib/overtone-format');
  // Only what the pages use: its dist is 16 MB.
  for (const name of ['video.min.js', 'video-js.css', 'video-js.min.css']) {
    copy(`node_modules/video.js/dist/${name}`, `lib/video.js/${name}`);
  }
  copy('examples/fixtures/sample.overtone.json', 'examples/fixtures/sample.overtone.json');
  copy('examples/fixtures/square/sample.overtone.json', 'examples/fixtures/square/sample.overtone.json');
  // Caption files only.
  copy('examples/output', 'examples/output', (src) => !/[/\\]test([/\\]|$)/.test(src) && !src.endsWith('README.md'));
}

function stylePacks() {
  return JSON.parse(read(join(REPO, 'packages/videojs/dist/themes/packs.json'))).packs;
}

/** Canvas size of a WebP file (VP8X, VP8 or VP8L header), or undefined. */
function webpSize(path) {
  if (!existsSync(path)) return undefined;
  const b = readFileSync(path).subarray(0, 32);
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  return undefined;
}

function buildLanding() {
  const packs = stylePacks();
  const hasMp4 = existsSync(join(DIST, 'media/hero.mp4'));
  const hero = webpSize(join(DIST, 'media/hero.webp')) ?? { width: 960, height: 480 };
  const tokens = {
    BASE,
    HERO_W: String(hero.width),
    HERO_H: String(hero.height),
    GITHUB,
    PACK_COUNT: String(packs.length),
    PACK_LIST: packs
      .map((pack) => `<li><a href="styles/?pack=${encodeURIComponent(pack.name)}">${escapeHtml(pack.title)}</a></li>`)
      .join(''),
    MP4_LINK: hasMp4 ? ' · <a href="media/hero.mp4">MP4 version</a>' : '',
  };
  const fill = (text) => text.replace(/%%([A-Z0-9_]+)%%/g, (all, key) => tokens[key] ?? all);
  for (const name of ['index.html', '404.html', 'favicon.svg']) write(join(DIST, name), fill(read(join(SITE, 'src', name))));
}

async function buildMedia() {
  mkdirSync(join(DIST, 'media'), { recursive: true });
  // og:image is a PNG: not every link preview shows WebP.
  cpSync(join(SITE, 'assets', 'social.png'), join(DIST, 'media', 'social.png'));
  if (RECORD) {
    try {
      const { recordClip } = await import('./record-clip.mjs');
      await recordClip({ out: join(DIST, 'media') });
      return;
    } catch (error) {
      console.warn(`  ! recording the hero clip failed, using the committed one: ${error.message}`);
    }
  }
  for (const name of ['hero.webp', 'hero-still.webp']) {
    const from = join(SITE, 'assets', name);
    if (existsSync(from)) cpSync(from, join(DIST, 'media', name));
    else console.warn(`  ! site/assets/${name} is missing: run node site/scripts/record-clip.mjs`);
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

/** Reports URLs outside SITE_BASE or to missing files; returns the problem count. */
function verify() {
  let problems = 0;
  for (const file of walk(DIST)) {
    // lib/ is copied unchanged and not scanned.
    if (!['.html', '.js', '.css'].includes(extname(file)) || rel(file).startsWith(join('site', 'dist', 'lib'))) continue;
    const text = read(file);
    for (const [, url] of text.matchAll(/["'`(](\/(?![/>\s"'])[^"'`)\s<>]*)/g)) {
      if (url.includes('${')) continue; // built at runtime
      const where = rel(file);
      if (!url.startsWith(BASE)) {
        console.warn(`  ! ${where}: ${url} is outside ${BASE}`);
        problems++;
        continue;
      }
      const path = url.slice(BASE.length).replace(/[?#].*$/, '');
      if (NOT_HOSTED.some((pattern) => pattern.test(path))) continue;
      const target = join(DIST, path);
      // A URL ending in / is a page or a prefix the page builds URLs from.
      const ok = existsSync(target) && (statSync(target).isFile() || path.endsWith('/') || path === '');
      if (!ok) {
        console.warn(`  ! ${where}: ${url} does not exist in site/dist`);
        problems++;
      }
    }
    // Relative href/src (the landing page), resolved against the file.
    if (extname(file) !== '.html') continue;
    for (const [, url] of text.matchAll(/\b(?:href|src|srcset)="(?![a-z]+:|\/|#|\?|%%)([^"]+)"/g)) {
      const path = url.replace(/[?#].*$/, '');
      if (!path) continue;
      if (!existsSync(join(dirname(file), path))) {
        console.warn(`  ! ${rel(file)}: ${url} does not exist in site/dist`);
        problems++;
      }
    }
  }
  return problems;
}

function sizeOf(dir) {
  let bytes = 0;
  for (const file of walk(dir)) bytes += statSync(file).size;
  return bytes;
}

const started = Date.now();
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
copyLibraries();
buildPages();
await buildMedia();
buildLanding();
const problems = verify();
const kb = (bytes) => `${(bytes / 1024).toFixed(0)} KB`;
console.log(`Site built in ${((Date.now() - started) / 1000).toFixed(1)} s: site/dist (${kb(sizeOf(DIST))}), base ${BASE}`);
for (const name of readdirSync(DIST)) {
  const path = join(DIST, name);
  console.log(`  ${name.padEnd(14)} ${kb(statSync(path).isDirectory() ? sizeOf(path) : statSync(path).size)}`);
}
if (problems) {
  console.error(`${problems} URL problem(s), see above.`);
  process.exit(1);
}
