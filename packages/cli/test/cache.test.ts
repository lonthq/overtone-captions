import { createHash } from 'node:crypto';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from './tmp.js';
import { StageCache, hashFile, hashJson, stableStringify } from '../src/cache.js';

const created: string[] = [];

async function tmp(): Promise<string> {
  const dir = await tempDir('overtone-cache-');
  created.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('hashing', () => {
  it('serializes undefined and NaN array items as null', () => {
    expect(stableStringify([undefined, Number.NaN])).toBe('[null,null]');
  });

  it('hashes file bytes', async () => {
    const dir = await tmp();
    const file = join(dir, 'a.bin');
    await writeFile(file, 'hello');
    expect(await hashFile(file)).toBe(createHash('sha256').update('hello').digest('hex'));
  });

  it('serializes objects with sorted keys and skips undefined', () => {
    expect(stableStringify({ b: 1, a: [2, { d: undefined, c: 'x' }] })).toBe('{"a":[2,{"c":"x"}],"b":1}');
    expect(hashJson({ a: 1, b: 2 })).toBe(hashJson({ b: 2, a: 1 }));
    expect(hashJson({ a: 1 })).not.toBe(hashJson({ a: 2 }));
    expect(hashJson({ a: 1 })).toHaveLength(16);
  });
});

describe('StageCache', () => {
  it('round-trips stage data under a key', async () => {
    const root = await tmp();
    const cache = new StageCache(root, 'abcdef0123456789ffff', { useCache: true });
    expect(cache.dir).toBe(join(root, 'abcdef0123456789'));
    await cache.write('timing', 'k1', { words: [1, 2] });
    expect(await cache.read('timing', 'k1')).toEqual({ words: [1, 2] });
    expect(await cache.read('timing', 'k2')).toBeUndefined();
    expect(await cache.read('align', 'k1')).toBeUndefined();
    const entry = JSON.parse(await readFile(join(cache.dir, 'timing.json'), 'utf8'));
    expect(entry).toMatchObject({ stage: 'timing', key: 'k1', data: { words: [1, 2] } });
  });

  it('ignores the cache with --no-cache but still writes', async () => {
    const root = await tmp();
    await new StageCache(root, 'h', { useCache: true }).write('extract', 'k', 1);
    const off = new StageCache(root, 'h', { useCache: false });
    expect(await off.read('extract', 'k')).toBeUndefined();
    await off.write('extract', 'k', 2);
    expect(await new StageCache(root, 'h', { useCache: true }).read('extract', 'k')).toBe(2);
  });

  it('re-runs --from-stage and everything after it', async () => {
    const root = await tmp();
    const cache = new StageCache(root, 'h', { useCache: true, fromStage: 'align' });
    expect(['extract', 'transcribe', 'timing', 'align', 'refine'].map((s) => cache.allows(s as never))).toEqual([true, true, true, false, false]);
    await cache.write('align', 'k', 'x');
    expect(await cache.read('align', 'k')).toBeUndefined();
  });

  it('treats a corrupt entry as a miss', async () => {
    const root = await tmp();
    const cache = new StageCache(root, 'h', { useCache: true });
    await cache.write('refine', 'k', 1);
    await writeFile(join(cache.dir, 'refine.json'), '{oops');
    expect(await cache.read('refine', 'k')).toBeUndefined();
  });

  it('treats a JSON null entry as a miss', async () => {
    const root = await tmp();
    const cache = new StageCache(root, 'h', { useCache: true });
    await cache.write('refine', 'k', 1);
    await writeFile(join(cache.dir, 'refine.json'), 'null');
    expect(await cache.read('refine', 'k')).toBeUndefined();
  });

  it('reads nothing with fromStage extract', async () => {
    const root = await tmp();
    await new StageCache(root, 'h', { useCache: true }).write('extract', 'k', 1);
    const cache = new StageCache(root, 'h', { useCache: true, fromStage: 'extract' });
    expect(await cache.read('extract', 'k')).toBeUndefined();
  });

  it('writes atomically: replaces a corrupt file and leaves no temp files', async () => {
    const root = await tmp();
    const cache = new StageCache(root, 'h', { useCache: true });
    await cache.write('align', 'k0', 0);
    await writeFile(join(cache.dir, 'align.json'), '{oops');
    await cache.write('align', 'k', { ok: true });
    expect(await cache.read('align', 'k')).toEqual({ ok: true });
    expect(await readdir(cache.dir)).toEqual(['align.json']);
  });
});
