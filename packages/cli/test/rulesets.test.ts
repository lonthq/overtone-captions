import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DEFAULT_PROFILES, type OvertoneDocument } from 'overtone-format';
import { afterEach, describe, expect, it } from 'vitest';
import { INIT_MODELS, initConfig, runInit } from '../src/commands/init.js';
import { runRecut } from '../src/commands/recut.js';
import { resolveConfig, validateFileConfig, type CliFlags } from '../src/config.js';
import { UserError } from '../src/errors.js';
import { languageDataHash } from '../src/lang/fingerprint.js';
import { memoryLogger } from '../src/log.js';
import { buildProgram } from '../src/program.js';
import { breakCost, invertedAuxiliaryAt, mainVerbAt, noBreakAfter, questionHeadAt } from '../src/segment/groups.js';
import { hesitationWeight } from '../src/segment/pauses.js';
import { buildProfile } from '../src/segment/profile.js';
import { breakRule } from '../src/segment/rules.js';
import { LATEST, LATEST_RULESET, RULESETS, resolveRuleSet, type RuleSet } from '../src/segment/rulesets/index.js';
import type { SplitContext } from '../src/segment/splitter.js';
import { tokenizeDisplay } from '../src/text/normalize.js';
import type { SpeakerWord } from '../src/turns.js';
import { tempDir } from './tmp.js';

const dirs = { cwd: '/tmp', configDir: '/tmp' };
const SUBTITLES = resolve(import.meta.dirname, 'fixtures/subtitles');

afterEach(() => {
  process.exitCode = 0;
});

function frozenDeep(value: unknown): boolean {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(frozenDeep);
}

describe('rule sets', () => {
  it('are frozen, and "latest" is a registered one', () => {
    expect(Object.keys(RULESETS)).toContain(LATEST);
    for (const rs of Object.values(RULESETS)) expect(frozenDeep(rs)).toBe(true);
    expect(LATEST_RULESET).toBe(RULESETS[LATEST]);
    expect(() => {
      (LATEST_RULESET.pauses as { floor: number }).floor = 0.5;
    }).toThrow();
  });

  it('the latest rule set\'s profiles are overtone-format\'s DEFAULT_PROFILES (a change there needs a new rule set)', () => {
    expect(LATEST_RULESET.profiles).toEqual(DEFAULT_PROFILES);
  });

  it('resolve by id or "latest"; an unknown id lists the available ones', () => {
    expect(resolveRuleSet(undefined).id).toBe(LATEST);
    expect(resolveRuleSet('latest').id).toBe(LATEST);
    expect(resolveRuleSet('1')).toBe(RULESETS['1']);
    expect(() => resolveRuleSet('7')).toThrow(UserError);
    expect(() => resolveRuleSet('7')).toThrow(/Unknown rule set "7" in --rules; available: 1 or "latest" \(= 1\)/);
    expect(() => resolveRuleSet('__proto__')).toThrow(UserError);
  });
});

