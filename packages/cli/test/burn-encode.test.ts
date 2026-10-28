import { spawnSync } from 'node:child_process';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { audioArgs, burnArgs, checkFfmpegVersion, concatList, encode, parseFfmpegVersion } from '../src/burn/encode.js';
import { UserError } from '../src/errors.js';
import { run } from '../src/media/extract.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('concatList', () => {
  it('lists each file with its duration and repeats the last one', () => {
    const list = concatList([{ file: '/t/frame-000000.png', start: 0 }, { file: '/t/frame-000001.png', start: 0.5 }, { file: '/t/frame-000000.png', start: 1.23 }], 2, 25);
    expect(list).toBe([
      'ffconcat version 1.0',
      "file 'frame-000000.png'", 'option framerate 1000000', 'duration 0.500000',
      "file 'frame-000001.png'", 'option framerate 1000000', 'duration 0.730000',
      "file 'frame-000000.png'", 'option framerate 1000000', 'duration 0.770000',
      "file 'frame-000000.png'", 'option framerate 1000000',
      '',
    ].join('\n'));
  });

  it('gives the last entry at least one frame', () => {
    expect(concatList([{ file: 'a.png', start: 0 }, { file: 'b.png', start: 1.99 }], 2, 25)).toContain('duration 0.040000');
  });
});

describe('audioArgs and burnArgs', () => {
  it('copies MP4-compatible audio and re-encodes the rest', () => {
    expect(audioArgs('aac')).toEqual(['-c:a', 'copy']);
    expect(audioArgs('eac3')).toEqual(['-c:a', 'copy']);
    expect(audioArgs('flac')).toEqual(['-c:a', 'copy']);
    expect(audioArgs('pcm_s16le')).toEqual(['-c:a', 'aac', '-b:a', '192k']);
    expect(audioArgs(undefined)).toEqual([]);
  });

  it('overlays the list on the first video stream', () => {
    expect(burnArgs({ media: 'in.mov', list: 'l.ffconcat', output: 'o.mp4', audioCodec: 'aac' })).toEqual([
      '-y', '-v', 'error', '-i', 'in.mov', '-f', 'concat', '-safe', '0', '-i', 'l.ffconcat',
      '-filter_complex', '[0:v:0][1:v]overlay=0:0:eof_action=pass,pad=ceil(iw/2)*2:ceil(ih/2)*2[v]', '-map', '[v]', '-map', '0:a:0?',
      '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'copy',
      '-movflags', '+faststart', 'o.mp4',
    ]);
  });
});

