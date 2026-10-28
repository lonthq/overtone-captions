import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticServer, parseRange, resolvePath } from '../serve.mjs';

const root = mkdtempSync(join(tmpdir(), 'overtone-serve-'));
const outside = mkdtempSync(join(tmpdir(), 'overtone-outside-'));
writeFileSync(join(outside, 'secret.txt'), 'secret');
mkdirSync(join(root, 'examples', 'site'), { recursive: true });
mkdirSync(join(root, '.git'));
writeFileSync(join(root, '.git', 'config'), 'git');
writeFileSync(join(root, '.env'), 'KEY=secret');
writeFileSync(join(root, 'package.json'), '{}');
mkdirSync(join(root, 'packages', 'videojs', 'src'), { recursive: true });
writeFileSync(join(root, 'packages', 'videojs', 'src', 'index.ts'), 'export {};');
mkdirSync(join(root, 'packages', 'videojs', 'dist'), { recursive: true });
writeFileSync(join(root, 'packages', 'videojs', 'dist', 'index.js'), 'export {};');
writeFileSync(join(root, 'examples', 'site', 'index.html'), '<h1>hi</h1>');
writeFileSync(join(root, 'examples', 'data.json'), '{"a":1}');
writeFileSync(join(root, 'examples', 'clip.mp4'), '0123456789');
writeFileSync(join(root, 'examples', '.hidden'), 'hidden');
symlinkSync(join(outside, 'secret.txt'), join(root, 'examples', 'link.txt'));
symlinkSync('../.env', join(root, 'examples', 'envlink'));

const server = createStaticServer(root);
let base = '';

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe('resolvePath', () => {
  it('maps URL paths inside the root', () => {
    expect(resolvePath(root, '/data.json')).toBe(join(root, 'data.json'));
    expect(resolvePath(root, '/site/%69ndex.html')).toBe(join(root, 'site', 'index.html'));
  });

  it('rejects paths that escape the root or are malformed', () => {
    expect(resolvePath(root, '/..%2f..%2fetc/passwd')).toBeNull();
    expect(resolvePath(root, '/%E0%A4%A')).toBeNull();
  });
});

describe('parseRange', () => {
  it('parses start-end, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange('bytes=7-', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=5-99', 10)).toEqual({ start: 5, end: 9 });
  });

  it('ignores missing or multi-range headers and flags unsatisfiable ones', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseRange('bytes=10-12', 10)).toBe('invalid');
    expect(parseRange('bytes=-', 10)).toBe('invalid');
  });
});

describe('createStaticServer', () => {
  it('serves files with a content type', async () => {
    const response = await fetch(`${base}/examples/data.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await response.json()).toEqual({ a: 1 });
  });

  it('serves index.html for directories and redirects to a trailing slash', async () => {
    expect(await (await fetch(`${base}/examples/site/`)).text()).toBe('<h1>hi</h1>');
    const redirect = await fetch(`${base}/examples/site`, { redirect: 'manual' });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get('location')).toBe('/examples/site/');
  });

  it('answers byte ranges with 206', async () => {
    const response = await fetch(`${base}/examples/clip.mp4`, { headers: { Range: 'bytes=2-5' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await response.text()).toBe('2345');
  });

  it('returns 404 for missing files and 416 for bad ranges', async () => {
    expect((await fetch(`${base}/nope.txt`)).status).toBe(404);
    expect((await fetch(`${base}/examples/clip.mp4`, { headers: { Range: 'bytes=50-60' } })).status).toBe(416);
  });

  it('answers HEAD without a body', async () => {
    const response = await fetch(`${base}/examples/clip.mp4`, { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('10');
  });

  it('serves only allowlisted prefixes and no dotfiles', async () => {
    for (const path of ['/.env', '/.git/config', '/package.json', '/packages/videojs/src/index.ts', '/examples/.hidden']) {
      expect((await fetch(`${base}${path}`)).status, path).toBe(404);
    }
    const asset = await fetch(`${base}/packages/videojs/dist/index.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('redirects / to the demo', async () => {
    const response = await fetch(`${base}/`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/examples/demo/');
  });

  it('does not follow symlinks out of the root', async () => {
    expect((await fetch(`${base}/examples/link.txt`)).status).toBe(404);
  });

  it('applies the allowlist to symlink targets', async () => {
    expect((await fetch(`${base}/examples/envlink`)).status).toBe(404);
  });

  it('answers 400 for malformed request targets and keeps serving', async () => {
    const written: { status?: number } = {};
    const res = {
      writeHead(status: number) {
        written.status = status;
        return res;
      },
      end() {},
    };
    server.emit('request', { method: 'GET', url: '//[', headers: {} }, res);
    expect(written.status).toBe(400);

    const raw = await new Promise<string>((done) => {
      const socket = connect((server.address() as AddressInfo).port, '127.0.0.1');
      let data = '';
      socket.on('data', (chunk) => (data += chunk));
      socket.on('close', () => done(data));
      socket.on('error', () => done(data));
      socket.write('GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    expect(raw).not.toContain('200 OK');
    expect((await fetch(`${base}/examples/data.json`)).status).toBe(200);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'survives a file that cannot be read',
    async () => {
      const locked = join(root, 'examples', 'locked.txt');
      writeFileSync(locked, 'nope');
      chmodSync(locked, 0o000);
      await fetch(`${base}/examples/locked.txt`).then((r) => r.text()).catch(() => undefined);
      expect((await fetch(`${base}/examples/data.json`)).status).toBe(200);
    },
  );

  it('knows more content types', async () => {
    writeFileSync(join(root, 'examples', 'a.webm'), 'x');
    writeFileSync(join(root, 'examples', 'a.webp'), 'x');
    expect((await fetch(`${base}/examples/a.webm`)).headers.get('content-type')).toBe('video/webm');
    expect((await fetch(`${base}/examples/a.webp`)).headers.get('content-type')).toBe('image/webp');
  });
});
