import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { flattenWords, toTranscript, type OvertoneDocument } from 'overtone-format';
import { runExport } from '../src/commands/export.js';
import { runRecut } from '../src/commands/recut.js';
import { runValidate } from '../src/commands/validate.js';
import { memoryLogger } from '../src/log.js';
import { readTranscriptFile, stripSpeakerLabels } from '../src/providers/file.js';
import { readRecutSource, readTextInput } from '../src/recut.js';
import { decodeText } from '../src/text/decode.js';
import { tempDir } from './tmp.js';

const SAMPLE = resolve(import.meta.dirname, '../../../examples/fixtures/sample.overtone.json');
const SRT = '1\n00:00:01,000 --> 00:00:02,000\nCafé, s’il vous plaît.\n\n2\n00:00:02,500 --> 00:00:03,500\nTrès bien.\n';

const utf16be = (text: string) => Buffer.from(text, 'utf16le').swap16();

describe('text encodings', () => {
  it('reads a Windows-1252 file as Windows-1252 and warns', async () => {
    const dir = await tempDir('overtone-enc-');
    // "’" is 0x92 in Windows-1252
    const bytes = Buffer.from(SRT.replace('’', '\u0000'), 'latin1');
    bytes[bytes.indexOf(0)] = 0x92;
    await writeFile(join(dir, 'fr.srt'), bytes);
    const warnings: string[] = [];
    const source = await readRecutSource(join(dir, 'fr.srt'), 'fr.srt', (m) => warnings.push(m));
    expect(source.kind).toBe('srt');
    if (source.kind !== 'srt') return;
    expect(source.parsed.cues.map((c) => c.segments.map((s) => s.text).join(' '))).toEqual(['Café, s’il vous plaît.', 'Très bien.']);
    expect(warnings).toEqual(['fr.srt is not valid UTF-8; read it as Windows-1252 (Western European). If characters look wrong, save the file as UTF-8.']);
    const file = await readTranscriptFile(join(dir, 'fr.srt'), 'fr.srt', (m) => warnings.push(m));
    expect(file.text).toBe('Café, s’il vous plaît. Très bien.');
    expect(warnings).toHaveLength(2);
  });

  it('shows the Windows-1252 warning in the recut log', async () => {
    const dir = await tempDir('overtone-enc-');
    await writeFile(join(dir, 'fr.srt'), Buffer.from(SRT.replace('’', "'"), 'latin1'));
    const log = memoryLogger();
    expect(await runRecut('fr.srt', { language: 'fr', export: 'json' }, log, dir)).toBe(0);
    expect(log.lines).toContain('warn: fr.srt is not valid UTF-8; read it as Windows-1252 (Western European). If characters look wrong, save the file as UTF-8.');
  });

  it('reads UTF-16 LE and BE with a byte order mark, and UTF-8 with or without one, without a warning', async () => {
    const dir = await tempDir('overtone-enc-');
    await writeFile(join(dir, 'le.srt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SRT, 'utf16le')]));
    await writeFile(join(dir, 'be.srt'), Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(SRT)]));
    await writeFile(join(dir, 'bom.srt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SRT, 'utf8')]));
    await writeFile(join(dir, 'plain.srt'), SRT);
    const warnings: string[] = [];
    for (const name of ['le.srt', 'be.srt', 'bom.srt', 'plain.srt']) {
      expect(await readTextInput(join(dir, name), name, 'a subtitle file', (m) => warnings.push(m))).toBe(SRT);
      expect((await readTranscriptFile(join(dir, name), name)).text).toBe('Café, s’il vous plaît. Très bien.');
    }
    expect(warnings).toEqual([]);
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('a', 'utf16le')]))).toEqual({ text: 'a', encoding: 'utf-16le' });
  });

  it('still refuses binary content', async () => {
    const dir = await tempDir('overtone-enc-');
    await writeFile(join(dir, 'clip.srt'), Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
    // a UTF-16 byte order mark followed by NUL characters is binary too
    await writeFile(join(dir, 'odd.srt'), Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x41, 0x00]));
    for (const name of ['clip.srt', 'odd.srt']) {
      await expect(readTextInput(join(dir, name), name, 'a subtitle file')).rejects.toThrow(`${name} is not a text file (it looks binary). Is it a media file?`);
    }
  });
});

describe('speaker labels in a plain-text --text-file', () => {
  it("reads Overtone's own .txt as its words, without the speaker labels", async () => {
    const doc = JSON.parse(await readFile(SAMPLE, 'utf8')) as OvertoneDocument;
    const dir = await tempDir('overtone-labels-');
    await writeFile(join(dir, 'sample.txt'), toTranscript(doc));
    const file = await readTranscriptFile(join(dir, 'sample.txt'));
    expect(file.text).toBe(flattenWords(doc).map((w) => w.text).join(' '));
    expect(file.text).not.toMatch(/\b(Maya|Tom):/);
  });

  it('strips labels only when every paragraph is one "Label: " line', () => {
    expect(stripSpeakerLabels('S1: Hello there.\n\nDr. Maya Chen: Hi.\n')).toBe('Hello there.\n\nHi.');
    expect(stripSpeakerLabels('S1: Only one speaker here.\n')).toBe('Only one speaker here.');
    const ordinary = [
      'Note: this talk was recorded in 2024.\n', // one paragraph with a label that is not a speaker id
      'Note: recorded in 2024.\n\nWe start at 10:30 sharp.\n', // not every paragraph has a label
      'Maya: Hello.\nThis line continues.\n\nTom: Hi.\n', // a paragraph of several lines
      'note: lower case.\n\nother: lower case.\n',
      'What did she say? She said: yes.\n\nTom: Hi.\n',
    ];
    for (const text of ordinary) expect(stripSpeakerLabels(text)).toBe(text);
  });

  it('leaves an ordinary text file as it is', async () => {
    const dir = await tempDir('overtone-labels-');
    await writeFile(join(dir, 'notes.txt'), 'Note: the speaker was late.\n\nShe began at 10:30 with a question.\n');
    expect((await readTranscriptFile(join(dir, 'notes.txt'))).text).toBe('Note: the speaker was late. She began at 10:30 with a question.');
  });
});

describe('a byte order mark in an .overtone.json', () => {
  it('is accepted by validate and export', async () => {
    const dir = await tempDir('overtone-bom-');
    const file = join(dir, 'bom.overtone.json');
    await writeFile(file, '﻿' + (await readFile(SAMPLE, 'utf8')));
    const log = memoryLogger();
    expect(await runValidate(file, log)).toBe(0);
    expect(log.lines[0]).toMatch(/bom\.overtone\.json: valid/);
    const out = join(dir, 'out');
    expect(await runExport(file, { export: 'srt', out }, memoryLogger())).toBe(0);
    process.exitCode = 0;
  });
});
