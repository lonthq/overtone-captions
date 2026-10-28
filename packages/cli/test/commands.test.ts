import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, posix, resolve, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from './tmp.js';
import { runExport } from '../src/commands/export.js';
import { runValidate } from '../src/commands/validate.js';
import { memoryLogger } from '../src/log.js';
import { UserError } from '../src/errors.js';
import { validate, type OvertoneDocument } from 'overtone-format';
import { baseName, isInsideFolder, markUncertain, uncertainWords, writeOutputs } from '../src/output.js';
import { buildProgram } from '../src/program.js';

const SAMPLE = resolve(import.meta.dirname, '../../../examples/fixtures/sample.overtone.json');

afterEach(() => {
  process.exitCode = 0;
});

describe('isInsideFolder', () => {
  it('works for a normal folder', () => {
    expect(isInsideFolder('/out', '/out/a.vtt', posix)).toBe(true);
    expect(isInsideFolder('/out', '/out/sub/a.vtt', posix)).toBe(true);
    expect(isInsideFolder('/out', '/out/../a.vtt', posix)).toBe(false);
    expect(isInsideFolder('/out', '/outer/a.vtt', posix)).toBe(false);
    expect(isInsideFolder('/out', '/out/..a.vtt', posix)).toBe(true);
  });

  it('works when the output folder is the filesystem root', () => {
    expect(isInsideFolder('/', '/a.vtt', posix)).toBe(true);
    expect(isInsideFolder('/', '/sub/a.vtt', posix)).toBe(true);
    expect(isInsideFolder('/', '/../a.vtt', posix)).toBe(true); // ".." at the root stays at the root
  });

  it('works for a Windows drive root', () => {
    expect(isInsideFolder('C:\\', 'C:\\a.vtt', win32)).toBe(true);
    expect(isInsideFolder('C:\\', 'C:\\sub\\a.vtt', win32)).toBe(true);
    expect(isInsideFolder('C:\\out', 'D:\\a.vtt', win32)).toBe(false);
    expect(isInsideFolder('C:\\out', 'C:\\out\\..\\a.vtt', win32)).toBe(false);
  });

  it('does not accept the folder itself as a file path', () => {
    expect(isInsideFolder('/out', '/out', posix)).toBe(false);
    expect(isInsideFolder('/', '/', posix)).toBe(false);
    expect(isInsideFolder('/out', '/out/.', posix)).toBe(false);
  });
});

describe('baseName', () => {
  it.each([['/x/talk.overtone.json', 'talk'], ['clip.mp4', 'clip'], ['a.b.mov', 'a.b'], ['noext', 'noext']])('%s → %s', (p, b) => {
    expect(baseName(p)).toBe(b);
  });
});

describe('validate', () => {
  it('accepts the sample fixture', async () => {
    const log = memoryLogger();
    expect(await runValidate(SAMPLE, log)).toBe(0);
    expect(log.lines[0]).toMatch(/sample\.overtone\.json: valid \(\d+ words, \d+ turns, cues: (horizontal|vertical) \d+, (horizontal|vertical) \d+\)$/);
  });

  it('lists issues for an invalid document', async () => {
    const dir = await tempDir('overtone-validate-');
    const file = join(dir, 'bad.overtone.json');
    await writeFile(file, JSON.stringify({ format: 'overtone', version: 2 }));
    const log = memoryLogger();
    expect(await runValidate(file, log)).toBe(1);
    expect(log.lines[0]).toMatch(/bad\.overtone\.json: invalid \(\d+ issues?\)/);
    expect(log.lines.length).toBeGreaterThan(1);
  });

  it('resolves a relative path against the given cwd', async () => {
    const dir = await tempDir('overtone-validate-');
    await copyFile(SAMPLE, join(dir, 'here.overtone.json'));
    const log = memoryLogger();
    expect(await runValidate('here.overtone.json', log, dir)).toBe(0);
    expect(log.lines[0]).toMatch(/^out: here\.overtone\.json: valid/);
  });

  it('tells a directory and a missing file apart', async () => {
    const dir = await tempDir('overtone-validate-');
    const log = memoryLogger();
    expect(await runValidate(dir, log)).toBe(1);
    expect(log.lines[0]).toBe(`error: ${dir}: is a directory`);
    if (process.getuid?.() !== 0) {
      const locked = join(dir, 'locked.json');
      await writeFile(locked, '{}');
      await chmod(locked, 0o000);
      expect(await runValidate(locked, log)).toBe(1);
      expect(log.lines[1]).toBe(`error: ${locked}: permission denied`);
    }
  });

  it('reports unreadable JSON', async () => {
    const dir = await tempDir('overtone-validate-');
    const file = join(dir, 'broken.json');
    await writeFile(file, '{');
    const log = memoryLogger();
    expect(await runValidate(file, log)).toBe(1);
    expect(log.lines[0]).toMatch(/^error: .*broken\.json: not valid JSON/);
    expect(await runValidate(join(dir, 'missing.json'), log)).toBe(1);
    expect(log.lines[1]).toMatch(/missing\.json: file not found/);
  });
});

