import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractAudio, isSilent, MIN_DB, parseMaxVolume, run, SILENT_MAX_VOLUME_DB } from '../src/media/extract.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const opts = { chunkBytes: 24 * 1024 * 1024 };

describe('parseMaxVolume', () => {
  it('reads volumedetect output', () => {
    expect(parseMaxVolume('[Parsed_volumedetect_0 @ 0x1] max_volume: -23.4 dB\n')).toBe(-23.4);
    expect(parseMaxVolume('[Parsed_volumedetect_0 @ 0x1] max_volume: -inf dB\n')).toBe(MIN_DB);
    expect(parseMaxVolume('no samples')).toBe(MIN_DB);
  });
});

describe('isSilent', () => {
  it('is true for no audio and for a peak below the threshold only', () => {
    expect(isSilent({ noAudio: true })).toBe(true);
    expect(isSilent({ maxVolume: SILENT_MAX_VOLUME_DB - 0.1 })).toBe(true);
    expect(isSilent({ maxVolume: SILENT_MAX_VOLUME_DB + 0.1 })).toBe(false);
    // fake extractors in tests report no level: never silent
    expect(isSilent({})).toBe(false);
  });
});

describe.skipIf(!hasFfmpeg)('extractAudio peak level (ffmpeg)', () => {
  it('measures a silent clip as silent and a quiet tone as not silent', async () => {
    const dir = await tempDir('overtone-silence-');
    const silent = join(dir, 'silent.m4a');
    const quiet = join(dir, 'quiet.m4a');
    // generated at runtime, never committed
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '3', '-c:a', 'aac', silent]);
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-af', 'volume=-22dB', '-c:a', 'aac', quiet]);
    const a = await extractAudio(silent, join(dir, 'a'), opts);
    expect(a.maxVolume).toBeLessThan(SILENT_MAX_VOLUME_DB);
    expect(isSilent(a)).toBe(true);
    const b = await extractAudio(quiet, join(dir, 'b'), opts);
    expect(b.maxVolume).toBeGreaterThan(-45);
    expect(b.maxVolume).toBeLessThan(-35);
    expect(isSilent(b)).toBe(false);
  });

  it('returns a no-audio result with allowNoAudio, and keeps the error without it', async () => {
    const dir = await tempDir('overtone-noaudio-');
    const video = join(dir, 'video.mp4');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5:d=2', '-c:v', 'libx264', video]);
    const res = await extractAudio(video, join(dir, 'x'), { ...opts, allowNoAudio: true });
    expect(res).toMatchObject({ noAudio: true, wav: '', chunks: [] });
    expect(res.duration).toBeGreaterThan(1.5);
    expect(isSilent(res)).toBe(true);
    await expect(extractAudio(video, join(dir, 'y'), opts)).rejects.toThrow(/has no audio track/);
  });

  it('keeps a noise floor silent with normalizeLoudness', async () => {
    const dir = await tempDir('overtone-noisefloor-');
    const floor = join(dir, 'floor.m4a');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=a=0.0003:d=3:r=16000', '-c:a', 'aac', floor]);
    const res = await extractAudio(floor, join(dir, 'n'), { ...opts, normalizeLoudness: true });
    expect(res.maxVolume).toBeLessThan(SILENT_MAX_VOLUME_DB);
    expect(isSilent(res)).toBe(true);
  });
});
