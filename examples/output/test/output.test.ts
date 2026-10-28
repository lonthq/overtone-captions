import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate } from 'overtone-format';

const outputDir = join(import.meta.dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.name === 'node_modules' ? [] : entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const files = walk(outputDir).map((file) => relative(outputDir, file));

describe('examples/output', () => {
  const documents = files.filter((file) => file.endsWith('.overtone.json'));

  it('contains the live sample, NASA and Blender film documents', () => {
    expect(documents.sort()).toEqual([
      'cosmos-laundromat/cosmos-laundromat.overtone.json',
      'elephants-dream/elephants-dream.overtone.json',
      'nasa/nasa-dutton.overtone.json',
      'sample/sample-16x9.overtone.json',
      'tears-of-steel/tears-of-steel.overtone.json',
    ]);
  });

  it.each(documents)('%s has the five files --export json,vtt,srt,txt writes next to it', (file) => {
    const base = file.replace(/\.overtone\.json$/, '');
    for (const suffix of ['.horizontal.vtt', '.vertical.vtt', '.horizontal.srt', '.vertical.srt', '.txt']) {
      expect(files).toContain(base + suffix);
    }
  });

  it.each(documents.filter((file) => !file.startsWith('sample/')))('%s has a SOURCE.md naming its source and license', (file) => {
    const source = join(file.split('/')[0], 'SOURCE.md');
    expect(files).toContain(source);
    expect(readFileSync(join(outputDir, source), 'utf8')).toMatch(/## License[\s\S]*## The video is not included/);
  });

  it.each(documents)('%s is a valid Overtone document', (file) => {
    const doc = JSON.parse(readFileSync(join(outputDir, file), 'utf8'));
    expect(validate(doc).errors).toEqual([]);
    expect(doc.profiles.map((p: { id: string }) => p.id)).toEqual(['horizontal', 'vertical']);
  });

  it('holds no video or audio files', () => {
    const media = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg']);
    expect(files.filter((file) => media.has(extname(file).toLowerCase()))).toEqual([]);
  });
});
