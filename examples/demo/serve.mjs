// Static server for the demo and style gallery, from an allowlist under the repo root. Range requests: Safari needs them.
//   node examples/demo/serve.mjs            (PORT=8080 to change the port)
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Everything else (.env, .git, sources) is 404.
const ALLOWED_PREFIXES = [
  '/examples/',
  '/packages/videojs/dist/',
  '/packages/format/dist/',
  '/node_modules/video.js/dist/',
];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Absolute file path for a URL path, or null when it is malformed or escapes `root`. */
export function resolvePath(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const base = resolve(root);
  const full = resolve(base, `.${decoded.startsWith('/') ? '' : '/'}${decoded}`);
  return full === base || full.startsWith(base + sep) ? full : null;
}

/** Parses a single `bytes=` range. null = no (usable) header, 'invalid' = unsatisfiable. */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // multiple ranges or other units: send the whole file
  const [, first, last] = match;
  if (first === '' && last === '') return 'invalid';
  const start = first === '' ? Math.max(0, size - Number(last)) : Number(first);
  const end = first === '' || last === '' ? size - 1 : Math.min(Number(last), size - 1);
  return start > end || start >= size ? 'invalid' : { start, end };
}

function stat(path) {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/** Allowed to be served: under an allowlisted prefix and no path segment starting with a dot. */
function isServable(base, full) {
  const urlPath = `/${relative(base, full).split(sep).join('/')}`;
  if (urlPath.split('/').some((segment) => segment.startsWith('.'))) return false;
  return ALLOWED_PREFIXES.some((prefix) => urlPath.startsWith(prefix) || `${urlPath}/` === prefix);
}

/** Same check on the real path, so a symlink cannot lead out. */
function realPathServable(root, full) {
  try {
    const base = realpathSync(root);
    const real = realpathSync(full);
    return real.startsWith(base + sep) && isServable(base, real);
  } catch {
    return false;
  }
}

function handle(root, req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let pathname;
  try {
    if (!req.url?.startsWith('/')) throw new Error('not an origin-form request target');
    ({ pathname } = new URL(req.url, 'http://localhost'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
    return;
  }
  if (pathname === '/') {
    res.writeHead(302, { Location: '/examples/demo/' }).end();
    return;
  }
  let file = resolvePath(root, pathname);
  if (!file) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }
  const notFound = () => res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  if (!isServable(resolve(root), file)) {
    notFound();
    return;
  }
  let info = stat(file);
  if (info?.isDirectory()) {
    if (!pathname.endsWith('/')) {
      res.writeHead(301, { Location: `/${pathname.replace(/^\/+/, '')}/` }).end();
      return;
    }
    file = join(file, 'index.html');
    info = stat(file);
  }
  if (!info?.isFile() || !realPathServable(root, file)) {
    notFound();
    return;
  }
  const headers = {
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };
  const range = parseRange(req.headers.range, info.size);
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }).end();
    return;
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
      'Content-Length': range.end - range.start + 1,
    });
  } else {
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
  }
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  // pipeline closes the file stream when the client aborts.
  pipeline(createReadStream(file, range ?? {}), res, () => {});
}

export function createStaticServer(root = REPO_ROOT) {
  return createServer((req, res) => handle(root, req, res));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 5173);
  createStaticServer().listen(port, '127.0.0.1', () => {
    console.log(`Overtone examples running:`);
    console.log(`  demo:          http://localhost:${port}/examples/demo/`);
    console.log(`  style gallery: http://localhost:${port}/examples/styles/`);
  });
}