describe('rule set 1: weighted hesitations from the 0.4 s floor', () => {
  const p = RULESETS['1'].pauses;

  it('weight 0 below 0.4 s, 0.5 at 0.4 s, rising linearly to 1 at 0.6 s', () => {
    expect(hesitationWeight(p, 0.39)).toBe(0);
    expect(hesitationWeight(p, 0.4)).toBe(0.5);
    expect(hesitationWeight(p, 0.5)).toBeCloseTo(0.75, 10);
    expect(hesitationWeight(p, 0.6)).toBe(1);
    expect(hesitationWeight(p, 1.2)).toBe(1);
    expect(hesitationWeight(p, Number.NaN)).toBe(0);
    // a full weight at or below the floor is a step
    expect(hesitationWeight({ ...p, floor: 0.5, full: 0.5 }, 0.5)).toBe(1);
  });

  it('the text-penalty waiver scales with the weight', () => {
    const t = tokenizeDisplay('walk through what they do, and the rest');
    const keep = noBreakAfter(t, 'en', []);
    const none = breakCost({ texts: t, keep, lang: 'en' }, 1);
    const full = breakCost({ texts: t, keep, lang: 'en' }, 1, { hesitation: 1 });
    expect(full).toBeLessThanOrEqual(1);
    expect(breakCost({ texts: t, keep, lang: 'en' }, 1, { hesitation: 0.5 })).toBeCloseTo((none + full) / 2, 10);
  });

  const words = (pause: number): SpeakerWord[] => {
    const texts = tokenizeDisplay('We took a class we affectionately call the Peacocks.');
    let t = 0;
    return texts.map((text, k) => {
      const w = { text, start: +t.toFixed(3), end: +(t + 0.3).toFixed(3), speaker: 'S1' };
      t = w.end + (k === 4 ? pause : 0.05);
      return w;
    });
  };
  const ctxOf = (ws: SpeakerWord[], ruleset?: RuleSet): SplitContext => {
    const texts = ws.map((w) => w.text);
    return { texts, starts: ws.map((w) => w.start), ends: ws.map((w) => w.end), keep: noBreakAfter(texts, 'en', []), lang: 'en', rules: DEFAULT_PROFILES.horizontal.rules, ...(ruleset ? { ruleset } : {}) };
  };

  it('an LLM proposal may break at a pause from 0.4 s (breakRule), not below', () => {
    const r = (pause: number, ruleset?: RuleSet) => ({ ctx: ctxOf(words(pause), ruleset), blockStart: 0, blockEnd: 8 });
    expect(breakRule(4, 0, false, r(0.45))).toBeUndefined();
    expect(breakRule(4, 0, false, r(0.35))).toBe('pronounEnd');
    // the logic switch: without the waiver, a hesitation exempts nothing
    const noWaiver: RuleSet = { ...RULESETS['1'], logic: { ...RULESETS['1'].logic, hesitationWaiver: false } };
    expect(breakRule(4, 0, false, r(0.8, noWaiver))).toBe('pronounEnd');
  });

  it('a pause of 0.42 s splits a cue that fits on one line; 0.35 s does not', () => {
    const cut = (pause: number) => {
      let t = 0;
      const ws = tokenizeDisplay('So the plan is to go home now.').map((text, k) => {
        const w = { text, start: +t.toFixed(3), end: +(t + 0.3).toFixed(3), speaker: 'S1' };
        t = w.end + (k === 2 ? pause : 0.05);
        return w;
      });
      return buildProfile(ws, { id: 'horizontal', ...DEFAULT_PROFILES.horizontal }, { language: 'en', glossary: [], duration: 10 }).profile.cues.map((c) => c.lines.map((l) => l.text).join(' / '));
    };
    expect(cut(0.42)).toEqual(['So the plan / is to go home now.']);
    expect(cut(0.35)).toEqual(['So the plan is to go home now.']);
  });

  it('logic.questionAuxiliary switches the question-auxiliary exception', () => {
    const t = tokenizeDisplay('How did the project start?');
    expect(invertedAuxiliaryAt(t, 'en', 1)).toBe(true);
    const off: RuleSet = { ...RULESETS['1'], logic: { ...RULESETS['1'].logic, questionAuxiliary: false } };
    expect(invertedAuxiliaryAt(t, 'en', 1, off)).toBe(false);
  });
});

