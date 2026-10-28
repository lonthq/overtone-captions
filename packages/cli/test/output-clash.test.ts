import { existsSync } from 'node:fs';
import { link, readFile, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runExport } from '../src/commands/export.js';
import { runRecut } from '../src/commands/recut.js';
import { resolveConfig, type CliFlags } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { memoryLogger } from '../src/log.js';
import type { ExtractResult } from '../src/media/extract.js';
import { assertNoInputOverwrite, plannedOutputs, samePath, writeOutputs } from '../src/output.js';
import { runPipeline } from '../src/pipeline.js';
import type { Providers } from '../src/providers/registry.js';
import { tempDir } from './tmp.js';

const fail = (role: string) => async (): Promise<never> => { throw new Error(`the ${role} provider must not be called`); };

/** Providers that fail when called, and an extract stage that records being run: the check must come first. */
function untouchable(calls: string[]): { providers: Providers; extractAudio: () => Promise<ExtractResult> } {
  return {
    providers: { text: { id: 'fake:text', transcribe: fail('text') }, timing: { id: 'fake:timing', align: fail('timing') }, llm: { id: 'fake:llm', complete: fail('llm') } },
    extractAudio: async () => { calls.push('extract'); throw new Error('extract must not run'); },
  };
}

async function attempt(textName: string, flags: CliFlags) {
  const dir = await tempDir('overtone-clash-');
  const media = join(dir, 'talk.mp4');
  await writeFile(media, 'not really media'); // created by the test, never committed
  const text = join(dir, textName);
  const original = '1\n00:00:00,000 --> 00:00:01,000\nMy own transcript.\n';
  await writeFile(text, original);
  const cfg = await resolveConfig({ textFile: textName, timing: 'azure-speech', ...flags }, {}, { cwd: dir, configDir: dir });
  const calls: string[] = [];
  const fakes = untouchable(calls);
  const error = await runPipeline(media, cfg, { log: memoryLogger(), cwd: dir, ...fakes, checkBinaries: async () => [], probeDuration: async () => 10, probeVideo: async () => undefined })
    .catch((err: unknown) => err);
  return { error, text, original, calls, dir };
}

describe('outputs never overwrite the inputs', () => {
  it('--text-file talk.txt --export txt is refused before any work, and the transcript is untouched', async () => {
    const { error, text, original, calls } = await attempt('talk.txt', { export: 'json,txt' });
    expect(error).toBeInstanceOf(UserError);
    expect((error as Error).message).toBe(`Refusing to overwrite the --text-file ${text}: the txt export writes to the same path. Write the outputs to another folder with --out, or rename the --text-file.`);
    expect(calls).toEqual([]);
    expect(await readFile(text, 'utf8')).toBe(original);
  });

  it('refuses a .vtt/.srt text file that a caption export would overwrite', async () => {
    const srt = await attempt('talk.horizontal.srt', { export: 'srt', profiles: 'horizontal' });
    expect((srt.error as Error).message).toMatch(/^Refusing to overwrite the --text-file \S+talk\.horizontal\.srt: the srt export writes to the same path\./);
    expect(await readFile(srt.text, 'utf8')).toBe(srt.original);
    const vtt = await attempt('talk.horizontal.vtt', { export: 'vtt', profiles: 'horizontal' });
    expect((vtt.error as Error).message).toMatch(/the vtt export writes to the same path/);
    expect(vtt.calls).toEqual([]);
  });

  it('allows the same names in another output folder', async () => {
    const { error, calls } = await attempt('talk.txt', { export: 'txt', out: 'captions' });
    // past the check: the (fake) extract stage runs and fails on purpose
    expect(calls).toEqual(['extract']);
    expect((error as Error).message).toMatch(/extract must not run/);
  });

  it('plans the mp4 and refuses the media file itself; writeOutputs writes nothing on a clash', async () => {
    const outputs = plannedOutputs({ base: 'a', outDir: '/o', formats: ['json', 'vtt', 'srt', 'txt', 'mp4'], profiles: ['default'] });
    expect(outputs).toEqual([
      { path: '/o/a.overtone.json', format: 'json' }, { path: '/o/a.default.vtt', format: 'vtt' }, { path: '/o/a.default.srt', format: 'srt' },
      { path: '/o/a.txt', format: 'txt' }, { path: '/o/a.captioned.mp4', format: 'mp4' },
    ]);
    expect(() => assertNoInputOverwrite(outputs, [{ path: '/o/a.txt', what: 'the media file' }])).toThrow(/^Refusing to overwrite the media file \/o\/a\.txt: the txt export/);

    const dir = await tempDir('overtone-clash-');
    const input = join(dir, 'a.txt');
    await writeFile(input, 'keep me');
    const doc = { format: 'overtone', version: '1.0', language: 'en', duration: 1, speakers: [], turns: [], profiles: [] } as never;
    await expect(writeOutputs(doc, { base: 'a', outDir: dir, formats: ['json', 'txt'], protect: [{ path: input, what: 'the --text-file' }] })).rejects.toThrow(UserError);
    expect(await readFile(input, 'utf8')).toBe('keep me');
    await expect(readFile(join(dir, 'a.overtone.json'))).rejects.toThrow();
  });
});

