import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { memoryLogger } from '../src/log.js';
import { CMUDICT, loadCmudict, parseDictionary, userCacheDir, type DictionarySource } from '../src/reconcile/cmudict.js';
import { loadPhonetics, phrase, usesDictionary } from '../src/reconcile/phonetics.js';
import { tempDir } from './tmp.js';

/** A ustar archive with the given files (what `npm pack` writes, minus the details nobody reads). */
function tar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 'utf8');
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((s, b) => s + b, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

const MODULE = '/** @type {{ [word: string]: string }} */\nexport const dictionary = {\n  "jerk": "JH ER1 K",\n  "thom": "T AA1 M",\n  "thom(2)": "TH AA1 M"\n}\n';
const TARBALL = gzipSync(tar({ 'package/license': 'ISC', 'package/index.js': MODULE, 'package/package.json': '{}' }));
const source = (bytes: Buffer = TARBALL): DictionarySource => ({
  url: 'https://registry.example/cmu.tgz',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  file: 'cmu-test.tgz',
  bytes: bytes.length,
});

/** A fetch that serves `bytes` and counts its calls. */
function serving(bytes: Buffer, status = 200) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(new Uint8Array(bytes), { status });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}
const offline = (async () => {
  throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
}) as unknown as typeof fetch;

