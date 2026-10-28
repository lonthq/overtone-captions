import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initConfig } from '../src/commands/init.js';
import { runTranscribe } from '../src/commands/transcribe.js';
import { closestKey, loadConfigFile, resolveConfig, validateFileConfig, type CliFlags } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { memoryLogger } from '../src/log.js';
import { tempDir } from './tmp.js';

function warnings(raw: unknown): string[] {
  const out: string[] = [];
  validateFileConfig(raw, 'overtone.config.json', (msg) => out.push(msg));
  return out;
}

describe('unknown keys in the config file', () => {
  it('warns about an unknown top-level key and suggests the close known one', () => {
    expect(warnings({ glosary: ['Lumora'] })).toEqual(['overtone.config.json: unknown key "glosary" is ignored (did you mean "glossary"?).']);
    expect(warnings({ chunkMB: 10 })).toEqual(['overtone.config.json: unknown key "chunkMB" is ignored (did you mean "chunkMb"?).']);
    expect(warnings({ twopass: true })).toEqual(['overtone.config.json: unknown key "twopass" is ignored (did you mean "twoPass"?).']);
  });

  it('names an unknown key without a suggestion when nothing is close', () => {
    expect(warnings({ future: 1 })).toEqual(['overtone.config.json: unknown key "future" is ignored.']);
  });

  it('warns about unknown keys in objects with a fixed shape, with the path', () => {
    expect(warnings({
      styling: { maxStyledRatio: 0.1, maxKeyPercue: 1 },
      edits: { maxspan: 4 },
      languages: { nl: { lm: 'anthropic' } },
      profileRules: { vertical: { rule: {}, rules: { maxCharPerLine: 20 }, window: { start: 0, end: 5, ende: 6 } } },
    })).toEqual([
      'overtone.config.json: unknown key "languages.nl.lm" is ignored (did you mean "languages.nl.llm"?).',
      'overtone.config.json: unknown key "profileRules.vertical.rule" is ignored (did you mean "profileRules.vertical.rules"?).',
      'overtone.config.json: unknown key "profileRules.vertical.rules.maxCharPerLine" is ignored (did you mean "profileRules.vertical.rules.maxCharsPerLine"?).',
      'overtone.config.json: unknown key "profileRules.vertical.window.ende" is ignored (did you mean "profileRules.vertical.window.end"?).',
      'overtone.config.json: unknown key "styling.maxKeyPercue" is ignored (did you mean "styling.maxKeyPerCue"?).',
      'overtone.config.json: unknown key "edits.maxspan" is ignored (did you mean "edits.maxSpan"?).',
    ]);
  });

  it('never warns about "$" keys, and the file `overtone init` writes has no unknown keys', () => {
    expect(warnings({ $schema: './schema.json', $comment: ['note'], llm: 'openai' })).toEqual([]);
    expect(warnings(JSON.parse(JSON.stringify(initConfig())))).toEqual([]);
  });

  it('warns, it does not fail, and keeps loading the file', async () => {
    const dir = await tempDir('overtone-keys-');
    await writeFile(join(dir, 'overtone.config.json'), '{"llm": "anthropic", "contxt": "A talk"}');
    const seen: string[] = [];
    const { config } = await loadConfigFile(undefined, dir, (msg) => seen.push(msg));
    expect(config.llm).toBe('anthropic');
    expect(seen).toEqual(['overtone.config.json: unknown key "contxt" is ignored (did you mean "context"?).']);
  });

  it('reaches the transcribe logger as a warning', async () => {
    const dir = await tempDir('overtone-keys-');
    await writeFile(join(dir, 'overtone.config.json'), '{"exprt": "json"}');
    const log = memoryLogger();
    // the media does not exist, so the run stops right after the config is read; no provider is called
    await runTranscribe('missing.mp4', {}, log, { cwd: dir, env: {} }).catch(() => undefined);
    expect(log.lines).toContain('warn: overtone.config.json: unknown key "exprt" is ignored (did you mean "export"?).');
  });

  it('closestKey matches case-insensitively and gives up on distant keys', () => {
    expect(closestKey('LLM', ['llm', 'text'])).toBe('llm');
    expect(closestKey('xyz', ['llm', 'text'])).toBeUndefined();
  });
});

describe('twoPass and markUncertain in the config file', () => {
  const resolveWith = async (flags: CliFlags, file: object) => {
    const dir = await tempDir('overtone-keys-');
    return resolveConfig(flags, validateFileConfig(file), { cwd: dir, configDir: dir });
  };

  it('default to false', async () => {
    const cfg = await resolveWith({}, {});
    expect(cfg.twoPass).toBe(false);
    expect(cfg.markUncertain).toBe(false);
  });

  it('are read from the file', async () => {
    const cfg = await resolveWith({}, { twoPass: true, markUncertain: true });
    expect(cfg.twoPass).toBe(true);
    expect(cfg.markUncertain).toBe(true);
  });

  it('flags win over the file, both ways', async () => {
    const off = await resolveWith({ twoPass: false, markUncertain: false }, { twoPass: true, markUncertain: true });
    expect([off.twoPass, off.markUncertain]).toEqual([false, false]);
    const on = await resolveWith({ twoPass: true, markUncertain: true }, { twoPass: false, markUncertain: false });
    expect([on.twoPass, on.markUncertain]).toEqual([true, true]);
  });

  it('must be true or false', () => {
    expect(() => validateFileConfig({ twoPass: 'yes' })).toThrow(/"twoPass" must be true or false/);
    expect(() => validateFileConfig({ markUncertain: 1 })).toThrow(/"markUncertain" must be true or false/);
  });

  it('"twoPass": true in the file with --text-file names the file and the fix', async () => {
    const err = await resolveWith({ textFile: 'talk.srt' }, { twoPass: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as Error).message).toMatch(/"twoPass": true in the config file cannot be combined with --text-file.*--no-two-pass/);
    await expect(resolveWith({ textFile: 'talk.srt', twoPass: false }, { twoPass: true })).resolves.toMatchObject({ twoPass: false });
  });
});
