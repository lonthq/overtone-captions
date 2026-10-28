import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/media/extract.js';
import { parseVideoProbe, probeVideo } from '../src/media/video.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

const probe = (streams: object[], duration = '2.000000') => ({ streams, format: { duration } });

describe('parseVideoProbe', () => {
  it('reads size, frame rate, duration and the audio codec', () => {
    const info = parseVideoProbe(probe([
      { codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30000/1001', disposition: { attached_pic: 0 } },
      { codec_type: 'audio', codec_name: 'aac' },
    ]));
    expect(info).toEqual({ width: 1920, height: 1080, fps: 30000 / 1001, duration: 2, audioCodec: 'aac' });
  });

  it('swaps width and height for a 90° or 270° rotation, not for 180°', () => {
    const size = (rotation: number | string) => {
      const info = parseVideoProbe(probe([{ codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '25/1', side_data_list: [{ rotation }] }]));
      return [info?.width, info?.height];
    };
    for (const rotation of [90, -90, 270, -270, '90']) expect(size(rotation)).toEqual([1080, 1920]);
    for (const rotation of [0, 180, -180]) expect(size(rotation)).toEqual([1920, 1080]);
  });

  it('takes the rotation from the first side data entry that has one', () => {
    const info = parseVideoProbe(probe([{ codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '25/1', side_data_list: [{}, { rotation: 90 }] }]));
    expect([info?.width, info?.height]).toEqual([1080, 1920]);
  });

  it('ignores cover art and reports no video', () => {
    expect(parseVideoProbe(probe([{ codec_type: 'video', width: 600, height: 600, avg_frame_rate: '0/0', disposition: { attached_pic: 1 } }, { codec_type: 'audio', codec_name: 'mp3' }]))).toBeUndefined();
    expect(parseVideoProbe(probe([{ codec_type: 'audio', codec_name: 'aac' }]))).toBeUndefined();
  });

  it('reads the duration from the format, else from the video stream, else leaves it out', () => {
    const video = { codec_type: 'video', width: 2, height: 2, avg_frame_rate: '25/1' };
    expect(parseVideoProbe(probe([video], '2.500000'))?.duration).toBe(2.5);
    expect(parseVideoProbe({ streams: [{ ...video, duration: '3.250000' }], format: {} })?.duration).toBe(3.25);
    expect(parseVideoProbe({ streams: [{ ...video, duration: '3.250000' }], format: { duration: 'N/A' } })?.duration).toBe(3.25);
    const none = parseVideoProbe({ streams: [video], format: {} });
    expect(none).toBeDefined();
    expect(none).not.toHaveProperty('duration');
  });

  it('uses the average frame rate when plausible, else the real base rate, else 25', () => {
    const fps = (avg: string, r?: string) => parseVideoProbe(probe([{ codec_type: 'video', width: 2, height: 2, avg_frame_rate: avg, ...(r ? { r_frame_rate: r } : {}) }]))?.fps;
    expect(fps('0/0')).toBe(25);
    expect(fps('0/0', '30/1')).toBe(30);
    expect(fps('90000/1', '25/1')).toBe(25);
    expect(fps('90000/1', '0/0')).toBe(25);
    expect(fps('24000/1001', '24/1')).toBe(24000 / 1001);
  });
});

describe.skipIf(!hasFfmpeg)('probeVideo', () => {
  it('probes a generated square clip', async () => {
    const dir = await tempDir('ot-probe-');
    const file = join(dir, 'square.mp4');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=180x180:rate=25:duration=1', '-pix_fmt', 'yuv420p', file]);
    expect(await probeVideo(file)).toMatchObject({ width: 180, height: 180, fps: 25 });
  });

  it('reports the display size of a rotated clip', async () => {
    const dir = await tempDir('ot-probe-');
    const plain = join(dir, 'plain.mp4');
    const rotated = join(dir, 'rotated.mp4');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25:duration=1', '-pix_fmt', 'yuv420p', plain]);
    await run('ffmpeg', ['-y', '-v', 'error', '-display_rotation', '90', '-i', plain, '-c', 'copy', rotated]);
    expect(await probeVideo(rotated)).toMatchObject({ width: 180, height: 320 });
  });

  it('returns undefined for audio-only media', async () => {
    const dir = await tempDir('ot-probe-');
    const file = join(dir, 'a.m4a');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', file]);
    expect(await probeVideo(file)).toBeUndefined();
  });
});