describe('re-exports never overwrite their input', () => {
  const SAMPLE = resolve(import.meta.dirname, '../../../examples/fixtures/sample.overtone.json');

  it('recut of subtitles saved as .txt refuses the txt export over the input, writing nothing', async () => {
    const dir = await tempDir('overtone-clash-');
    const input = join(dir, 'talk.txt');
    const original = '1\n00:00:00,000 --> 00:00:02,000\nHello there.\n';
    await writeFile(input, original);
    await expect(runRecut('talk.txt', { language: 'en', export: 'json,txt' }, memoryLogger(), dir))
      .rejects.toThrow(`Refusing to overwrite the input file ${input}: the txt export writes to the same path.`);
    expect(await readFile(input, 'utf8')).toBe(original);
    await expect(readFile(join(dir, 'talk.overtone.json'))).rejects.toThrow();
  });

  it('export of a document saved as .txt refuses the txt export over the input', async () => {
    const dir = await tempDir('overtone-clash-');
    const input = join(dir, 'doc.txt');
    const original = await readFile(SAMPLE, 'utf8');
    await writeFile(input, original);
    await expect(runExport('doc.txt', { export: 'vtt,txt' }, memoryLogger(), dir)).rejects.toThrow(/^Refusing to overwrite the input file \S+doc\.txt: the txt export/);
    expect(await readFile(input, 'utf8')).toBe(original);
  });

  it('transcribe refuses an export over the context or glossary file before any work', async () => {
    for (const [flags, what] of [[{ contextFile: 'talk.txt' }, 'the context file'], [{ glossary: 'talk.txt' }, 'the glossary file']] as const) {
      const dir = await tempDir('overtone-clash-');
      const media = join(dir, 'talk.mp4');
      await writeFile(media, 'not really media'); // created by the test, never committed
      await writeFile(join(dir, 'talk.txt'), 'Lumora\n');
      const cfg = await resolveConfig({ ...flags, timing: 'azure-speech', export: 'txt' }, {}, { cwd: dir, configDir: dir });
      const calls: string[] = [];
      const error = await runPipeline(media, cfg, { log: memoryLogger(), cwd: dir, ...untouchable(calls), checkBinaries: async () => [], probeDuration: async () => 10, probeVideo: async () => undefined })
        .catch((err: unknown) => err);
      expect((error as Error).message).toMatch(new RegExp(`^Refusing to overwrite ${what} \\S+talk\\.txt: the txt export`));
      expect(calls).toEqual([]);
      expect(await readFile(join(dir, 'talk.txt'), 'utf8')).toBe('Lumora\n');
    }
  });
});

describe('samePath', () => {
  it('knows a file by its identity: symlink, hard link, and letter case where the filesystem ignores it', async () => {
    const dir = await tempDir('overtone-same-');
    const clip = join(dir, 'clip.mp4');
    await writeFile(clip, 'not really media'); // created by the test, never committed
    await symlink(clip, join(dir, 'via-link.mp4'));
    await link(clip, join(dir, 'hard.mp4'));
    await writeFile(join(dir, 'other.mp4'), 'another file');
    expect(samePath(join(dir, 'via-link.mp4'), clip)).toBe(true);
    expect(samePath(join(dir, 'hard.mp4'), clip)).toBe(true);
    expect(samePath(join(dir, 'other.mp4'), clip)).toBe(false);
    expect(samePath(join(dir, 'new.mp4'), clip)).toBe(false);
    // On APFS and NTFS (the macOS and Windows defaults) CLIP.mp4 is clip.mp4; on a case-sensitive one it is a new file.
    expect(samePath(join(dir, 'CLIP.mp4'), clip)).toBe(existsSync(join(dir, 'CLIP.mp4')));
  });

  it('the overwrite check refuses an output that is an input in another letter case', async () => {
    const dir = await tempDir('overtone-same-');
    const clip = join(dir, 'clip.mp4');
    await writeFile(clip, 'not really media');
    if (!existsSync(join(dir, 'CLIP.mp4'))) return; // case-sensitive filesystem: CLIP.mp4 is another file
    const outputs = plannedOutputs({ base: 'CLIP', outDir: dir, formats: ['txt'], profiles: ['default'] });
    expect(() => assertNoInputOverwrite([{ ...outputs[0]!, path: join(dir, 'CLIP.mp4') }], [{ path: clip, what: 'the media file' }]))
      .toThrow(/^Refusing to overwrite the media file/);
  });
});