describe('rule set 1: main verbs and question heads may end a line', () => {
  const one = RULESETS['1'];
  /** Rule set 1 with logic.mainVerb and logic.questionHead off: the switches a later rule set may set differently. */
  const off: RuleSet = { ...one, logic: { ...one.logic, mainVerb: false, questionHead: false } };
  const at = (text: string) => tokenizeDisplay(text);
  /** A proposal check of `text` (words 0.3 s apart, no hesitations) in the vertical profile. */
  const readability = (text: string, ruleset: RuleSet) => {
    const texts = at(text);
    const ctx: SplitContext = {
      texts, starts: texts.map((_, k) => k * 0.3), ends: texts.map((_, k) => k * 0.3 + 0.25), keep: noBreakAfter(texts, 'en', []),
      lang: 'en', rules: DEFAULT_PROFILES.vertical.rules, ruleset,
    };
    return { ctx, blockStart: 0, blockEnd: texts.length - 1 };
  };

  it('an auxiliary between a subject pronoun and an article or possessive is the main verb', () => {
    expect(mainVerbAt(at('You have your robotics, and'), 'en', 1, one)).toBe(true);
    expect(mainVerbAt(at('so we did the work'), 'en', 2, one)).toBe(true);
    expect(mainVerbAt(at('and they are the best'), 'en', 2, one)).toBe(true);
    // an auxiliary before a verb, a question that opens with it, or a noun subject: still an auxiliary
    expect(mainVerbAt(at('I have been there'), 'en', 1, one)).toBe(false);
    expect(mainVerbAt(at('Did the project start?'), 'en', 0, one)).toBe(false);
    expect(mainVerbAt(at('the robots have their own'), 'en', 2, one)).toBe(false);
    expect(mainVerbAt(at('You have your robotics, and'), 'en', 1, off)).toBe(false);
  });

  it('a subject pronoun after a question-opening auxiliary closes the question head', () => {
    expect(questionHeadAt(at("Why don't you just admit it?"), 'en', 2, one)).toBe(true);
    expect(questionHeadAt(at('Fine. Can you tell me more?'), 'en', 2, one)).toBe(true);
    expect(questionHeadAt(at('And where are we going?'), 'en', 3, one)).toBe(true);
    // not a clause word or demonstrative, not an auxiliary inside a clause, not without the switch
    expect(questionHeadAt(at('Do what you want.'), 'en', 1, one)).toBe(false);
    expect(questionHeadAt(at('Is that car yours?'), 'en', 1, one)).toBe(false);
    expect(questionHeadAt(at('They said we have you covered.'), 'en', 3, one)).toBe(false);
    expect(questionHeadAt(at("Why don't you just admit it?"), 'en', 2, off)).toBe(false);
  });

  it('breakCost and the proposal check drop the penalty only there', () => {
    const t = at("You have your robotics, and why don't you just admit it?");
    const keep = noBreakAfter(t, 'en', []);
    const cost = (i: number, rs: RuleSet) => breakCost({ texts: t, keep, lang: 'en', ruleset: rs }, i);
    expect(cost(1, off)).toBeGreaterThanOrEqual(off.breaks.noLineEnd);
    expect(cost(1, one)).toBe(one.breaks.other);
    expect(cost(2, one)).toBeGreaterThanOrEqual(one.breaks.noLineEnd);
    expect(cost(7, off)).toBeGreaterThan(off.breaks.other);
    expect(cost(7, one)).toBe(one.breaks.other);
    const robotics = 'You have your robotics, and so on.';
    expect(breakRule(1, 0, false, readability(robotics, off))).toBe('lineEnd');
    expect(breakRule(1, 0, false, readability(robotics, one))).toBeUndefined();
    expect(breakRule(2, 0, false, readability(robotics, one))).toBe('lineEnd');
    const going = 'Where are we going after this?';
    expect(breakRule(2, 0, false, readability(going, off))).toBe('pronounEnd');
    expect(breakRule(2, 0, false, readability(going, one))).toBeUndefined();
  });
});

describe('"rules" in overtone.config.json and --rules', () => {
  it('validates the field', () => {
    expect(validateFileConfig({ rules: '1' }).rules).toBe('1');
    expect(() => validateFileConfig({ rules: 1 })).toThrow(/"rules" must be a string/);
  });

  it('defaults to the latest rule set; the file pins one and the flag wins; unknown ids fail', async () => {
    expect((await resolveConfig({}, {}, dirs)).ruleset.id).toBe(LATEST);
    expect((await resolveConfig({}, { rules: 'latest' }, dirs)).ruleset.id).toBe(LATEST);
    expect((await resolveConfig({}, { rules: '1' }, dirs)).ruleset).toBe(RULESETS['1']);
    expect((await resolveConfig({ rules: '1' }, { rules: 'nope' }, dirs)).ruleset.id).toBe('1');
    await expect(resolveConfig({}, { rules: '9' }, dirs)).rejects.toThrow(/Unknown rule set "9" in the config file \("rules"\); available: 1/);
    await expect(resolveConfig({ rules: '9' }, {}, dirs)).rejects.toThrow(/Unknown rule set "9" in --rules/);
  });

  it('takes the profiles and the styling budget from the rule set; profileRules and styling still apply on top', async () => {
    const cfg = await resolveConfig({}, { rules: '1', profileRules: { vertical: { rules: { maxCharsPerLine: 30 } } }, styling: { maxKeyPerCue: 2 } }, dirs);
    expect(cfg.profiles[0]).toEqual({ id: 'horizontal', ...RULESETS['1'].profiles.horizontal });
    expect(cfg.profiles[1].rules).toEqual({ ...RULESETS['1'].profiles.vertical.rules, maxCharsPerLine: 30 });
    expect(cfg.styling).toEqual({ ...RULESETS['1'].styling, maxKeyPerCue: 2 });
  });

  it('parses --rules on transcribe and recut', async () => {
    const parse = async (command: string, args: string[]) => {
      const program = buildProgram(memoryLogger(), { cwd: '/nonexistent' });
      await program.parseAsync([command, 'missing.file', ...args], { from: 'user' });
      return program.commands.find((c) => c.name() === command)!.opts<CliFlags>();
    };
    expect((await parse('transcribe', ['--rules', '1'])).rules).toBe('1');
    expect((await parse('recut', ['--rules', 'latest'])).rules).toBe('latest');
  });

  it('recut records meta.rules and the language data fingerprint, and refuses an unknown rule set', async () => {
    const dir = await tempDir('overtone-rules-');
    await writeFile(join(dir, 'talk.srt'), await readFile(join(SUBTITLES, 'talk.srt')));
    expect(await runRecut('talk.srt', { rules: '1', export: 'json' }, memoryLogger(), dir)).toBe(0);
    const doc = JSON.parse(await readFile(join(dir, 'talk.overtone.json'), 'utf8')) as OvertoneDocument;
    expect(doc.meta).toMatchObject({ rules: '1', languageData: languageDataHash('en'), linebreaks: 'rules' });
    await expect(runRecut('talk.srt', { rules: '0', export: 'json' }, memoryLogger(), dir)).rejects.toThrow(/Unknown rule set "0"/);
  });
});