describe('export', () => {
  it('writes per-profile VTT/SRT, a transcript and JSON', async () => {
    const out = await tempDir('overtone-export-');
    const log = memoryLogger();
    expect(await runExport(SAMPLE, { export: 'json,vtt,srt,txt', out }, log)).toBe(0);
    expect([...log.lines].sort()).toEqual(
      ['sample.horizontal.srt', 'sample.horizontal.vtt', 'sample.overtone.json', 'sample.txt', 'sample.vertical.srt', 'sample.vertical.vtt'].map((f) => `out: ${join(out, f)}`),
    );
    expect(log.lines[0]).toBe(`out: ${join(out, 'sample.overtone.json')}`);
    expect(log.lines.at(-1)).toBe(`out: ${join(out, 'sample.txt')}`);
    expect(await readFile(join(out, 'sample.horizontal.vtt'), 'utf8')).toMatch(/^WEBVTT/);
    expect(JSON.parse(await readFile(join(out, 'sample.overtone.json'), 'utf8'))).toEqual(JSON.parse(await readFile(SAMPLE, 'utf8')));
  });

  it('writes the player document (no authoring data, chosen profiles) and VTT with word timestamps', async () => {
    const out = await tempDir('overtone-export-');
    const log = memoryLogger();
    expect(await runExport(SAMPLE, { export: 'player,vtt-words', profiles: 'vertical', out }, log)).toBe(0);
    expect(log.lines).toEqual(['sample.player.overtone.json', 'sample.vertical.words.vtt'].map((f) => `out: ${join(out, f)}`));
    const player = JSON.parse(await readFile(join(out, 'sample.player.overtone.json'), 'utf8'));
    expect(validate(player).valid).toBe(true);
    expect(player.meta).toBeUndefined();
    expect(player.profiles.map((p: { id: string }) => p.id)).toEqual(['vertical']);
    expect(player.turns.flatMap((t: { words: object[] }) => t.words).every((w: object) => !('match' in w) && !('confidence' in w))).toBe(true);
    expect(await readFile(join(out, 'sample.vertical.words.vtt'), 'utf8')).toMatch(/<\d\d:\d\d:\d\d\.\d{3}>/);
  });

  it('limits VTT/SRT to the requested profiles', async () => {
    const out = await tempDir('overtone-export-');
    const log = memoryLogger();
    await runExport(SAMPLE, { export: 'vtt', profiles: 'vertical', out }, log);
    expect(log.lines).toEqual([`out: ${join(out, 'sample.vertical.vtt')}`]);
  });

  it('rejects unknown profiles and formats', async () => {
    const out = await tempDir('overtone-export-');
    await expect(runExport(SAMPLE, { export: 'vtt', profiles: 'square', out }, memoryLogger())).rejects.toThrow(/Profile "square" is not in the document/);
    await expect(runExport(SAMPLE, { export: 'docx', out }, memoryLogger())).rejects.toThrow(/Invalid export format "docx"/);
  });
});

describe('export with mp4', () => {
  it('needs the media file, so it points to burn and writes nothing', async () => {
    const out = await tempDir('overtone-export-mp4-');
    for (const value of ['mp4', 'vtt,mp4']) {
      await expect(runExport(SAMPLE, { export: value, out }, memoryLogger())).rejects.toThrow(
        new UserError('mp4 needs the media file; use "overtone burn <media> <document>".'),
      );
    }
    expect(await readdir(out)).toEqual([]);
  });
});

