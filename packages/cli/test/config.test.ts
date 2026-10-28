import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir as makeTempDir } from './tmp.js';
import { loadConfigFile, parseFormats, parseModelSpec, parseSpeakers, resolveConfig, splitList } from '../src/config.js';
import { UserError } from '../src/errors.js';

async function tempDir(): Promise<string> {
  return makeTempDir('overtone-config-');
}

describe('parseModelSpec', () => {
  it.each([
    ['openai:gpt-transcribe', { provider: 'openai', model: 'gpt-transcribe', id: 'openai:gpt-transcribe' }],
    ['azure-speech', { provider: 'azure-speech', model: undefined, id: 'azure-speech' }],
    ['openai:llama3:8b', { provider: 'openai', model: 'llama3:8b', id: 'openai:llama3:8b' }],
    ['anthropic:', { provider: 'anthropic', model: undefined, id: 'anthropic' }],
  ])('%s', (input, expected) => {
    expect(parseModelSpec(input)).toEqual(expected);
  });
  it('rejects an empty value', () => {
    expect(() => parseModelSpec(' ')).toThrow(UserError);
  });
  it('trims both parts and lowercases the provider only', () => {
    expect(parseModelSpec(' OpenAI : GPT-Transcribe ')).toEqual({ provider: 'openai', model: 'GPT-Transcribe', id: 'openai:GPT-Transcribe' });
  });
  it('rejects an empty provider', () => {
    expect(() => parseModelSpec(':gpt-4o')).toThrow(/Missing provider/);
    expect(() => parseModelSpec('  : x')).toThrow(UserError);
  });
});

describe('small parsers', () => {
  it('splits lists', () => {
    expect(splitList('vtt, srt,,txt')).toEqual(['vtt', 'srt', 'txt']);
    expect(splitList(['a', ' b '])).toEqual(['a', 'b']);
    expect(splitList(undefined)).toBeUndefined();
  });
  it('de-duplicates lists and keeps the order', () => {
    expect(splitList('srt, vtt,srt ,vtt,json')).toEqual(['srt', 'vtt', 'json']);
    expect(splitList(['a', 'b', ' a'])).toEqual(['a', 'b']);
    expect(splitList(' , ')).toEqual([]);
  });
  it('rejects empty format lists and unknown formats', () => {
    expect(() => parseFormats(' , ', ['json'])).toThrow(/No export formats given/);
    expect(parseFormats(undefined, ['json'])).toEqual(['json']);
    expect(() => parseFormats('vtt,pdf', ['json'], 'the config file')).toThrow(/Invalid export format "pdf" in the config file/);
  });
  it('parses speakers', () => {
    expect(parseSpeakers('S1=Sarah, S2=Tom')).toEqual({ S1: 'Sarah', S2: 'Tom' });
    expect(parseSpeakers({ S1: 'Maya' })).toEqual({ S1: 'Maya' });
    expect(parseSpeakers(undefined)).toEqual({});
    expect(() => parseSpeakers('S1')).toThrow(/Invalid --speakers/);
  });
});

describe('loadConfigFile', () => {
  it('returns an empty config when the default file is absent', async () => {
    const dir = await tempDir();
    expect(await loadConfigFile(undefined, dir)).toEqual({ config: {}, dir });
  });
  it('fails for a missing explicit file and for bad JSON', async () => {
    const dir = await tempDir();
    await expect(loadConfigFile('nope.json', dir)).rejects.toThrow(/Config file not found/);
    await writeFile(join(dir, 'overtone.config.json'), '{ nope');
    await expect(loadConfigFile(undefined, dir)).rejects.toThrow(/Cannot read/);
  });
});

