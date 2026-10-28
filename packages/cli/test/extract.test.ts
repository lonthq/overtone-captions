import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { UserError } from '../src/errors.js';
import { errorReason, extractAudio, missingBinaries, probeDuration, probeMedia, run } from '../src/media/extract.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('extractAudio (ffmpeg)', () => {
  const dirs: string[] = [];
  async function tmp(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }
  afterAll(async () => {
    await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  });

  /** 6 s: tone 0–2 s, silence 2–4 s, tone 4–6 s. */
  async function toneSilenceTone(): Promise<string> {
    const dir = await tmp('overtone-ffmpeg-');
    const file = join(dir, 'input.m4a');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,2,4),0,0.5*sin(2*PI*440*t))':s=16000:d=6", '-c:a', 'aac', file]);
    return file;
  }

  it('finds ffmpeg and probes the duration', async () => {
    expect(await missingBinaries()).toEqual([]);
    expect(await probeDuration(await toneSilenceTone())).toBeCloseTo(6, 1);
  });

  it('writes a WAV and a single compressed chunk for short media', async () => {
    const media = await toneSilenceTone();
    const out = await tmp('overtone-out-');
    const res = await extractAudio(media, out, { chunkBytes: 24 * 1024 * 1024 });
    expect(res.duration).toBeCloseTo(6, 1);
    expect(res.wav).toBe(join(out, 'audio.wav'));
    expect((await stat(res.wav)).size).toBeGreaterThan(6 * 16000 * 2 * 0.9);
    expect(res.chunks).toEqual([{ path: join(out, 'audio.mp3'), index: 0, start: 0, end: res.duration }]);
  });

  it('writes under temporary names and renames when done (no partial files, old files replaced)', async () => {
    const media = await toneSilenceTone();
    const out = await tmp('overtone-out-');
    await writeFile(join(out, 'audio.wav'), 'stale');
    const res = await extractAudio(media, out, { chunkBytes: 22_000 });
    expect((await readdir(out)).sort()).toEqual(['audio.mp3', 'audio.wav', 'chunk-0.mp3', 'chunk-1.mp3']);
    expect((await stat(res.wav)).size).toBeGreaterThan(6 * 16000 * 2 * 0.9);
  });

  it('splits at the silence when over the size limit', async () => {
    const media = await toneSilenceTone();
    const out = await tmp('overtone-out-');
    // ~6 KB/s compressed; ~3.4 s per chunk, so the first cut lands in the middle of the 2–4 s silence
    const res = await extractAudio(media, out, { chunkBytes: 22_000 });
    expect(res.chunks).toHaveLength(2);
    expect(res.chunks[0].end).toBeGreaterThan(2.8);
    expect(res.chunks[0].end).toBeLessThan(3.2);
    expect(res.chunks[1].start).toBe(res.chunks[0].end);
    for (const c of res.chunks) expect((await stat(c.path)).size).toBeGreaterThan(0);
  });

  it('reports a clear error for a non-media file', async () => {
    await expect(probeDuration(join(tmpdir(), 'definitely-missing.mp4'))).rejects.toThrow(/ffprobe failed/);
  });

  it('probeMedia: a duration, undefined when ffprobe reads the file but has no duration, a UserError for non-media', async () => {
    expect(await probeMedia(await toneSilenceTone())).toBeCloseTo(6, 1);
    const dir = await tmp('overtone-probe-');
    const piped = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=1', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
    await writeFile(join(dir, 'stream.webm'), piped.stdout);
    expect(await probeMedia(join(dir, 'stream.webm'))).toBeUndefined();
    await writeFile(join(dir, 'bogus.mp4'), 'x\n');
    await writeFile(join(dir, 'empty.mp4'), '');
    for (const name of ['bogus.mp4', 'empty.mp4']) {
      const err = await probeMedia(join(dir, name)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UserError);
      expect((err as Error).message.split(join(dir, name))).toHaveLength(2); // the path is named once
      expect((err as Error).message).toMatch(new RegExp(`^Cannot read ${join(dir, name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: not an audio/video file \\(.+\\)$`));
    }
  });

  it('measures a streamed WebM without a container duration from the WAV', async () => {
    const dir = await tmp('overtone-webm-');
    const file = join(dir, 'stream.webm');
    // piped output has no duration in the header (like MediaRecorder recordings)
    const piped = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=3', '-c:a', 'libopus', '-f', 'webm', 'pipe:1'], { maxBuffer: 16 * 1024 * 1024 });
    expect(piped.status).toBe(0);
    await writeFile(file, piped.stdout);
    const res = await extractAudio(file, join(dir, 'out'), { chunkBytes: 24 * 1024 * 1024 });
    expect(res.duration).toBeCloseTo(3, 1);
    expect(res.chunks).toHaveLength(1);
    expect(res.chunks[0].end).toBe(res.duration);
  });

  it('never plans chunks beyond the end of a short audio track in a longer video', async () => {
    const dir = await tmp('overtone-short-');
    const file = join(dir, 'video.mp4');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5:d=6', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-c:a', 'aac', file]);
    const res = await extractAudio(file, join(dir, 'out'), { chunkBytes: 24 * 1024 * 1024, maxChunkSeconds: 1 });
    expect(res.duration).toBeLessThan(2.3);
    expect(res.chunks.length).toBeGreaterThan(1);
    expect(res.chunks.at(-1)!.end).toBe(res.duration);
    for (const c of res.chunks) expect((await stat(c.path)).size).toBeGreaterThan(1000);
  });

  it('rejects media without an audio track with a UserError', async () => {
    const dir = await tmp('overtone-noaudio-');
    const file = join(dir, 'silent.mp4');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5:d=1', '-c:v', 'libx264', file]);
    const err = await extractAudio(file, join(dir, 'out'), { chunkBytes: 24 * 1024 * 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toMatch(/has no audio track/);
  });

  it('handles relative paths that look like options', async () => {
    const dir = await tmp('overtone-weird-');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=d=1', join(dir, '-weird name.wav')]);
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const res = await extractAudio('-weird name.wav', join(dir, 'out'), { chunkBytes: 24 * 1024 * 1024 });
      expect(res.duration).toBeCloseTo(1, 1);
      expect(await probeDuration('-weird name.wav')).toBeCloseTo(1, 1);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('errorReason', () => {
  it('keeps the cause (the first lines) and the last line, without the "[muxer @ 0x…]" tags', () => {
    const webm = [
      '[webm @ 0x74ff018280] Only VP8 or VP9 or AV1 video and Vorbis or Opus audio and WebVTT subtitles are supported for WebM.',
      '[out#0/webm @ 0x74fec1c480] Could not write header (incorrect codec parameters ?): Invalid argument',
      '[vf#0:0 @ 0x74ff024a00] Error sending frames to consumers: Invalid argument',
      '[vf#0:0 @ 0x74ff024a00] Task finished with error code: -22 (Invalid argument)',
      '[vf#0:0 @ 0x74ff024a00] Terminating thread with return code -22 (Invalid argument)',
      '[out#0/webm @ 0x74fec1c480] Nothing was written into output file, because at least one of its streams received no packets.',
      '',
    ].join('\n');
    expect(errorReason(webm)).toBe('Only VP8 or VP9 or AV1 video and Vorbis or Opus audio and WebVTT subtitles are supported for WebM. Could not write header (incorrect codec parameters ?): Invalid argument Error sending frames to consumers: Invalid argument … Nothing was written into output file, because at least one of its streams received no packets.');
    expect(errorReason('in.mp4: No such file or directory\n')).toBe('in.mp4: No such file or directory');
  });
});
