import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractAudio, probeDuration, run } from '../src/media/extract.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

describe.skipIf(!hasFfmpeg)('extractAudio with several audio tracks', () => {
  it('uses the first audio track, as burn does, not the one with the most channels', async () => {
    const dir = await tempDir('ot-tracks-');
    const media = join(dir, 'two-tracks.mka');
    // track 1: stereo, 1 s ("French"); track 2: 5.1, 2 s ("English"). The durations tell them apart. Neither is
    // marked default, so ffmpeg's own choice would be the one with the most channels.
    await run('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2',
      '-map', '0:a', '-map', '1:a', '-ac:a:0', '2', '-ac:a:1', '6', '-c:a', 'aac', '-disposition:a:0', '0', '-disposition:a:1', '0', media,
    ]);
    const res = await extractAudio(media, join(dir, 'out'), { chunkBytes: 24 * 1024 * 1024 });
    expect(res.duration).toBeCloseTo(1, 1);
    expect(await probeDuration(res.chunks[0].path)).toBeCloseTo(1, 1);
  });
});
