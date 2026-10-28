import { readdir, readFile, writeFile as realWriteFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OvertoneDocument } from 'overtone-format';
import { UserError } from '../src/errors.js';
import { writeOutputs } from '../src/output.js';
import { tempDir } from './tmp.js';

// Every writeFile call goes through this mock, so a test can make one fail halfway (a full disk, a stop).
const failNext = vi.hoisted(() => ({ on: undefined as undefined | ((path: string) => boolean) }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (path: Parameters<typeof actual.writeFile>[0], data: string | Uint8Array, ...rest: unknown[]) => {
      if (typeof path === 'string' && failNext.on?.(path)) {
        failNext.on = undefined;
        // half the content reaches the disk, then the disk is full
        await actual.writeFile(path, typeof data === 'string' ? data.slice(0, Math.floor(data.length / 2)) : data.subarray(0, data.length >> 1));
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return (actual.writeFile as (...a: unknown[]) => Promise<void>)(path, data, ...rest);
    },
  };
});

const SAMPLE = resolve(import.meta.dirname, '../../../examples/fixtures/sample.overtone.json');

afterEach(() => {
  failNext.on = undefined;
});

describe('writeOutputs writes atomically', () => {
  it('a failed write leaves the previous file intact and no temporary file behind', async () => {
    const doc = JSON.parse(await readFile(SAMPLE, 'utf8')) as OvertoneDocument;
    const dir = await tempDir('overtone-atomic-');
    const json = join(dir, 'talk.overtone.json');
    const previous = '{"previous": "run"}\n';
    await realWriteFile(json, previous);

    failNext.on = (path) => path.startsWith(`${json}.`);
    const err = await writeOutputs(doc, { base: 'talk', outDir: dir, formats: ['json'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe(`Cannot write ${json} (ENOSPC)`);
    expect(await readFile(json, 'utf8')).toBe(previous);
    expect(await readdir(dir)).toEqual(['talk.overtone.json']);
  });

  it('writes every file under its final name and leaves no temporary files', async () => {
    const doc = JSON.parse(await readFile(SAMPLE, 'utf8')) as OvertoneDocument;
    const dir = await tempDir('overtone-atomic-');
    const written = await writeOutputs(doc, { base: 'talk', outDir: dir, formats: ['json', 'txt'] });
    expect((await readdir(dir)).sort()).toEqual(['talk.overtone.json', 'talk.txt']);
    expect(JSON.parse(await readFile(written[0]!, 'utf8'))).toEqual(doc);
  });
});

describe('writeOutputs and read-only targets', () => {
  it('refuses to replace a read-only file before writing anything', async () => {
    if (process.getuid?.() === 0) return;
    const { chmod } = await import('node:fs/promises');
    const doc = JSON.parse(await readFile(SAMPLE, 'utf8')) as OvertoneDocument;
    const dir = await tempDir('overtone-atomic-');
    const txt = join(dir, 'talk.txt');
    await realWriteFile(txt, 'mine');
    await chmod(txt, 0o444);
    await expect(writeOutputs(doc, { base: 'talk', outDir: dir, formats: ['json', 'txt'] })).rejects.toThrow(`Cannot write ${txt} (EACCES)`);
    expect(await readFile(txt, 'utf8')).toBe('mine');
    expect(await readdir(dir)).toEqual(['talk.txt']);
  });
});
