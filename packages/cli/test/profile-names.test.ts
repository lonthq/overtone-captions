import { describe, expect, it } from 'vitest';
import type { OvertoneDocument } from 'overtone-format';
import { tempDir } from './tmp.js';
import { parseSpeakers, resolveConfig } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { writeOutputs } from '../src/output.js';
import { findProfileId, tokenAspect } from '../src/segment/aspect.js';

const dirsOf = async () => {
  const dir = await tempDir('overtone-profiles-');
  return { cwd: dir, configDir: dir };
};

describe('profile names: an aspect written W:H or WxH', () => {
  it('reads both spellings as one aspect', () => {
    expect(tokenAspect('1:1')).toBe('1:1');
    expect(tokenAspect('4x5')).toBe('4:5');
    expect(tokenAspect('horizontal')).toBeUndefined();
    expect(tokenAspect('0x5')).toBeUndefined();
  });

  it('finds the document profile by either spelling', () => {
    expect(findProfileId(['horizontal', '1x1'], '1:1')).toBe('1x1');
    expect(findProfileId(['horizontal', '1x1'], '1x1')).toBe('1x1');
    expect(findProfileId(['horizontal', '1x1'], '2:2')).toBe('1x1');
    expect(findProfileId(['2x2'], '2:2')).toBe('2x2');
    expect(findProfileId(['horizontal'], '1:1')).toBeUndefined();
  });

  it('resolves 1:1 and 1x1 to the same profile id 1x1 (transcribe and recut)', async () => {
    const dirs = await dirsOf();
    for (const token of ['1:1', '1x1', '2x2']) {
      const cfg = await resolveConfig({ profiles: `horizontal,${token}` }, {}, dirs);
      expect(cfg.profiles.map((p) => [p.id, p.aspect])).toEqual([['horizontal', '16:9'], ['1x1', '1:1']]);
    }
  });

  it('rejects a profile listed twice, also after normalization', async () => {
    const dirs = await dirsOf();
    await expect(resolveConfig({ profiles: 'horizontal,horizontal' }, {}, dirs)).rejects.toThrow(new UserError('Profile "horizontal" is listed twice ("horizontal" and "horizontal").'));
    await expect(resolveConfig({ profiles: '1:1,1x1' }, {}, dirs)).rejects.toThrow(new UserError('Profile "1x1" is listed twice ("1:1" and "1x1").'));
    await expect(resolveConfig({}, { profiles: ['vertical', 'vertical'] }, dirs)).rejects.toThrow(/Profile "vertical" is listed twice/);
  });
});

describe('export: profiles by either spelling', () => {
  const doc = {
    version: '1.0', language: 'en', duration: 1, words: [], turns: [], speakers: [],
    profiles: [
      { id: 'horizontal', aspect: '16:9', rules: { maxCharsPerLine: 42, maxLines: 2 }, cues: [] },
      { id: '1x1', aspect: '1:1', rules: { maxCharsPerLine: 32, maxLines: 2 }, cues: [] },
    ],
  } as unknown as OvertoneDocument;

  it('writes the 1x1 files for --profiles 1:1', async () => {
    const outDir = await tempDir('overtone-export-');
    const written = await writeOutputs(doc, { base: 'talk', outDir, formats: ['vtt'], profiles: ['1:1'] });
    expect(written.map((p) => p.slice(outDir.length + 1))).toEqual(['talk.1x1.vtt']);
  });

  it('rejects a profile listed twice and an unknown one', async () => {
    const outDir = await tempDir('overtone-export-');
    await expect(writeOutputs(doc, { base: 'talk', outDir, formats: ['vtt'], profiles: ['1:1', '1x1'] }))
      .rejects.toThrow(new UserError('Profile "1x1" is listed twice ("1:1" and "1x1"); list each profile once.'));
    await expect(writeOutputs(doc, { base: 'talk', outDir, formats: ['vtt'], profiles: ['horizontal', 'horizontal'] })).rejects.toThrow(/listed twice/);
    await expect(writeOutputs(doc, { base: 'talk', outDir, formats: ['vtt'], profiles: ['4:5'] })).rejects.toThrow('Profile "4:5" is not in the document (has: horizontal, 1x1).');
  });
});

describe('profileRules: minDuration and maxDuration', () => {
  it('rejects a resolved profile whose minDuration is more than its maxDuration', async () => {
    const dirs = await dirsOf();
    // vertical's built-in maxDuration is 5: an override of minDuration alone conflicts with it
    await expect(resolveConfig({}, { profileRules: { vertical: { rules: { minDuration: 6 } } } }, dirs)).rejects.toThrow(
      new UserError('Profile "vertical" has minDuration 6 s, more than its maxDuration 5 s; set profileRules.vertical.rules so that minDuration is at most maxDuration in overtone.config.json.'),
    );
    await expect(resolveConfig({ profiles: '1:1' }, { profileRules: { '1x1': { rules: { minDuration: 3, maxDuration: 2 } } } }, dirs)).rejects.toThrow(/Profile "1x1" has minDuration 3 s, more than its maxDuration 2 s/);
    const ok = await resolveConfig({}, { profileRules: { vertical: { rules: { minDuration: 5 } } } }, dirs);
    expect(ok.profiles[1].rules).toMatchObject({ minDuration: 5, maxDuration: 5 });
  });
});

describe('--speakers checks', () => {
  it('rejects an id given twice', () => {
    expect(() => parseSpeakers('S1=A,S1=B')).toThrow(new UserError('Speaker "S1" is given twice in --speakers ("A" and "B"); give each speaker id once.'));
    expect(() => parseSpeakers('S1=A, S1=A')).toThrow(/given twice/);
    expect(() => parseSpeakers({ S1: 'A', ' S1 ': 'B' }, 'the config file')).toThrow(new UserError('Speaker "S1" is given twice in the config file ("A" and "B"); give each speaker id once.'));
  });

  it('rejects empty ids and labels in both forms', () => {
    expect(() => parseSpeakers('=Sarah')).toThrow(/Invalid --speakers entry "=Sarah"/);
    expect(() => parseSpeakers('S1= ,S2=Tom')).toThrow(/Invalid --speakers entry "S1="/);
    expect(() => parseSpeakers({ S1: '  ' }, 'the config file')).toThrow(/Invalid speakers entry "S1": " {2}" in the config file/);
    expect(() => parseSpeakers({ '': 'Sarah' }, 'the config file')).toThrow(/Invalid speakers entry "": "Sarah" in the config file/);
  });

  it('trims object-form ids and labels like the string form', async () => {
    expect(parseSpeakers({ ' S1 ': ' Sarah ' })).toEqual({ S1: 'Sarah' });
    await expect(resolveConfig({}, { speakers: 'S1=A,S1=B' }, await dirsOf())).rejects.toThrow(/given twice in the config file/);
  });
});