describe('overtone init', () => {
  it('writes a valid config with the latest rule set pinned, the default models and the current profiles', async () => {
    const dir = await tempDir('overtone-init-');
    const log = memoryLogger();
    expect(await runInit({}, log, dir)).toBe(0);
    const file = join(dir, 'overtone.config.json');
    expect(log.lines).toContain(`out: ${file}`);
    const written = JSON.parse(await readFile(file, 'utf8'));
    expect(written).toEqual(initConfig());
    expect(validateFileConfig(written)).toBeTruthy();
    expect(written.rules).toBe(LATEST);
    expect(written.llm).toBe(INIT_MODELS.llm);
    // OpenAI lists no dated id for gpt-6.1-sol: the default model, named
    expect(written.llm).toBe('openai:gpt-6.1-sol');
    expect(written.llmLinebreaks).toBe(false);
    // profiles are not pinned: a pinned list would turn off the media's own profile
    expect(written).not.toHaveProperty('profiles');
    expect(written.profileRules.horizontal.aspect).toBe('16:9');
    expect(written.$comment.length).toBeGreaterThan(0);
    // resolving it gives the defaults
    const pinned = await resolveConfig({}, validateFileConfig(written), { cwd: dir, configDir: dir });
    const defaults = await resolveConfig({}, {}, { cwd: dir, configDir: dir });
    expect(pinned.profiles).toEqual(defaults.profiles);
    expect(pinned.ruleset).toBe(defaults.ruleset);
    expect(pinned.llmLinebreaks).toBe(defaults.llmLinebreaks);
    expect(pinned.timing.id).toBe(defaults.timing.id);
    // the default text model, named (no dated id is known for it)
    expect(written.text).toBe('openai:gpt-transcribe');
  });

  it('refuses to overwrite an existing file unless --force', async () => {
    const dir = await tempDir('overtone-init-');
    await writeFile(join(dir, 'overtone.config.json'), '{ "llm": "anthropic" }\n');
    await expect(runInit({}, memoryLogger(), dir)).rejects.toThrow(/already exists; use --force to overwrite it/);
    expect(await readFile(join(dir, 'overtone.config.json'), 'utf8')).toBe('{ "llm": "anthropic" }\n');
    expect(await runInit({ force: true }, memoryLogger(), dir)).toBe(0);
    expect(JSON.parse(await readFile(join(dir, 'overtone.config.json'), 'utf8')).rules).toBe(LATEST);
  });

  it('is a command', async () => {
    const dir = await tempDir('overtone-init-');
    const log = memoryLogger();
    await buildProgram(log, { cwd: dir }).parseAsync(['init'], { from: 'user' });
    expect(process.exitCode).toBe(0);
    expect(JSON.parse(await readFile(join(dir, 'overtone.config.json'), 'utf8')).rules).toBe(LATEST);
  });
});
