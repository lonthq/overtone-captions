import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BITEXACT_ARGS, COMPRESSED, cutAudio, extractAudio, normalizeLoudness, run, WAV_ARGS } from '../src/media/extract.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

/** What an ffmpeg upgrade or the input's tags would change in the bytes: version strings and copied metadata. */
const VOLATILE = /Lav[fc]\d|major_brand|ISFT|TSSE|Overtone test title/;

describe('extracted audio is the same bytes whatever the ffmpeg version', () => {
  it('writes no metadata and no ffmpeg version into the WAV and the MP3 (output options)', () => {
    expect(BITEXACT_ARGS).toEqual(['-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact']);
    for (const args of [WAV_ARGS, COMPRESSED.args]) expect(args.slice(-BITEXACT_ARGS.length)).toEqual(BITEXACT_ARGS);
  });

  it.skipIf(!hasFfmpeg)('leaves no Lavf/Lavc version or input tags in any file that is uploaded or hashed', async () => {
    const dir = await tempDir('overtone-bitexact-');
    const media = join(dir, 'tagged.m4a');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', "aevalsrc='if(between(t,2,4),0,0.5*sin(2*PI*440*t))':s=16000:d=6", '-metadata', 'title=Overtone test title', '-c:a', 'aac', media]);
    expect((await readFile(media)).toString('latin1')).toMatch(/Overtone test title/);
    // a tiny chunk limit: the MP3 is split, so the stream-copied chunks are checked too
    const res = await extractAudio(media, join(dir, 'out'), { chunkBytes: 20_000, maxChunkSeconds: 3 });
    expect(res.chunks.length).toBeGreaterThan(1);
    const files = [res.wav, join(dir, 'out', 'audio.mp3'), ...res.chunks.map((c) => c.path), await normalizeLoudness(res.wav), await cutAudio(res.chunks[0]!.path, 0.5, 1.5)];
    for (const f of files) expect([f, (await readFile(f)).toString('latin1').match(VOLATILE)?.[0]]).toEqual([f, undefined]);
  });
});
