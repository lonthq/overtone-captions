// Static server for site/dist under the GitHub Pages sub-path, so links that work here work on Pages.
//   npm run site:preview                     http://localhost:4173/overtone-captions/
//   PORT=5000 SITE_BASE=/x/ npm run site:preview
// Range requests: Safari needs them for mp4. Listens on 127.0.0.1 only.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const DIST = fileURLToPath(new URL('../dist/', import.meta.url));

/** '/overtone-captions/' style: leading and trailing slash, '/' for the root. */
export function normalizeBase(base = '/overtone-captions/') {
  const trimmed = base.replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
};

function fileInfo(path) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function handle(root, base, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  if (base !== '/' && (pathname === '/' || `${pathname}/` === base)) {
    res.writeHead(302, { Location: base }).end();
    return;
  }
  const notFound = () => {
    const page = join(root, '404.html');
    const info = fileInfo(page);
    res.writeHead(404, { 'Content-Type': TYPES['.html'], ...(info && { 'Content-Length': info.size }) });
    if (info && req.method === 'GET') createReadStream(page).pipe(res);
    else res.end();
  };
  if (!pathname.startsWith(base)) return notFound();
  let file = resolve(root, `./${pathname.slice(base.length)}`);
  if (file !== root && !file.startsWith(root + sep)) return notFound();
  let info = fileInfo(file);
  if (info?.isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: `${pathname}/` }).end();
      return;
    }
    file = join(file, 'index.html');
    info = fileInfo(file);
  }
  if (!info?.isFile()) return notFound();
  const headers = { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  let range;
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }
    range = { start, end };
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
  }
  if (req.method === 'HEAD') return res.end();
  pipeline(createReadStream(file, range ?? {}), res, () => {});
}

/** Resolves to { server, url } once listening; port 0 picks a free port. */
export function startPreview({ root = DIST, base = process.env.SITE_BASE, port = 4173 } = {}) {
  const normalized = normalizeBase(base);
  const absRoot = resolve(root);
  const server = createServer((req, res) => handle(absRoot, normalized, req, res));
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${server.address().port}${normalized}`;
      done({ server, url });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fileInfo(join(DIST, 'index.html'))) {
    console.error('site/dist is empty: run npm run site:build first.');
    process.exit(1);
  }
  const { url } = await startPreview({ port: Number(process.env.PORT ?? 4173) });
  console.log(`Overtone site preview: ${url}`);
  console.log(`  demo:          ${url}demo/`);
  console.log(`  style gallery: ${url}styles/`);
}