describe('config file types', () => {
  async function load(content: string, name = 'overtone.config.json') {
    const dir = await tempDir();
    await writeFile(join(dir, name), content);
    return loadConfigFile(undefined, dir);
  }

  it.each([['null'], ['[1,2]'], ['"text"'], ['5']])('rejects %s as the whole file', async (content) => {
    await expect(load(content)).rejects.toThrow('overtone.config.json must contain a JSON object');
    await expect(load(content)).rejects.toBeInstanceOf(UserError);
  });

  it.each([
    ['{"export": 5}', /"export" must be a string or an array of strings/],
    ['{"profiles": [1]}', /"profiles" must be a string or an array of strings/],
    ['{"chunkMb": "10"}', /"chunkMb" must be a positive number/],
    ['{"chunkMb": 0}', /"chunkMb" must be a positive number/],
    ['{"llm": 3}', /"llm" must be a string/],
    ['{"glossary": {}}', /"glossary" must be a string or an array of strings/],
    ['{"speakers": {"S1": 1}}', /"speakers" must be a string/],
    ['{"profileRules": []}', /"profileRules" must be an object/],
    ['{"profileRules": {"vertical": {"rules": {"maxCharsPerLine": "20"}}}}', /"profileRules.vertical.rules.maxCharsPerLine" must be a positive integer/],
    ['{"profileRules": {"vertical": {"window": {"start": 5, "end": 1}}}}', /"profileRules.vertical.window"/],
    ['{"profileRules": {"feed": {"aspect": "4/5"}}}', /"profileRules.feed.aspect" must be a ratio "W:H"/],
    ['{"styling": {"maxStyledRatio": 2}}', /"styling.maxStyledRatio" must be a number from 0 to 1/],
    ['{"edits": {"maxSpan": "6"}}', /"edits.maxSpan" must be a positive integer/],
  ])('rejects %s', async (content, message) => {
    await expect(load(content)).rejects.toThrow(message);
  });

  it('accepts a well-formed file', async () => {
    const { config } = await load('{"export": ["json"], "chunkMb": 10, "profileRules": {"vertical": {"rules": {"maxCharsPerLine": 20}}}, "future": 1}');
    expect(config.chunkMb).toBe(10);
  });

  it('names the config file in errors', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'my.json'), '{"export": 5}');
    await expect(loadConfigFile('my.json', dir)).rejects.toThrow(/^my\.json: "export"/);
  });
});

