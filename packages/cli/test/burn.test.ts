import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { OvertoneDocument } from 'overtone-format';
import { burnAssetsDir } from '../src/burn/assets.js';
import { findChrome, type ChromeTab } from '../src/burn/chrome.js';
import { burn } from '../src/burn/index.js';
import { UserError } from '../src/errors.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { buildProgram } from '../src/program.js';
import { tempDir } from './tmp.js';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const hasAssets = (() => {
  try {
    return existsSync(join(burnAssetsDir(), 'page.js'));
  } catch {
    return false;
  }
})();
const ready = hasFfmpeg && hasAssets && (() => {
  try {
    findChrome();
    return true;
  } catch {
    return false;
  }
})();

afterEach(() => {
  process.exitCode = 0;
});

const rules = { maxCharsPerLine: 42, maxLines: 2 };
function makeDoc(): OvertoneDocument {
  return {
    format: 'overtone', version: 1, language: 'en', duration: 2,
    speakers: [{ id: 'S1' }],
    turns: [{ speaker: 'S1', start: 0.5, end: 1.5, words: [
      { text: 'Hello', start: 0.5, end: 0.9 },
      { text: 'world', start: 0.9, end: 1.5, classes: ['key'] },
    ] }],
    profiles: [{ id: 'horizontal', aspect: '16:9', rules, cues: [{ start: 0.5, end: 1.5, speaker: 'S1', lines: [{ words: [0, 1], text: 'Hello world' }] }] }],
  };
}

