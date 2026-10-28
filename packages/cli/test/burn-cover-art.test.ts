import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OvertoneDocument } from 'overtone-format';
import { burnAssetsDir } from '../src/burn/assets.js';
import { findChrome } from '../src/burn/chrome.js';
import { burnArgs, concatList, encode } from '../src/burn/encode.js';
import { burn } from '../src/burn/index.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { parseVideoProbe } from '../src/media/video.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const ready = hasFfmpeg && (() => {
  try {
    findChrome();
    return existsSync(join(burnAssetsDir(), 'page.js'));
  } catch {
    return false;
  }
})();

/**
 * A 100x100 still stream first, the 320x180 picture second: a stand-in for cover art that comes first (ffmpeg's
 * muxers write a real attached picture after the other streams, so such a file cannot be made here).
 */
async function stillFirst(dir: string): Promise<string> {
  const media = join(dir, 'in.mkv');
  await run('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:size=100x100:rate=1:duration=1', '-f', 'lavfi', '-i', 'color=c=blue:size=320x180:rate=25:duration=1',
    '-map', '0:v', '-map', '1:v', '-c:v', 'mjpeg', '-q:v', '5', media,
  ]);
  return media;
}

const probe = (streams: object[]) => ({ streams, format: { duration: '2.000000' } });

describe('the video and audio streams a burn uses', () => {
  it('reports which video stream it measured when cover art comes first', () => {
    const info = parseVideoProbe(probe([
      { codec_type: 'video', codec_name: 'mjpeg', width: 600, height: 600, avg_frame_rate: '0/0', disposition: { attached_pic: 1 } },
      { codec_type: 'audio', codec_name: 'aac' },
      { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, avg_frame_rate: '25/1', disposition: { attached_pic: 0 } },
    ]));
    expect(info).toEqual({ width: 1280, height: 720, fps: 25, duration: 2, audioCodec: 'aac', videoStream: 1 });
  });

  it('reports the codec of the first audio track, the one burn keeps and extraction transcribes', () => {
    const info = parseVideoProbe(probe([
      { codec_type: 'video', width: 1280, height: 720, avg_frame_rate: '25/1' },
      { codec_type: 'audio', codec_name: 'opus' },
      { codec_type: 'audio', codec_name: 'eac3' },
    ]));
    expect(info?.audioCodec).toBe('opus');
  });

  it('overlays the captions on that video stream', () => {
    const args = burnArgs({ media: 'in.mp4', list: 'l.ffconcat', output: 'o.mp4', videoStream: 1 });
    expect(args[args.indexOf('-filter_complex') + 1]).toBe('[0:v:1][1:v]overlay=0:0:eof_action=pass,pad=ceil(iw/2)*2:ceil(ih/2)*2[v]');
  });

  it.skipIf(!hasFfmpeg)('encodes the second video stream when told to', async () => {
    const dir = await tempDir('ot-cover-');
    const media = await stillFirst(dir);
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black@0.0:size=320x180,format=rgba', '-frames:v', '1', join(dir, 'blank.png')]);
    await writeFile(join(dir, 'list.ffconcat'), concatList([{ file: join(dir, 'blank.png'), start: 0 }], 1, 25));
    const output = join(dir, 'out.mp4');
    await encode({ media, list: join(dir, 'list.ffconcat'), output, videoStream: 1 });
    const size = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', output]);
    expect(size.stdout.trim()).toBe('320,180');
  });

  it.skipIf(!ready)('burns onto the probed video stream, not the one before it', async () => {
    const dir = await tempDir('ot-cover-');
    const media = await stillFirst(dir);
    const doc: OvertoneDocument = {
      format: 'overtone', version: 1, language: 'en', duration: 1,
      speakers: [{ id: 'S1' }],
      turns: [{ speaker: 'S1', start: 0.2, end: 0.8, words: [{ text: 'Hello', start: 0.2, end: 0.8 }] }],
      profiles: [{ id: 'horizontal', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2 }, cues: [{ start: 0.2, end: 0.8, speaker: 'S1', lines: [{ words: [0, 0], text: 'Hello' }] }] }],
    };
    const output = join(dir, 'out.mp4');
    const video = { width: 320, height: 180, fps: 25, duration: 1, videoStream: 1 };
    await burn(media, doc, { cwd: dir, output }, memoryLogger(), { probe: async () => video });
    const size = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', output]);
    expect(size.stdout.trim()).toBe('320,180');
  }, 30_000);
});
