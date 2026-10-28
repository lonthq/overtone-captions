import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertValid, flattenWords } from 'overtone-format';
import { afterEach, describe, expect, it } from 'vitest';
import { runTranscribe } from '../src/commands/transcribe.js';
import { memoryLogger } from '../src/log.js';
import { run } from '../src/media/extract.js';
import { baseName } from '../src/output.js';
import { buildProgram } from '../src/program.js';
import { tempDir } from './tmp.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const RECORDED = join(ROOT, 'examples/fixtures/recorded/sample');
const SAMPLE_MP4 = join(ROOT, 'examples/media/sample-16x9.mp4');
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** examples/media/sample-16x9.mp4 when generated (make-sample.sh), otherwise an 18 s tone (the recorded responses cover 0.5–17.226 s). */
async function sampleMedia(dir: string): Promise<string> {
  if (existsSync(SAMPLE_MP4)) return SAMPLE_MP4;
  const file = join(dir, 'sample.m4a');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=18', '-c:a', 'aac', file]);
  return file;
}

const FLAGS = {
  text: `recorded:${RECORDED}`,
  timing: `recorded:${RECORDED}`,
  llm: `recorded:${RECORDED}`,
  context: 'Lumora Insurance ad for DriveCover; host Maya talks with Tom.',
  export: 'json,vtt,srt,txt',
  // opt in to the LLM line cutting (off by default), so the recorded linebreaks responses are used
  llmLinebreaks: true,
};

afterEach(() => {
  process.exitCode = 0;
});