async function clip(dir: string, size = '320x180', audio = true): Promise<string> {
  const file = join(dir, `clip-${size}.mp4`);
  const inputs = ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25:duration=2`, ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'] : [])];
  await run('ffmpeg', ['-y', '-v', 'error', ...inputs, '-pix_fmt', 'yuv420p', ...(audio ? ['-c:a', 'aac', '-shortest'] : []), file]);
  return file;
}

/** Mean absolute difference of the caption area (16% from the bottom, centered) of two videos at `t`. */
function diff(a: string, b: string, t: number): number {
  const grab = (f: string) => spawnSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', f, '-frames:v', '1', '-vf', 'crop=iw/2:ih/6:iw/4:ih*7/10,format=rgb24', '-f', 'rawvideo', '-']).stdout;
  const x = grab(a);
  const y = grab(b);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
}

const VIDEO = { width: 320, height: 180, fps: 25, duration: 2 };
/** The burn temp folders under `root`: each test gives burn its own root, so other test files running at the same time do not show up. */
const burnFolders = (root: string) => readdirSync(root).filter((f) => f.startsWith('overtone-burn-')).sort();
/** A file that stands in for the media where the probe is injected. */
async function stub(dir: string): Promise<string> {
  const file = join(dir, 'a.mp4');
  await writeFile(file, 'not really a video');
  return file;
}
const ffmpegVersion = async () => 'ffmpeg version 8.1.1 Copyright (c) 2000-2026 the FFmpeg developers';
const neverLaunch = async (): Promise<ChromeTab> => {
  throw new Error('Chrome must not be launched');
};

describe('burn: checks that come before Chrome', () => {
  it('refuses an output folder that does not exist', async () => {
    const dir = await tempDir('ot-burn-');
    const output = join(dir, 'missing', 'out.mp4');
    await expect(burn(await stub(dir), makeDoc(), { cwd: dir, output }, memoryLogger(), { probe: async () => VIDEO, ffmpegVersion, launch: neverLaunch }))
      .rejects.toThrow(`Output folder not found: ${join(dir, 'missing')}`);
  });

  it('refuses a document without profiles', async () => {
    const dir = await tempDir('ot-burn-');
    const media = join(dir, 'a.mp4');
    await writeFile(media, 'x');
    const doc = { ...makeDoc(), profiles: [] };
    for (const profile of [undefined, 'horizontal']) {
      await expect(burn(media, doc, { cwd: dir, ...(profile ? { profile } : {}) }, memoryLogger(), { probe: async () => VIDEO, ffmpegVersion, launch: neverLaunch }))
        .rejects.toThrow('The document has no profiles, so there are no captions to burn in.');
    }
  });

  it.skipIf(!hasAssets)('warns about captions after the end of the video', async () => {
    const dir = await tempDir('ot-burn-');
    const log = memoryLogger();
    const tab: ChromeTab = { pid: undefined, profileDir: dir, send: async () => { throw new Error('stop here'); }, close: async () => {} };
    await expect(burn(await stub(dir), makeDoc(), { cwd: dir }, log, { probe: async () => ({ ...VIDEO, duration: 0.4 }), ffmpegVersion, launch: async () => tab })).rejects.toThrow('stop here');
    expect(log.lines).toContain('warn: Captions after the end of the video (0.4 s) are left out.');
  });

  it.skipIf(!hasAssets)('an explicit --profile is used without a shape warning', async () => {
    const dir = await tempDir('ot-burn-');
    const log = memoryLogger();
    const tab: ChromeTab = { pid: undefined, profileDir: dir, send: async () => { throw new Error('stop here'); }, close: async () => {} };
    await expect(burn(await stub(dir), makeDoc(), { cwd: dir, profile: 'horizontal' }, log, { probe: async () => ({ ...VIDEO, width: 180, height: 180 }), ffmpegVersion, launch: async () => tab }))
      .rejects.toThrow('stop here');
    expect(log.lines).toContain('info: burn: 180×180, profile horizontal, style clean');
    expect(log.lines.some((l) => l.includes('no profile for'))).toBe(false);
  });

  it.skipIf(!hasAssets)('names the real document and every profile in the recut hint', async () => {
    const dir = await tempDir('ot-burn-');
    const log = memoryLogger();
    const tab: ChromeTab = { pid: undefined, profileDir: dir, send: async () => { throw new Error('stop here'); }, close: async () => {} };
    const doc: OvertoneDocument = { ...makeDoc(), profiles: [...makeDoc().profiles, { id: '4x5', aspect: '4:5', rules, cues: [] }, { id: 'vertical', aspect: '9:16', rules, cues: [] }] };
    const media = await stub(dir);
    const attempt = (documentPath: string) => burn(media, doc, { cwd: dir, documentPath }, log, { probe: async () => ({ ...VIDEO, width: 180, height: 180 }), ffmpegVersion, launch: async () => tab }).catch(() => {});
    await attempt('talks/my talk.overtone.json');
    expect(log.lines).toContain(`warn: The document has no profile for 1:1 video; using "4x5". For lines cut for this shape: overtone recut 'talks/my talk.overtone.json' --profiles horizontal,4:5,vertical,1:1 --export json --out recut/ (then burn 'recut/my talk.overtone.json')`);
  });

  it.skipIf(!hasAssets)('prints no warning when the style fails to load', async () => {
    const dir = await tempDir('ot-burn-');
    const log = memoryLogger();
    await expect(burn(await stub(dir), makeDoc(), { cwd: dir, style: 'nope' }, log, { probe: async () => ({ ...VIDEO, width: 180, height: 180, duration: 0.4 }), ffmpegVersion, launch: neverLaunch }))
      .rejects.toThrow('Unknown style "nope"');
    expect(log.lines.filter((l) => l.startsWith('warn: '))).toEqual([]);
  });

  it('refuses an ffmpeg older than 5.0 before Chrome launches, without warnings', async () => {
    const dir = await tempDir('ot-burn-');
    const log = memoryLogger();
    await expect(burn(await stub(dir), makeDoc(), { cwd: dir }, log, { probe: async () => ({ ...VIDEO, duration: 0.4 }), ffmpegVersion: async () => 'ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright', launch: neverLaunch }))
      .rejects.toThrow('Burning needs ffmpeg 5.0 or later (the installed ffmpeg cannot read the caption list); upgrade ffmpeg.');
    expect(log.lines).toEqual([]);
  });

  it.skipIf(!hasAssets)('rejects an unknown style before Chrome launches', async () => {
    const dir = await tempDir('ot-burn-');
    await expect(burn(await stub(dir), makeDoc(), { cwd: dir, style: 'nope' }, memoryLogger(), { probe: async () => VIDEO, ffmpegVersion, launch: neverLaunch }))
      .rejects.toThrow('Unknown style "nope"');
  });

  it.skipIf(!hasAssets)('rejects a missing font file before Chrome launches', async () => {
    const dir = await tempDir('ot-burn-');
    await expect(burn(await stub(dir), makeDoc(), { cwd: dir, font: 'nope.woff2' }, memoryLogger(), { probe: async () => VIDEO, ffmpegVersion, launch: neverLaunch }))
      .rejects.toThrow('Font file not found or unreadable');
  });

  it.skipIf(!hasAssets)('closes Chrome and removes the temp folder when the page fails', async () => {
    const dir = await tempDir('ot-burn-');
    const tmpRoot = await tempDir('ot-burn-tmp-');
    let closed = 0;
    const tab: ChromeTab = {
      pid: undefined,
      profileDir: dir,
      send: async () => {
        throw new Error('DevTools is gone');
      },
      close: async () => {
        closed++;
      },
    };
    await expect(burn(await stub(dir), makeDoc(), { cwd: dir }, memoryLogger(), { probe: async () => VIDEO, ffmpegVersion, launch: async () => tab, tmpRoot }))
      .rejects.toThrow('DevTools is gone');
    expect(closed).toBe(1);
    expect(burnFolders(tmpRoot)).toEqual([]);
  });
});

describe.skipIf(!hasFfmpeg)('burn: input checks', () => {
  it('refuses audio-only media', async () => {
    const dir = await tempDir('ot-burn-');
    const audio = join(dir, 'a.m4a');
    await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', audio]);
    await expect(burn(audio, makeDoc(), { cwd: dir }, memoryLogger())).rejects.toThrow('has no video stream; burning captions needs a video. For audio, export VTT or SRT instead.');
  });

  it('refuses to write onto the media file', async () => {
    const dir = await tempDir('ot-burn-');
    const media = await clip(dir);
    await expect(burn(media, makeDoc(), { cwd: dir, output: media }, memoryLogger())).rejects.toThrow('would overwrite the media file');
  });

  it('lists the profiles for an unknown --profile', async () => {
    const dir = await tempDir('ot-burn-');
    const media = await clip(dir);
    await expect(burn(media, makeDoc(), { cwd: dir, profile: 'nope' }, memoryLogger())).rejects.toThrow('Unknown profile "nope"; the document has: horizontal.');
  });
});

describe('burn: the command', () => {
  it('rejects an invalid document with an error naming the file', async () => {
    const dir = await tempDir('ot-burn-');
    await writeFile(join(dir, 'bad.overtone.json'), JSON.stringify({ format: 'overtone' }));
    const log = memoryLogger();
    await buildProgram(log, { cwd: dir }).parseAsync(['node', 'overtone', 'burn', join(dir, 'a.mp4'), 'bad.overtone.json']);
    expect(process.exitCode).toBe(1);
    expect(log.lines.find((l) => l.startsWith('error: '))).toMatch(/^error: bad\.overtone\.json is not a valid Overtone document:\n/);
  });

  it('reports media that is missing, a folder, or not a media file as plain errors', async () => {
    const dir = await tempDir('ot-burn-');
    await writeFile(join(dir, 'doc.overtone.json'), JSON.stringify(makeDoc()));
    await mkdir(join(dir, 'folder'));
    const cases: Array<[string, string | RegExp]> = [
      ['missing.mp4', `error: Media file not found: ${join(dir, 'missing.mp4')}`],
      ['folder', `error: Media file is a directory: ${join(dir, 'folder')}`],
    ];
    if (hasFfmpeg) cases.push(['doc.overtone.json', /^error: Cannot read .*doc\.overtone\.json: not an audio\/video file \(Invalid data found when processing input\)$/]);
    for (const [media, expected] of cases) {
      const log = memoryLogger();
      await buildProgram(log, { cwd: dir }).parseAsync(['node', 'overtone', 'burn', media, 'doc.overtone.json']);
      expect(process.exitCode).toBe(1);
      const errors = log.lines.filter((l) => l.startsWith('error: '));
      expect(errors).toHaveLength(1);
      if (typeof expected === 'string') expect(errors[0]).toBe(expected);
      else expect(errors[0]).toMatch(expected);
      expect(errors[0]).not.toContain('\n    at ');
    }
  });

  it('checks the media before the output, and the output name: a folder, or a name ending in .mp4', async () => {
    const dir = await tempDir('ot-burn-');
    const media = join(dir, 'a.mp4');
    await writeFile(media, 'not probed: the output checks come first');
    const log = memoryLogger();
    // a mistyped media folder names the media, not the output folder next to it
    await expect(burn(join(dir, 'typo', 'a.mp4'), makeDoc(), { cwd: dir }, log)).rejects.toThrow(new UserError(`Media file not found: ${join(dir, 'typo', 'a.mp4')}`));
    // "renders/" is a folder even before it exists: the MP4 is not written as a file named "renders"
    await expect(burn(media, makeDoc(), { cwd: dir, output: 'renders/' }, log)).rejects.toThrow(new UserError(`Output folder not found: ${join(dir, 'renders')}`));
    await expect(burn(media, makeDoc(), { cwd: dir, output: 'out.webm' }, log))
      .rejects.toThrow(new UserError(`${join(dir, 'out.webm')}: burn writes an MP4 file; give --out a name that ends in .mp4 (or .m4v, .mov), or a folder.`));
  });

  it('rejects an unknown --mode and --speaker-names', async () => {
    const dir = await tempDir('ot-burn-');
    await writeFile(join(dir, 'doc.overtone.json'), JSON.stringify(makeDoc()));
    for (const [flag, value] of [['--mode', 'loud'], ['--speaker-names', 'sometimes']]) {
      const log = memoryLogger();
      await buildProgram(log, { cwd: dir }).parseAsync(['node', 'overtone', 'burn', join(dir, 'a.mp4'), 'doc.overtone.json', flag, value]);
      expect(process.exitCode).toBe(1);
      expect(log.lines).toContain(`error: Invalid ${flag} "${value}"; expected one of: ${flag === '--mode' ? 'styled, plain' : 'never, change, always'}.`);
    }
  });

  it('takes the output as --out <folder> or -o <file>, and rejects --output', async () => {
    const dir = await tempDir('ot-burn-');
    const media = join(dir, 'a.mp4');
    await writeFile(media, 'not probed: the output checks come first');
    await writeFile(join(dir, 'doc.overtone.json'), JSON.stringify(makeDoc()));
    const errorFor = async (...args: string[]) => {
      const log = memoryLogger();
      await buildProgram(log, { cwd: dir }).parseAsync(['node', 'overtone', 'burn', 'a.mp4', 'doc.overtone.json', ...args]);
      expect(process.exitCode).toBe(1);
      return log.lines;
    };
    // a folder gets the default name inside it
    expect(await errorFor('--out', 'renders/')).toEqual([`error: Output folder not found: ${join(dir, 'renders')}`]);
    expect(await errorFor('-o', 'a.mp4')).toEqual([`error: ${media} would overwrite the media file; choose another path with --out.`]);
    expect(await errorFor('-o', 'out.webm')).toEqual([`error: ${join(dir, 'out.webm')}: burn writes an MP4 file; give --out a name that ends in .mp4 (or .m4v, .mov), or a folder.`]);

    const program = buildProgram(memoryLogger(), { cwd: dir });
    program.commands.find((c) => c.name() === 'burn')!.exitOverride().configureOutput({ writeErr: () => {} });
    await expect(program.parseAsync(['node', 'overtone', 'burn', 'a.mp4', 'doc.overtone.json', '--output', 'x.mp4']))
      .rejects.toMatchObject({ code: 'commander.unknownOption' });
  });
});

// Headless Chrome can take over 20 s to start on a shared CI runner (2 s locally): more time than the default.
describe.skipIf(!ready)('burn: end to end', { timeout: 90_000 }, () => {
  it('burns the captions in and keeps everything else', async () => {
    const dir = await tempDir('ot-burn-');
    const media = await clip(dir);
    const log = memoryLogger();
    const tmpRoot = await tempDir('ot-burn-tmp-');
    const output = await burn(media, makeDoc(), { cwd: dir, style: 'social' }, log, { tmpRoot });
    expect(output).toBe(join(dir, 'clip-320x180.captioned.mp4'));
    expect(burnFolders(tmpRoot)).toEqual([]);
    expect(diff(media, output, 0.2)).toBeLessThan(4);
    expect(diff(media, output, 1.2)).toBeGreaterThan(8);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', output]).stdout.toString();
    const json = JSON.parse(probe);
    expect(json.streams.map((s: { codec_type: string }) => s.codec_type)).toEqual(['video', 'audio']);
    expect(Number(json.format.duration)).toBeCloseTo(2, 1);
  });

  it('warns when no profile fits the video shape', async () => {
    const dir = await tempDir('ot-burn-');
    const media = await clip(dir, '180x180');
    const log = memoryLogger();
    await burn(media, makeDoc(), { cwd: dir }, log);
    expect(log.lines).toContain('warn: The document has no profile for 1:1 video; using "horizontal". For lines cut for this shape: overtone recut <document> --profiles horizontal,1:1 --export json --out recut/ (then burn recut/<document>)');
  });

  it('removes the temp folder when encoding fails', async () => {
    const dir = await tempDir('ot-burn-');
    const notVideo = join(dir, 'not-a-video.mp4');
    await writeFile(notVideo, 'this is not a video');
    const tmpRoot = await tempDir('ot-burn-tmp-');
    await expect(burn(notVideo, makeDoc(), { cwd: dir }, memoryLogger(), { probe: async () => VIDEO, ffmpegVersion, tmpRoot })).rejects.toThrow();
    expect(burnFolders(tmpRoot)).toEqual([]);
    expect(existsSync(join(dir, 'not-a-video.captioned.mp4'))).toBe(false);
  });

  it('writes into an existing folder given as the output', async () => {
    const dir = await tempDir('ot-burn-');
    const media = await clip(dir);
    await mkdir(join(dir, 'out'));
    const output = await burn(media, makeDoc(), { cwd: dir, output: 'out' }, memoryLogger());
    expect(output).toBe(join(dir, 'out', 'clip-320x180.captioned.mp4'));
    expect(existsSync(output)).toBe(true);
  });

  it('resolves the media, output, style and font against cwd', async () => {
    const dir = await tempDir('ot-burn-');
    const media = await clip(dir);
    await mkdir(join(dir, 'result'));
    const social = await readFile(join(burnAssetsDir(), 'themes', 'social.css'), 'utf8');
    await writeFile(join(dir, 'mine.css'), social.replaceAll('ot-theme-social', 'ot-theme-mine'));
    const font = fileURLToPath(new URL('../../../node_modules/video.js/dist/font/VideoJS.woff', import.meta.url));
    const withFont = existsSync(font);
    if (withFont) await copyFile(font, join(dir, 'face.woff'));
    const log = memoryLogger();
    const output = await burn('clip-320x180.mp4', makeDoc(), { cwd: dir, output: 'result/x.mp4', style: 'mine.css', ...(withFont ? { font: 'face.woff' } : {}) }, log);
    expect(output).toBe(join(dir, 'result', 'x.mp4'));
    expect(log.lines).toContain('info: burn: 320×180, profile horizontal, style mine');
    expect(diff(media, output, 1.2)).toBeGreaterThan(8);
  });

  it('runs as a command', async () => {
    const dir = await tempDir('ot-burn-');
    const media = await clip(dir);
    const docPath = join(dir, 'clip.overtone.json');
    await writeFile(docPath, JSON.stringify(makeDoc()));
    const log = memoryLogger();
    await buildProgram(log, { cwd: dir }).parseAsync(['node', 'overtone', 'burn', media, docPath, '-o', join(dir, 'out.mp4')]);
    expect(process.exitCode).toBe(0);
    expect(log.lines).toContain(`out: ${join(dir, 'out.mp4')}`);

    await mkdir(join(dir, 'renders'));
    const inFolder = memoryLogger();
    await buildProgram(inFolder, { cwd: dir }).parseAsync(['node', 'overtone', 'burn', media, docPath, '--out', 'renders']);
    expect(process.exitCode).toBe(0);
    expect(inFolder.lines).toContain(`out: ${join(dir, 'renders', 'clip-320x180.captioned.mp4')}`);
  });
});

describe('burn --profile takes an aspect written either way', () => {
  it.skipIf(!hasAssets)('"1:1" and "1x1" both pick the profile 1x1', async () => {
    for (const name of ['1:1', '1x1']) {
      const dir = await tempDir('ot-burn-');
      const log = memoryLogger();
      const tab: ChromeTab = { pid: undefined, profileDir: dir, send: async () => { throw new Error('stop here'); }, close: async () => {} };
      const doc: OvertoneDocument = { ...makeDoc(), profiles: [...makeDoc().profiles, { ...makeDoc().profiles[0]!, id: '1x1', aspect: '1:1' }] };
      await expect(burn(await stub(dir), doc, { cwd: dir, profile: name }, log, { probe: async () => VIDEO, ffmpegVersion, launch: async () => tab })).rejects.toThrow('stop here');
      expect(log.lines).toContain(`info: burn: ${VIDEO.width}×${VIDEO.height}, profile 1x1, style clean`);
    }
  });
});
