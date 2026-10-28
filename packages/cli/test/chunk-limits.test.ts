import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, loadConfigFile, resolveConfig } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { planChunks } from '../src/media/chunks.js';
import { tempDir } from './tmp.js';

const BYTES_PER_SECOND = 6000; // the compressed audio: 48 kbit/s

describe('chunkMb range', () => {
  async function load(content: string) {
    const dir = await tempDir('overtone-chunkmb-');
    await writeFile(join(dir, 'overtone.config.json'), content);
    return loadConfigFile(undefined, dir, () => {});
  }

  it.each([['0.05'], ['0.5'], ['26'], ['1e9']])('rejects chunkMb %s with the range', async (value) => {
    const err = await load(`{"chunkMb": ${value}}`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toMatch(/"chunkMb" must be a positive number from 1 to 25/);
  });

  it.each([[1], [1.5], [24], [25]])('accepts chunkMb %s', async (value) => {
    const { config, dir } = await load(`{"chunkMb": ${value}}`);
    const cfg = await resolveConfig({}, config, { cwd: dir, configDir: dir });
    expect(cfg.chunkBytes).toBe(Math.round(value * 1024 * 1024));
  });

  it('the default is inside the range', () => {
    expect(DEFAULTS.chunkMb).toBeGreaterThanOrEqual(DEFAULTS.chunkMbRange.min);
    expect(DEFAULTS.chunkMb).toBeLessThanOrEqual(DEFAULTS.chunkMbRange.max);
  });
});

describe('planChunks guards', () => {
  it.each([
    ['maxBytes 0', { maxBytes: 0, maxSeconds: 1400 }],
    ['maxBytes negative', { maxBytes: -5, maxSeconds: 1400 }],
    ['maxSeconds 0', { maxBytes: 1_000_000, maxSeconds: 0 }],
    ['maxBytes NaN', { maxBytes: Number.NaN, maxSeconds: 1400 }],
  ])('refuses a chunk limit that cannot advance (%s) instead of looping forever', (_name, limits) => {
    expect(() => planChunks(7200, { bytesPerSecond: BYTES_PER_SECOND, silences: [], ...limits })).toThrow(RangeError);
  });

  it('the smallest allowed chunkMb still plans a sane number of chunks for 2 hours', () => {
    const chunks = planChunks(7200, { bytesPerSecond: BYTES_PER_SECOND, maxBytes: DEFAULTS.chunkMbRange.min * 1024 * 1024, maxSeconds: 1400, silences: [] });
    expect(chunks.length).toBeLessThan(50);
    expect(chunks[0]!.start).toBe(0);
    expect(chunks.at(-1)!.end).toBe(7200);
  });
});