describe.skipIf(!hasFfmpeg)('end to end with recorded API responses', () => {
  it('turns the sample into a valid Overtone document and caption files', async () => {
    const dir = await tempDir('overtone-e2e-');
    const media = await sampleMedia(dir);
    const log = memoryLogger();
    expect(await runTranscribe(media, { ...FLAGS, out: dir }, log, { cwd: dir, env: {} })).toBe(0);

    const base = baseName(media);
    const outputs = log.lines.filter((l) => l.startsWith('out: ')).map((l) => l.slice(5));
    expect(outputs).toEqual(
      ['overtone.json', 'horizontal.vtt', 'horizontal.srt', 'vertical.vtt', 'vertical.srt', 'txt'].map((ext) => join(dir, `${base}.${ext}`)),
    );
    const doc = assertValid(JSON.parse(await readFile(join(dir, `${base}.overtone.json`), 'utf8')));
    const words = flattenWords(doc);
    expect(words.map((w) => w.text).join(' ')).toBe(
      "Every year, one in five drivers has some kind of car damage. With DriveCover from Lumora, you're insured from day one, for just $12 a month. And the best part? You can claim directly in the app. So remember: DriveCover. Drive worry-free.",
    );
    expect(doc.language).toBe('en');
    expect(doc.speakers).toEqual([{ id: 'S1', label: 'Maya', role: 'host' }, { id: 'S2', label: 'Tom' }]);
    expect(doc.turns.map((t) => t.speaker)).toEqual(['S1', 'S2', 'S1']);
    expect(doc.edits).toEqual([{ words: [13, 13], from: 'Drive Cover', to: 'DriveCover', reason: 'brand' }]);
    expect(words.every((w) => w.match !== undefined && w.confidence !== undefined)).toBe(true);
    expect(words[13]).toMatchObject({ text: 'DriveCover', match: 'edited', classes: ['brand'] });
    expect(words.filter((w) => w.classes).map((w) => `${w.text}:${w.classes!.join('+')}`)).toEqual([
      'DriveCover:brand', '$12:key+number', 'a:key+number', 'month.:key+number', 'best:emphasis', 'DriveCover.:brand',
    ]);

    const horizontal = doc.profiles.find((p) => p.id === 'horizontal')!;
    expect(horizontal.cues.map((c) => c.lines.map((l) => l.text))).toEqual([
      ['Every year, one in five drivers', 'has some kind of car damage.'],
      ['With DriveCover from Lumora,', "you're insured from day one,"],
      ['for just $12 a month.'],
      ['And the best part?', 'You can claim directly in the app.'],
      ['So remember: DriveCover. Drive worry-free.'],
    ]);
    // The recorded linebreaks-horizontal proposal is accepted for all three speaker blocks; the vertical proposal is empty, so code cuts.
    expect(log.lines).toContain('info:   horizontal: 3/3 speaker blocks cut as proposed by the LLM');

    // Hard rules and coverage hold for both profiles, whatever the cutter chooses.
    for (const profile of doc.profiles) {
      const rules = profile.rules!;
      let next = 0;
      let prevEnd = 0;
      for (const cue of profile.cues) {
        expect(cue.lines.length).toBeLessThanOrEqual(rules.maxLines);
        expect(cue.start).toBeGreaterThanOrEqual(prevEnd);
        expect(cue.end).toBeGreaterThan(cue.start);
        prevEnd = cue.end;
        for (const line of cue.lines) {
          expect(line.text.length).toBeLessThanOrEqual(rules.maxCharsPerLine);
          expect(line.words[0]).toBe(next); // every word covered exactly once, in order
          expect(line.text).toBe(words.slice(line.words[0], line.words[1] + 1).map((w) => w.text).join(' '));
          next = line.words[1] + 1;
        }
      }
      expect(next).toBe(words.length);
    }
    // Key phrases are never split by a cue or line break, even in the narrow vertical profile.
    const vertical = doc.profiles.find((p) => p.id === 'vertical')!;
    expect(vertical.cues.length).toBeGreaterThan(horizontal.cues.length);
    for (const profile of doc.profiles) {
      const starts = new Set(profile.cues.flatMap((c) => c.lines.map((l) => l.words[0])));
      for (const inside of [24, 25]) expect(starts.has(inside), `${profile.id}: "$12 a month." split at word ${inside}`).toBe(false);
    }
    expect(doc.meta?.models).toEqual({ text: `recorded:${RECORDED}`, timing: `recorded:${RECORDED}`, llm: `recorded:${RECORDED}` });

    // Word timings come straight from the recorded timing response (ms -> s).
    expect(words[0]!.start).toBeCloseTo(0.5, 3);
    expect(words[0]!.end).toBeCloseTo(0.809, 3);
    expect(words[13]!.start).toBeCloseTo(5.023, 3);
    expect(words[13]!.end).toBeCloseTo(5.723, 3);
    expect(words.at(-1)!.end).toBeCloseTo(17.226, 3);
    expect(horizontal.cues[0]!.start).toBeCloseTo(0.5, 3);
    expect(horizontal.cues[0]!.end).toBeCloseTo(4.293, 3);

    // Export contents, not just file presence.
    const hVtt = await readFile(join(dir, `${base}.horizontal.vtt`), 'utf8');
    expect(hVtt.startsWith('WEBVTT')).toBe(true);
    expect(hVtt).toContain('00:00:00.500 --> 00:00:04.293');
    expect(await readFile(join(dir, `${base}.horizontal.srt`), 'utf8')).toMatch(
      /^1\n00:00:00,500 --> 00:00:04,293\nEvery year, one in five drivers\nhas some kind of car damage\./,
    );
    for (const ext of ['vertical.vtt', 'vertical.srt']) {
      const content = await readFile(join(dir, `${base}.${ext}`), 'utf8');
      expect(content.length, ext).toBeGreaterThan(0);
      expect(content, ext).toContain('-->');
    }
    expect(hVtt).toContain('<c.brand>DriveCover</c>');
    expect(await readFile(join(dir, `${base}.txt`), 'utf8')).toMatch(/^Maya: Every year, one in five drivers/);
    expect(log.lines.at(-1)).toBe('info: 42 words: 37 exact, 1 fuzzy, 3 merge, 1 edited · 1 edit · 2 speakers · 5/9 cues');
  });

  it('runs through the commander program and reuses the extracted audio on a second run', async () => {
    const dir = await tempDir('overtone-e2e-');
    const media = await sampleMedia(dir);
    const args = ['transcribe', media, '--text', FLAGS.text, '--timing', FLAGS.timing, '--llm', FLAGS.llm, '--out', dir];
    const first = memoryLogger();
    await buildProgram(first, { cwd: dir }).parseAsync(args, { from: 'user' });
    expect(process.exitCode).toBe(0);
    const firstDoc = JSON.parse(await readFile(join(dir, `${baseName(media)}.overtone.json`), 'utf8'));
    const second = memoryLogger();
    await buildProgram(second, { cwd: dir }).parseAsync(args, { from: 'user' });
    // recorded responses are never cached (they are free): only the extracted audio is reused
    expect(second.lines).toContain('info: [1/6] extract: cached');
    expect(second.lines.filter((l) => l.startsWith('out: '))).toHaveLength(3);
    // The cached run reproduces the document (only the creation time may differ).
    const file = join(dir, `${baseName(media)}.overtone.json`);
    const withoutCreatedAt = (d: { meta?: object }) => ({ ...d, meta: { ...d.meta, createdAt: undefined } });
    expect(withoutCreatedAt(JSON.parse(await readFile(file, 'utf8')))).toEqual(withoutCreatedAt(firstDoc));
  });
});