describe('mp4 export and the --burn-* flags', () => {
  it('accepts mp4 as an export format, on the flag and in the config file', async () => {
    const dir = await tempDir();
    expect(parseFormats('json,mp4', ['json'])).toEqual(['json', 'mp4']);
    expect((await resolveConfig({ export: 'mp4' }, {}, { cwd: dir, configDir: dir })).exports).toEqual(['mp4']);
    expect((await resolveConfig({}, { export: ['json', 'mp4'] }, { cwd: dir, configDir: dir })).exports).toEqual(['json', 'mp4']);
  });

  it('resolves the burn options, the font against the working folder', async () => {
    const dir = await tempDir();
    const cfg = await resolveConfig({ burnStyle: 'social', burnSpeakerNames: 'change', burnFont: 'fonts/Brand.woff2' }, {}, { cwd: dir, configDir: join(dir, 'elsewhere') });
    expect(cfg.burn).toEqual({ style: 'social', speakerNames: 'change', font: join(dir, 'fonts', 'Brand.woff2') });
    expect((await resolveConfig({}, {}, { cwd: dir, configDir: dir })).burn).toEqual({});
  });

  it('rejects an unknown --burn-speaker-names value', async () => {
    const dir = await tempDir();
    const err = await resolveConfig({ burnSpeakerNames: 'sometimes' }, {}, { cwd: dir, configDir: dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toBe('Invalid --burn-speaker-names "sometimes"; expected one of: never, change, always.');
  });
});

describe('error messages', () => {
  it('blames the config file, not a flag, for a bad value from the file', async () => {
    const dir = await tempDir();
    await expect(resolveConfig({}, { numbers: 'roman' as never }, { cwd: dir, configDir: dir })).rejects.toThrow('Invalid numbers "roman" in the config file');
    await expect(resolveConfig({}, { currency: 'emoji' as never }, { cwd: dir, configDir: dir })).rejects.toThrow('Invalid currency "emoji" in the config file');
    await expect(resolveConfig({}, { export: ['vtt', 'pdf'] }, { cwd: dir, configDir: dir })).rejects.toThrow(/Invalid export format "pdf" in the config file/);
    await expect(resolveConfig({ numbers: 'roman' }, {}, { cwd: dir, configDir: dir })).rejects.toThrow('Invalid --numbers "roman"');
  });

  it('says what is wrong with an incomplete or unsafe profile', async () => {
    const dir = await tempDir();
    const dirs = { cwd: dir, configDir: dir };
    await expect(resolveConfig({ profiles: 'square' }, { profileRules: { square: { rules: { maxCharsPerLine: 30 } } } }, dirs)).rejects.toThrow(/Profile "square" needs an aspect/);
    const square = await resolveConfig({ profiles: 'square' }, { profileRules: { square: { aspect: '1:1', rules: { maxCharsPerLine: 30 } } } }, dirs);
    expect(square.profiles[0].rules).toMatchObject({ maxCharsPerLine: 30, maxLines: 2 });
    await expect(resolveConfig({ profiles: 'cinema' }, {}, dirs)).rejects.toThrow(/Unknown profile "cinema"/);
    await expect(resolveConfig({ profiles: '../x' }, { profileRules: { '../x': { rules: { maxCharsPerLine: 30, maxLines: 2 } } } }, dirs)).rejects.toThrow(/Invalid profile "..\/x"/);
  });

  it('does not treat Object.prototype members as profiles', async () => {
    const dir = await tempDir();
    const dirs = { cwd: dir, configDir: dir };
    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      await expect(resolveConfig({ profiles: id }, {}, dirs)).rejects.toThrow(`Unknown profile "${id}"`);
      await expect(resolveConfig({}, { profiles: [id] }, dirs)).rejects.toThrow(`Unknown profile "${id}"`);
    }
  });

  it('says in the message when an empty list came from the config file', async () => {
    const dir = await tempDir();
    const dirs = { cwd: dir, configDir: dir };
    await expect(resolveConfig({}, { export: [] }, dirs)).rejects.toThrow('No export formats given in the config file.');
    await expect(resolveConfig({}, { export: ' , ' }, dirs)).rejects.toThrow('No export formats given in the config file.');
    await expect(resolveConfig({}, { profiles: [] }, dirs)).rejects.toThrow('No profiles given in the config file.');
    await expect(resolveConfig({ export: ' , ' }, {}, dirs)).rejects.toThrow('No export formats given in --export.');
    await expect(resolveConfig({ profiles: ',' }, {}, dirs)).rejects.toThrow('No profiles given in --profiles.');
  });

  it('rejects empty lists and a profile listed twice, and de-duplicates formats', async () => {
    const dir = await tempDir();
    const dirs = { cwd: dir, configDir: dir };
    await expect(resolveConfig({ export: ' , ' }, {}, dirs)).rejects.toThrow(/No export formats given/);
    await expect(resolveConfig({ profiles: ',' }, {}, dirs)).rejects.toThrow(/No profiles given/);
    const c = await resolveConfig({ export: 'vtt,vtt,json', profiles: 'vertical' }, {}, dirs);
    expect(c.exports).toEqual(['vtt', 'json']);
    expect(c.profiles.map((p) => p.id)).toEqual(['vertical']);
    await expect(resolveConfig({ profiles: 'vertical, vertical' }, {}, dirs)).rejects.toThrow('Profile "vertical" is listed twice ("vertical" and "vertical").');
  });

  it('reports unreadable glossary and context files', async () => {
    const dir = await tempDir();
    const dirs = { cwd: dir, configDir: dir };
    await mkdir(join(dir, 'folder'));
    await expect(resolveConfig({ glossary: 'folder' }, {}, dirs)).rejects.toThrow(/Glossary file is a directory/);
    await expect(resolveConfig({ contextFile: 'folder' }, {}, dirs)).rejects.toThrow(/Context file is a directory/);
    await expect(resolveConfig({ contextFile: 'nope.txt' }, {}, dirs)).rejects.toThrow(/Context file not found/);
    if (process.getuid?.() !== 0) {
      await writeFile(join(dir, 'secret.txt'), 'x');
      await chmod(join(dir, 'secret.txt'), 0o000);
      await expect(resolveConfig({ glossary: 'secret.txt' }, {}, dirs)).rejects.toThrow(/Glossary file is not readable \(permission denied\)/);
    }
  });
});

describe('resolveConfig', () => {
  it('applies defaults', async () => {
    const dir = await tempDir();
    const c = await resolveConfig({}, {}, { cwd: dir, configDir: dir });
    expect(c.text).toEqual({ provider: 'openai', model: undefined, id: 'openai' });
    expect(c.timing.id).toBe('azure-speech');
    expect(c.llm.provider).toBe('openai');
    expect(c.exports).toEqual(['json', 'vtt']);
    expect(c.profiles.map((p) => p.id)).toEqual(['horizontal', 'vertical']);
    expect(c.profiles[0].rules.maxCharsPerLine).toBe(42);
    expect(c.language).toBeUndefined();
    expect(c.style).toEqual({ numbers: 'auto', currency: 'auto' });
    expect(c.cacheDir).toBe(join(dir, '.overtone'));
    expect(c.chunkBytes).toBe(24 * 1024 * 1024);
    expect(c.useCache).toBe(true);
    expect(c.styling).toEqual({ maxStyledRatio: 0.15, maxKeyPerCue: 1 });
    expect(c.edits).toEqual({ maxSpan: 6 });
  });

  it('lets CLI flags win over the config file', async () => {
    const dir = await tempDir();
    const c = await resolveConfig(
      { llm: 'anthropic:claude-opus-5-5', export: 'srt', language: 'nl', cache: false, fromStage: 'refine' },
      { llm: 'openai:gpt-6.1-sol', export: ['json'], language: 'en', numbers: 'digits', styleGuide: 'Use UK spelling.' },
      { cwd: dir, configDir: dir },
    );
    expect(c.llm.id).toBe('anthropic:claude-opus-5-5');
    expect(c.exports).toEqual(['srt']);
    expect(c.language).toBe('nl');
    expect(c.useCache).toBe(false);
    expect(c.fromStage).toBe('refine');
    expect(c.style).toEqual({ numbers: 'digits', currency: 'auto', guide: 'Use UK spelling.' });
  });

  it('reads context and glossary files relative to their origin', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'ctx.txt'), 'Lumora ad about DriveCover\n');
    await writeFile(join(dir, 'terms.txt'), '# brands\nDriveCover\n\nLumora\n');
    const c = await resolveConfig({ contextFile: 'ctx.txt' }, { glossary: 'terms.txt' }, { cwd: dir, configDir: dir });
    expect(c.context).toBe('Lumora ad about DriveCover');
    expect(c.glossary).toEqual(['DriveCover', 'Lumora']);
    const inline = await resolveConfig({}, { glossary: ['A', 'B'], context: 'ctx' }, { cwd: dir, configDir: dir });
    expect(inline.glossary).toEqual(['A', 'B']);
    expect(inline.context).toBe('ctx');
    await expect(resolveConfig({ glossary: 'missing.txt' }, {}, { cwd: dir, configDir: dir })).rejects.toThrow(/Glossary file not found/);
  });

  it('merges profile overrides and supports custom profiles', async () => {
    const dir = await tempDir();
    const c = await resolveConfig(
      { profiles: 'vertical,square' },
      { profileRules: { vertical: { rules: { maxCharsPerLine: 20 }, window: { start: 0, end: 10 } }, square: { description: 'Square', aspect: '1:1', rules: { maxCharsPerLine: 30, maxLines: 3 } } } },
      { cwd: dir, configDir: dir },
    );
    expect(c.profiles[0]).toEqual({ id: 'vertical', description: 'Phone', aspect: '9:16', rules: { maxCharsPerLine: 20, maxLines: 2, maxCps: 15, minDuration: 0.8, maxDuration: 5.0 }, window: { start: 0, end: 10 } });
    expect(c.profiles[1]).toEqual({ id: 'square', description: 'Square', aspect: '1:1', rules: { maxCharsPerLine: 30, maxLines: 3, maxCps: 16, minDuration: 0.9, maxDuration: 6 } });
  });

  it.each([
    [{ profiles: 'cinema' }, /Unknown profile "cinema"/],
    [{ export: 'vtt,pdf' }, /Invalid export format "pdf"/],
    [{ fromStage: 'polish' }, /Invalid --from-stage "polish"/],
    [{ numbers: 'roman' }, /Invalid --numbers "roman"/],
  ])('rejects %j', async (flags, message) => {
    const dir = await tempDir();
    await expect(resolveConfig(flags, {}, { cwd: dir, configDir: dir })).rejects.toThrow(message);
  });
});