describe('export safety', () => {
  const sampleDoc = async () => JSON.parse(await readFile(SAMPLE, 'utf8'));

  it('never overwrites its own input with the json output', async () => {
    const dir = await tempDir('overtone-export-');
    const input = join(dir, 'talk.overtone.json');
    await copyFile(SAMPLE, input);
    const before = await readFile(input, 'utf8');
    const log = memoryLogger();
    expect(await runExport(input, { export: 'json,txt' }, log)).toBe(0);
    expect(log.lines[0]).toMatch(/^warn: Not overwriting the input file .*talk\.overtone\.json/);
    expect(log.lines.slice(1)).toEqual([`out: ${join(dir, 'talk.txt')}`]);
    expect(await readFile(input, 'utf8')).toBe(before);
  });

  it('writes the json when the output folder differs from the input folder', async () => {
    const dir = await tempDir('overtone-export-');
    const input = join(dir, 'talk.overtone.json');
    await copyFile(SAMPLE, input);
    const log = memoryLogger();
    await runExport(input, { export: 'json', out: join(dir, 'out') }, log);
    expect(log.lines).toEqual([`out: ${join(dir, 'out', 'talk.overtone.json')}`]);
  });

  it('refuses output paths that leave the output folder', async () => {
    const doc = await sampleDoc();
    doc.profiles[0].id = '/../../evil';
    const out = await tempDir('overtone-export-');
    await expect(writeOutputs(doc, { base: 'x', outDir: join(out, 'sub'), formats: ['vtt'] })).rejects.toThrow(/Refusing to write outside the output folder/);
    await expect(writeOutputs(doc, { base: 'x', outDir: join(out, 'sub'), formats: ['vtt'] })).rejects.toBeInstanceOf(UserError);
    await expect(writeOutputs(doc, { base: '../x', outDir: join(out, 'sub'), formats: ['txt'] })).rejects.toThrow(/Refusing to write outside/);
    // nothing was created, not even the folder
    await expect(readFile(join(out, 'evil.vtt'), 'utf8')).rejects.toThrow();
    await expect(mkdir(join(out, 'sub'))).resolves.toBeUndefined();
  });

  it('turns filesystem failures into one-line user errors', async () => {
    const dir = await tempDir('overtone-export-');
    const file = join(dir, 'a-file');
    await writeFile(file, 'x');
    const err = await runExport(SAMPLE, { export: 'txt', out: file }, memoryLogger()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toMatch(/^Cannot create output folder .*a-file \(EEXIST\)$/);
    const nested = await runExport(SAMPLE, { export: 'txt', out: join(file, 'sub') }, memoryLogger()).catch((e: unknown) => e);
    expect((nested as Error).message).toMatch(/^Cannot create output folder .* \(ENOTDIR\)$/);
    const log = memoryLogger();
    await buildProgram(log).parseAsync(['export', SAMPLE, '--export', 'txt', '--out', file], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toMatch(/^error: Cannot create output folder .* \(EEXIST\)$/);
  });

  it('reports an unwritable target file', async () => {
    if (process.getuid?.() === 0) return;
    const dir = await tempDir('overtone-export-');
    await writeFile(join(dir, 'sample.txt'), 'old');
    await chmod(join(dir, 'sample.txt'), 0o444);
    await expect(runExport(SAMPLE, { export: 'txt', out: dir }, memoryLogger())).rejects.toThrow(/^Cannot write .*sample\.txt \(EACCES\)$/);
  });

  it('cleans up and checks the format and profile lists', async () => {
    const out = await tempDir('overtone-export-');
    const log = memoryLogger();
    await runExport(SAMPLE, { export: ' vtt, vtt ,', profiles: ' vertical ,', out }, log);
    expect(log.lines).toEqual([`out: ${join(out, 'sample.vertical.vtt')}`]);
    await expect(runExport(SAMPLE, { export: 'vtt', profiles: 'vertical, vertical', out }, memoryLogger())).rejects.toThrow(/Profile "vertical" is listed twice/);
    await expect(runExport(SAMPLE, { export: ' , ', out }, memoryLogger())).rejects.toThrow(/No export formats given/);
    await expect(runExport(SAMPLE, { export: 'vtt', profiles: '', out }, memoryLogger())).rejects.toThrow(/No profiles given/);
  });
});

describe('program', () => {
  it('runs validate through commander and sets the exit code', async () => {
    const log = memoryLogger();
    await buildProgram(log).parseAsync(['validate', SAMPLE], { from: 'user' });
    expect(process.exitCode).toBe(0);
    expect(log.lines[0]).toMatch(/valid/);
  });

  it('prints user errors without a stack and exits with 1', async () => {
    const log = memoryLogger();
    await buildProgram(log).parseAsync(['export', SAMPLE, '--export', 'docx'], { from: 'user' });
    expect(process.exitCode).toBe(1);
    expect(log.lines).toEqual(['error: Invalid export format "docx"; expected one of: json, player, vtt, vtt-words, srt, txt.']);
  });

  it('takes -o as the short form of --out on every command that writes files', async () => {
    const commands = buildProgram(memoryLogger()).commands;
    for (const name of ['transcribe', 'recut', 'export', 'burn']) {
      const out = commands.find((c) => c.name() === name)!.options.find((o) => o.long === '--out');
      expect(out?.short, name).toBe('-o');
    }
    const dir = await tempDir('overtone-prog-');
    for (const name of ['export', 'recut']) {
      const log = memoryLogger();
      await buildProgram(log).parseAsync([name, SAMPLE, '--export', 'txt', '-o', join(dir, name)], { from: 'user' });
      expect(process.exitCode, log.lines.join('\n')).toBe(0);
      expect(log.lines.filter((l) => l.startsWith('out: '))).toEqual([`out: ${join(dir, name, 'sample.txt')}`]);
    }
  });
});

describe('program cwd', () => {
  it('resolves validate and transcribe paths against opts.cwd and prints one error line', async () => {
    const dir = await tempDir('overtone-prog-');
    try {
      await copyFile(SAMPLE, join(dir, 'here.overtone.json'));
      const log = memoryLogger();
      await buildProgram(log, { cwd: dir }).parseAsync(['validate', 'here.overtone.json'], { from: 'user' });
      expect(process.exitCode).toBe(0);
      expect(log.lines[0]).toMatch(/^out: here\.overtone\.json: valid/);

      const err = memoryLogger();
      await buildProgram(err, { cwd: dir }).parseAsync(['transcribe', 'missing.mp4'], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(err.lines).toEqual([`error: Media file not found: ${join(dir, 'missing.mp4')}`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('--mark-uncertain', () => {
  /** The sample with: "kind of car" heard as something else, "damage." interpolated, "remember:" a punctuation edit on a disputed word, "DriveCover" a confirmed correction. */
  const disputed = async (): Promise<OvertoneDocument> => {
    const doc = JSON.parse(await readFile(SAMPLE, 'utf8')) as OvertoneDocument;
    const flat = doc.turns.flatMap((t) => t.words);
    for (const i of [8, 9, 10]) Object.assign(flat[i], { match: 'fuzzy', confidence: 0.3 });
    Object.assign(flat[11], { match: 'interpolated', confidence: 0 });
    Object.assign(flat[38], { match: 'edited', confidence: 0.25 });
    Object.assign(flat[39], { match: 'edited', confidence: 1 });
    Object.assign(flat[2], { match: 'fuzzy', confidence: 0.5 });
    // a punctuation edit on an interpolated word ("Drive" had no timing): confidence 0, not a disagreement
    Object.assign(flat[40], { match: 'edited', confidence: 0 });
    doc.edits = [
      ...(doc.edits ?? []),
      { words: [38, 38], from: 'remember', to: 'remember:', reason: 'punctuation' },
      { words: [39, 39], from: 'Dr Cover.', to: 'DriveCover.', reason: 'correction' },
      { words: [40, 40], from: 'drive', to: 'Drive', reason: 'punctuation' },
    ];
    return doc;
  };

  it('finds words the two sides disagree on that no edit changed', async () => {
    const marked = uncertainWords(await disputed()).flatMap((u, i) => (u ? [i] : []));
    expect(marked).toEqual([8, 9, 10, 38]);
  });

  it('marks each run once, before its closing punctuation, and per caption line', async () => {
    const doc = await disputed();
    const text = (d: OvertoneDocument) => d.turns.flatMap((t) => t.words.map((w) => w.text));
    expect(text(markUncertain(doc)).slice(7, 12)).toEqual(['some', 'kind', 'of', 'car (??)', 'damage.']);
    expect(text(markUncertain(doc))[38]).toBe('remember (??):');
    // vertical cuts after "kind": each line shows its own mark
    expect(text(markUncertain(doc, 'vertical')).slice(7, 11)).toEqual(['some', 'kind (??)', 'of', 'car (??)']);
    // the document itself is not changed
    expect(text(doc)[10]).toBe('car');
  });

  it('renders the marks in VTT, SRT and TXT, never in the JSON', async () => {
    const dir = await tempDir('overtone-uncertain-');
    const input = join(dir, 'talk.overtone.json');
    const doc = await disputed();
    await writeFile(input, JSON.stringify(doc));
    const out = join(dir, 'out');
    expect(await runExport(input, { export: 'json,vtt,srt,txt', out, markUncertain: true }, memoryLogger())).toBe(0);
    expect(await readFile(join(out, 'talk.txt'), 'utf8')).toContain('some kind of car (??) damage.');
    expect(await readFile(join(out, 'talk.horizontal.srt'), 'utf8')).toContain('has some kind of car (??) damage.');
    expect(await readFile(join(out, 'talk.vertical.vtt'), 'utf8')).toMatch(/kind \(\?\?\)/);
    expect(JSON.parse(await readFile(join(out, 'talk.overtone.json'), 'utf8'))).toEqual(doc);
    // off by default
    const plain = join(dir, 'plain');
    await runExport(input, { export: 'txt', out: plain }, memoryLogger());
    expect(await readFile(join(plain, 'talk.txt'), 'utf8')).not.toContain('(??)');
  });

  it('is an option of transcribe and export', () => {
    const program = buildProgram(memoryLogger());
    for (const name of ['transcribe', 'export']) {
      expect(program.commands.find((c) => c.name() === name)?.options.map((o) => o.long)).toContain('--mark-uncertain');
    }
  });
});