describe('CMU dictionary: where it is kept', () => {
  it('uses OVERTONE_CACHE_HOME, else XDG_CACHE_HOME, else ~/.cache (macOS, Linux) or LOCALAPPDATA (Windows)', () => {
    expect(userCacheDir({ OVERTONE_CACHE_HOME: '/data/overtone', XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/a')).toBe('/data/overtone');
    expect(userCacheDir({ XDG_CACHE_HOME: '/xdg' }, 'linux', '/home/a')).toBe('/xdg/overtone');
    expect(userCacheDir({ XDG_CACHE_HOME: 'relative' }, 'linux', '/home/a')).toBe('/home/a/.cache/overtone'); // XDG: absolute only
    expect(userCacheDir({}, 'darwin', '/Users/a')).toBe('/Users/a/.cache/overtone');
    expect(userCacheDir({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32', 'C:\\Users\\a')).toBe('C:\\Users\\a\\AppData\\Local\\overtone');
    expect(userCacheDir({}, 'win32', 'C:\\Users\\a')).toBe('C:\\Users\\a\\AppData\\Local\\overtone');
  });

  it('pins the npm tarball of cmu-pronouncing-dictionary 3.0.0 by its SHA-256', () => {
    expect(CMUDICT.url).toBe('https://registry.npmjs.org/cmu-pronouncing-dictionary/-/cmu-pronouncing-dictionary-3.0.0.tgz');
    expect(CMUDICT.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is not a dependency of the CLI package (only a dev dependency of the repository, for the tests)', async () => {
    const cli = JSON.parse(await readFile(join(import.meta.dirname, '../package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(cli.dependencies)).not.toContain('cmu-pronouncing-dictionary');
    const root = JSON.parse(await readFile(join(import.meta.dirname, '../../../package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    expect(root.devDependencies['cmu-pronouncing-dictionary']).toBe('3.0.0');
  });
});

describe('CMU dictionary: file formats', () => {
  it('reads the npm tarball, its index.js, and the cmudict text formats', () => {
    expect([...parseDictionary(TARBALL)]).toEqual([['jerk', 'JH ER1 K'], ['thom', 'T AA1 M'], ['thom(2)', 'TH AA1 M']]);
    expect(parseDictionary(Buffer.from(MODULE)).get('thom')).toBe('T AA1 M');
    const dict = parseDictionary(Buffer.from(";;; comment\njerk JH ER1 K\nd'artagnan D AH0 R T AE1 NG Y AH0 N # foreign french\nthom T AA1 M\nthom(2) TH AA1 M\n"));
    expect([...dict]).toEqual([['jerk', 'JH ER1 K'], ["d'artagnan", 'D AH0 R T AE1 NG Y AH0 N'], ['thom', 'T AA1 M'], ['thom(2)', 'TH AA1 M']]);
    expect(parseDictionary(Buffer.from(';;; cmudict-0.7b\nJERK  JH ER1 K\n')).get('jerk')).toBe('JH ER1 K');
    expect(() => parseDictionary(Buffer.from('not a dictionary'))).toThrow(/no dictionary entries/);
  });

  it('the tests read the dev dependency (OVERTONE_CMUDICT, vitest.config.ts) and never download', async () => {
    const dict = await loadCmudict({ fetch: offline });
    expect(dict?.size).toBe(135_155);
    expect(dict?.get('jerk')).toBe('JH ER1 K');
  });
});

describe('CMU dictionary: the one-time download', () => {
  it('downloads once, checks the SHA-256, stores it atomically and reads it from the cache afterwards', async () => {
    const dir = await tempDir('overtone-cmudict-');
    const env = { OVERTONE_CACHE_HOME: dir };
    const server = serving(TARBALL);
    const log = memoryLogger();
    const dict = await loadCmudict({ env, fetch: server.fetch, source: source(), log });
    expect(dict?.get('jerk')).toBe('JH ER1 K');
    expect(server.calls).toEqual(['https://registry.example/cmu.tgz']);
    expect(log.lines).toEqual([`info:   downloading the CMU Pronouncing Dictionary (0.00 MB, once) to ${join(dir, 'cmu-test.tgz')}`]);
    expect(await readdir(dir)).toEqual(['cmu-test.tgz']); // no temporary file left
    expect(await readFile(join(dir, 'cmu-test.tgz'))).toEqual(TARBALL);
    // the next run reads the cached copy
    const again = await loadCmudict({ env, fetch: server.fetch, source: source(), log });
    expect(again?.get('thom')).toBe('T AA1 M');
    expect(server.calls).toHaveLength(1);
  });

  it('downloads again when the cached copy is damaged', async () => {
    const dir = await tempDir('overtone-cmudict-');
    await writeFile(join(dir, 'cmu-test.tgz'), 'truncated');
    const server = serving(TARBALL);
    expect((await loadCmudict({ env: { OVERTONE_CACHE_HOME: dir }, fetch: server.fetch, source: source() }))?.size).toBe(3);
    expect(server.calls).toHaveLength(1);
    expect(await readFile(join(dir, 'cmu-test.tgz'))).toEqual(TARBALL);
  });

  it('rejects a download with another SHA-256 and stores nothing', async () => {
    const dir = await tempDir('overtone-cmudict-');
    const log = memoryLogger();
    const other = gzipSync(tar({ 'package/index.js': MODULE.replace('JH ER1 K', 'G ER1 K') }));
    expect(await loadCmudict({ env: { OVERTONE_CACHE_HOME: dir }, fetch: serving(other).fetch, source: source(), log })).toBeUndefined();
    expect(log.lines.filter((l) => l.startsWith('warn:'))).toEqual([expect.stringMatching(/could not download the CMU Pronouncing Dictionary from https:\/\/registry\.example\/cmu\.tgz: its SHA-256 is [0-9a-f]{64}, expected [0-9a-f]{64}\. English sound checks of the text vote use letter-to-sound rules instead/)]);
    expect(await readdir(dir)).toEqual([]);
  });

  it('offline or blocked: one warning that says how to fix it, and no dictionary (never an error)', async () => {
    const dir = await tempDir('overtone-cmudict-');
    for (const fetchImpl of [offline, serving(Buffer.from('Forbidden'), 403).fetch]) {
      const log = memoryLogger();
      expect(await loadCmudict({ env: { OVERTONE_CACHE_HOME: dir }, fetch: fetchImpl, source: source(), log })).toBeUndefined();
      const warnings = log.lines.filter((l) => l.startsWith('warn:'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/fetch failed \(ENOTFOUND\)|HTTP 403/);
      expect(warnings[0]).toContain(`Download it once by hand into ${dir}, or set OVERTONE_CMUDICT to a local copy`);
    }
  });

  it('a cache folder it cannot write to: a warning, and the downloaded dictionary is used anyway', async () => {
    const dir = await tempDir('overtone-cmudict-');
    const notAFolder = join(dir, 'file');
    await writeFile(notAFolder, '');
    const log = memoryLogger();
    expect((await loadCmudict({ env: { OVERTONE_CACHE_HOME: notAFolder }, fetch: serving(TARBALL).fetch, source: source(), log }))?.size).toBe(3);
    expect(log.lines.filter((l) => l.startsWith('warn:'))).toEqual([expect.stringContaining(`could not store the CMU Pronouncing Dictionary in ${notAFolder}`)]);
  });

  it('OVERTONE_CMUDICT: a local copy is read as given (no download); an unreadable one gives a warning', async () => {
    const dir = await tempDir('overtone-cmudict-');
    const copy = join(dir, 'cmudict.dict');
    await writeFile(copy, 'jerk JH ER1 K\n');
    const server = serving(TARBALL);
    expect([...(await loadCmudict({ env: { OVERTONE_CMUDICT: copy }, fetch: server.fetch, source: source() }))!]).toEqual([['jerk', 'JH ER1 K']]);
    expect(server.calls).toEqual([]);
    const log = memoryLogger();
    expect(await loadCmudict({ env: { OVERTONE_CMUDICT: join(dir, 'missing.dict') }, fetch: server.fetch, log })).toBeUndefined();
    expect(log.lines).toEqual([expect.stringMatching(/^warn: OVERTONE_CMUDICT: cannot read .*missing\.dict as the CMU Pronouncing Dictionary .*letter-to-sound rules/)]);
  });
});

describe('phonetics without the dictionary', () => {
  it('loads once per process, warns once, and English falls back to the letter-to-sound rules', async () => {
    const dir = await tempDir('overtone-cmudict-');
    const log = memoryLogger();
    await loadPhonetics({ env: { OVERTONE_CACHE_HOME: dir }, fetch: offline, log });
    await loadPhonetics({ env: { OVERTONE_CACHE_HOME: dir }, fetch: offline, log });
    expect(log.lines.filter((l) => l.startsWith('warn:'))).toHaveLength(1);
    // "colonel" is in the dictionary as K ER1 N AH0 L; the rules read the spelling
    expect(phrase('colonel', 'en').phones).toEqual(['K', 'AA', 'L', 'AA', 'N', 'EH', 'L']);
    expect(usesDictionary('en-US')).toBe(true);
    expect(usesDictionary('nl')).toBe(false);
  });
});