describe('profiles by aspect', () => {
  it('accepts names and aspects in --profiles', async () => {
    const dir = await tempDir();
    const cfg = await resolveConfig({ profiles: 'horizontal,1:1' }, {}, { cwd: dir, configDir: dir });
    expect(cfg.profiles.map((p) => [p.id, p.aspect, p.rules.maxCharsPerLine])).toEqual([['horizontal', '16:9', 42], ['1x1', '1:1', 32]]);
    expect(cfg.profilesExplicit).toBe(true);
  });

  it('defines a custom profile from its aspect; explicit rules win', async () => {
    const dir = await tempDir();
    const cfg = await resolveConfig({}, { profiles: ['feed'], profileRules: { feed: { aspect: '4:5', rules: { maxLines: 3 } } } }, { cwd: dir, configDir: dir });
    expect(cfg.profiles[0]).toMatchObject({ id: 'feed', aspect: '4:5', rules: { maxCharsPerLine: 28, maxLines: 3 } });
    expect(cfg.profilesExplicit).toBe(true);
  });

  it('requires an aspect for a custom profile', async () => {
    const dir = await tempDir();
    await expect(resolveConfig({}, { profiles: ['feed'], profileRules: { feed: { rules: { maxCharsPerLine: 30, maxLines: 2 } } } }, { cwd: dir, configDir: dir }))
      .rejects.toThrow('Profile "feed" needs an aspect: set profileRules.feed.aspect, such as "4:5", in overtone.config.json.');
  });

  it('is not explicit by default', async () => {
    const dir = await tempDir();
    expect((await resolveConfig({}, {}, { cwd: dir, configDir: dir })).profilesExplicit).toBe(false);
  });

  it('re-aspects a built-in profile: rules derived from the new aspect', async () => {
    const dir = await tempDir();
    const dirs = { cwd: dir, configDir: dir };
    const cfg = await resolveConfig({}, { profileRules: { vertical: { aspect: '4:5' } } }, dirs);
    expect(cfg.profiles[1]).toMatchObject({ id: 'vertical', aspect: '4:5', description: 'Phone', rules: { maxCharsPerLine: 28 } });
    const same = await resolveConfig({}, { profileRules: { vertical: { aspect: '9:16' } } }, dirs);
    expect(same.profiles[1]).toMatchObject({ id: 'vertical', aspect: '9:16', rules: { maxCharsPerLine: 22, maxLines: 2, maxCps: 15, minDuration: 0.8, maxDuration: 5 } });
  });

  it('reduces an aspect given in the profile list', async () => {
    const dir = await tempDir();
    const cfg = await resolveConfig({ profiles: '2:2,32:18' }, {}, { cwd: dir, configDir: dir });
    expect(cfg.profiles.map((p) => [p.id, p.aspect])).toEqual([['1x1', '1:1'], ['16x9', '16:9']]);
  });

  it('lets profileRules add to an aspect token, but not contradict it', async () => {
    const dir = await tempDir();
    const dirs = { cwd: dir, configDir: dir };
    const cfg = await resolveConfig({ profiles: '1:1' }, { profileRules: { '1x1': { description: 'Square', rules: { maxLines: 3 } } } }, dirs);
    expect(cfg.profiles[0]).toMatchObject({ id: '1x1', aspect: '1:1', description: 'Square', rules: { maxCharsPerLine: 32, maxLines: 3 } });
    await expect(resolveConfig({ profiles: '1:1' }, { profileRules: { '1x1': { aspect: '4:5' } } }, dirs))
      .rejects.toThrow('Profile "1x1" is given as "1:1" in the profile list but profileRules.1x1.aspect is "4:5"; use one.');
  });

  it('rejects two tokens that name one profile', async () => {
    const dir = await tempDir();
    const dirs = { cwd: dir, configDir: dir };
    await expect(resolveConfig({ profiles: '1:1,2:2' }, {}, dirs)).rejects.toThrow('Profile "1x1" is listed twice ("1:1" and "2:2").');
    await expect(resolveConfig({ profiles: '1:1,1x1' }, { profileRules: { '1x1': { aspect: '1:1' } } }, dirs)).rejects.toThrow('Profile "1x1" is listed twice ("1:1" and "1x1").');
  });

  it('reduces an aspect given in profileRules', async () => {
    const dir = await tempDir();
    const cfg = await resolveConfig({}, { profiles: ['feed', '1:1'], profileRules: { feed: { aspect: '8:10' }, '1x1': { aspect: '2:2' } } }, { cwd: dir, configDir: dir });
    expect(cfg.profiles.map((p) => [p.id, p.aspect])).toEqual([['feed', '4:5'], ['1x1', '1:1']]);
  });

  it('takes an aspect written WxH, and suggests nothing for other unknown ids', async () => {
    const dir = await tempDir();
    const dirs = { cwd: dir, configDir: dir };
    expect((await resolveConfig({ profiles: '1x1' }, {}, dirs)).profiles.map((p) => [p.id, p.aspect])).toEqual([['1x1', '1:1']]);
    await expect(resolveConfig({ profiles: 'cinema' }, {}, dirs)).rejects.not.toThrow(/did you mean/);
    await expect(resolveConfig({ profiles: '0x5' }, {}, dirs)).rejects.not.toThrow(/did you mean/);
  });
});