describe('ffmpeg version', () => {
  const upgrade = 'Burning needs ffmpeg 5.0 or later (the installed ffmpeg cannot read the caption list); upgrade ffmpeg.';

  it('reads major and minor from the first line of ffmpeg -version', () => {
    expect(parseFfmpegVersion('ffmpeg version 8.1.1 Copyright (c) 2000-2026 the FFmpeg developers\nbuilt with Apple clang')).toEqual([8, 1]);
    expect(parseFfmpegVersion('ffmpeg version n6.1 Copyright (c) 2000-2023')).toEqual([6, 1]);
    expect(parseFfmpegVersion('ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright (c) 2000-2021')).toEqual([4, 4]);
    expect(parseFfmpegVersion('ffmpeg version 5.0.3-static https://johnvansickle.com/ffmpeg/')).toEqual([5, 0]);
    expect(parseFfmpegVersion('ffmpeg version N-112345-g0123abcdef Copyright (c) 2000-2023')).toBeUndefined();
    expect(parseFfmpegVersion('ffmpeg version git-2022-01-01-abcdef0')).toBeUndefined();
    expect(parseFfmpegVersion('something else')).toBeUndefined();
  });

  it('refuses ffmpeg before 5.0 and accepts 5.0 and later and unknown formats', () => {
    for (const old of ['ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright', 'ffmpeg version 4.3 Copyright', 'ffmpeg version n3.4.8 Copyright', 'ffmpeg version 2.8.17 Copyright']) {
      expect(() => checkFfmpegVersion(old)).toThrow(new UserError(upgrade));
    }
    for (const ok of ['ffmpeg version 5.0 Copyright', 'ffmpeg version 5.1.2 Copyright', 'ffmpeg version n6.1 Copyright', 'ffmpeg version 8.1.1 Copyright', 'ffmpeg version 10.0 Copyright', 'ffmpeg version N-112345-g0123abc Copyright', '']) {
      expect(() => checkFfmpegVersion(ok)).not.toThrow();
    }
  });

  it('turns the "unknown keyword \'option\'" error of an old ffmpeg into the upgrade message', async () => {
    const dir = await tempDir('ot-encode-');
    const old: typeof run = async () => {
      throw new Error("ffmpeg failed: [concat @ 0x1] Line 3: unknown keyword 'option' captions.ffconcat: Invalid data found when processing input");
    };
    await expect(encode({ media: '/m/in.mp4', list: '/m/l.ffconcat', output: join(dir, 'out.mp4') }, old)).rejects.toThrow(new UserError(upgrade));
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('encode with a fake runner', () => {
  it('leaves no partial file when ffmpeg fails', async () => {
    const dir = await tempDir('ot-encode-');
    const runner: typeof run = async (_cmd, args) => {
      await writeFile(args.at(-1)!, 'half'); // ffmpeg had started writing
      throw new Error('ffmpeg failed: boom');
    };
    await expect(encode({ media: '/m/in.mp4', list: '/m/l.ffconcat', output: join(dir, 'out.mp4') }, runner)).rejects.toThrow('ffmpeg failed: boom');
    expect(await readdir(dir)).toEqual([]);
  });

  it('reports an ffmpeg failure as a UserError that names the output', async () => {
    const dir = await tempDir('ot-encode-');
    const runner: typeof run = async () => { throw new Error('ffmpeg failed: No space left on device'); };
    const output = join(dir, 'out.mp4');
    const err = await encode({ media: '/m/in.mp4', list: '/m/l.ffconcat', output }, runner).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe(`ffmpeg failed: No space left on device (while writing ${output})`);
  });

  it('ends with only the output when ffmpeg succeeds', async () => {
    const dir = await tempDir('ot-encode-');
    const runner: typeof run = async (_cmd, args) => {
      await writeFile(args.at(-1)!, 'video');
      return { stdout: '', stderr: '' };
    };
    await encode({ media: '/m/in.mp4', list: '/m/l.ffconcat', output: join(dir, 'out.mp4') }, runner);
    expect(await readdir(dir)).toEqual(['out.mp4']);
  });
});

/** RGB of a 2×2 block at (x, y) of `file` at `t` seconds. */
async function pixel(file: string, t: number, x: number, y: number): Promise<number[]> {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `crop=2:2:${x}:${y},format=rgb24`, '-f', 'rawvideo', '-']);
  return [...out.stdout.subarray(0, 3)];
}

describe.skipIf(!hasFfmpeg)('encode', () => {
  it('shows each image during its span only', async () => {
    const dir = await tempDir('ot-encode-');
    const media = join(dir, 'in.mp4');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', media]);
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black@0.0:size=320x180,format=rgba', '-frames:v', '1', join(dir, 'blank.png')]);
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black@0.0:size=320x180,format=rgba,drawbox=x=100:y=140:w=120:h=30:color=red@1:t=fill:replace=1', '-frames:v', '1', join(dir, 'red.png')]);
    const entries = [{ file: join(dir, 'blank.png'), start: 0 }, { file: join(dir, 'red.png'), start: 0.5 }, { file: join(dir, 'blank.png'), start: 1.23 }];
    await writeFile(join(dir, 'list.ffconcat'), concatList(entries, 2, 25));
    const output = join(dir, 'out.mp4');
    await encode({ media, list: join(dir, 'list.ffconcat'), output, audioCodec: 'aac' });
    const red = (rgb: number[]) => rgb[0] > 200 && rgb[2] < 60;
    expect(red(await pixel(output, 0.44, 160, 154))).toBe(false);
    expect(red(await pixel(output, 0.52, 160, 154))).toBe(true);
    expect(red(await pixel(output, 1.2, 160, 154))).toBe(true);
    expect(red(await pixel(output, 1.28, 160, 154))).toBe(false);
  });
  it('places images on the exact frame of 30 fps video', async () => {
    const dir = await tempDir('ot-encode-');
    const media = join(dir, 'in.mp4');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=30:duration=1', '-pix_fmt', 'yuv420p', media]);
    const entries = [];
    for (let k = 0; k < 10; k++) {
      // Image k: a 20x20 red box at x = 10 + 30k, otherwise transparent.
      const file = join(dir, `img-${k}.png`);
      await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=black@0.0:size=320x180,format=rgba,drawbox=x=${10 + 30 * k}:y=80:w=20:h=20:color=red@1:t=fill:replace=1`, '-frames:v', '1', file]);
      entries.push({ file, start: k / 30 });
    }
    await writeFile(join(dir, 'list.ffconcat'), concatList(entries, 1, 30));
    const output = join(dir, 'out.mp4');
    await encode({ media, list: join(dir, 'list.ffconcat'), output });
    // All frames of one 20x20 row strip: for frame n the box centre must sit at x = 20 + 30 * n (n < 10).
    const raw = spawnSync('ffmpeg', ['-v', 'error', '-i', output, '-vf', 'crop=320:2:0:90,format=rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 64 * 1024 * 1024 }).stdout;
    const rowBytes = 320 * 2 * 3;
    expect(raw.length).toBe(30 * rowBytes);
    for (let n = 0; n < 10; n++) {
      const frame = raw.subarray(n * rowBytes, (n + 1) * rowBytes);
      const isRed = (x: number) => frame[x * 3] > 200 && frame[x * 3 + 2] < 60;
      for (let k = 0; k < 10; k++) expect(isRed(20 + 30 * k), `frame ${n}, box ${k}`).toBe(k === n);
    }
  });

  it('pads odd dimensions to even ones', async () => {
    const dir = await tempDir('ot-encode-');
    // A 321x181 source (the odd size comes from a different, non-x264 encoder path). It is made in 4:4:4: for a
    // 4:2:0 format ffmpeg before 7 rounds the color source down to an even size (320x180), and nothing is odd.
    const odd = join(dir, 'odd.mkv');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=321x181:rate=25:duration=1,format=yuv444p', '-c:v', 'ffv1', '-pix_fmt', 'yuv444p', odd]);
    const size = (file: string) => run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).then((r) => r.stdout.trim());
    expect(await size(odd)).toBe('321,181');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black@0.0:size=321x181,format=rgba', '-frames:v', '1', join(dir, 'blank.png')]);
    await writeFile(join(dir, 'list.ffconcat'), concatList([{ file: join(dir, 'blank.png'), start: 0 }], 1, 25));
    const output = join(dir, 'out.mp4');
    await encode({ media: odd, list: join(dir, 'list.ffconcat'), output });
    expect(await size(output)).toBe('322,182');
  });
});
