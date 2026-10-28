/**
 * Rule sets are frozen: if this test fails for rule set N, your change altered it. Add a new rule set instead
 * (packages/cli/src/segment/rulesets/, see "Stable output: rule sets" in packages/cli/README.md).
 *
 * Golden outputs: fixed words → the exact cues of each rule set, per profile, stored as JSON under
 * test/fixtures/golden/rules-<id>/. A failure in only one language after a language pack edit means the pack's line-cutting
 * data changed the layout; that is allowed (documents record the pack's fingerprint in meta.languageData), but only on
 * purpose: see docs/contributing/languages.md. Then rewrite that snapshot with OVERTONE_GOLDEN_WRITE=1 npm test --
 * rulesets-golden, and say in CHANGELOG.md which language's captions change.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Cue, OvertoneDocument } from 'overtone-format';
import { describe, expect, it } from 'vitest';
import { estimateWordTimes, readRecutSource } from '../src/recut.js';
import type { BreakProposal } from '../src/segment/proposal.js';
import { buildProfile } from '../src/segment/profile.js';
import { RULESETS, type RuleSet } from '../src/segment/rulesets/index.js';
import { flattenTurns, type SpeakerWord } from '../src/turns.js';

const GOLDEN = (id: string) => resolve(import.meta.dirname, `fixtures/golden/rules-${id}`);
const SUBTITLES = resolve(import.meta.dirname, 'fixtures/subtitles');
const SAMPLE = resolve(import.meta.dirname, '../../../examples/fixtures/sample.overtone.json');
const WRITE = process.env.OVERTONE_GOLDEN_WRITE === '1';

interface Case { name: string; language: string; words: SpeakerWord[]; duration: number; proposal?: BreakProposal }

/** One readable line per cue: "start end speaker line / line". */
const show = (cues: readonly Cue[]) => cues.map((c) => `${c.start.toFixed(3)} ${c.end.toFixed(3)} ${c.speaker} ${c.lines.map((l) => l.text).join(' / ')}`);

/**
 * Words of `text` with fixed timing: 0.05 s + 0.04 s per character each, 0.08 s apart, and `pauses[k]` seconds of
 * silence after word k instead.
 */
function synthetic(text: string, pauses: Record<number, number>, speaker = 'S1', start = 0.5): SpeakerWord[] {
  let t = start;
  return text.split(' ').map((w, k) => {
    const word = { text: w, start: +t.toFixed(3), end: +(t + 0.05 + 0.04 * w.length).toFixed(3), speaker };
    t = word.end + (pauses[k] ?? 0.08);
    return word;
  });
}

const PAUSES = [0.3, 0.45, 0.55, 0.8, 1.2];

/**
 * Tears of Steel (CC BY 3.0, Blender Foundation), 24.5–34.4 s, as transcribed and timed in
 * examples/output/tears-of-steel: two 9:16 lines too long for one row, "You have your robotics," and "Why don't you
 * just admit". Without logic.mainVerb and logic.questionHead they are cut "You / have your robotics," and "Why
 * don't / you just admit".
 */
const BRIDGE: Array<[string, number, number, string]> = [
  ['Look,', 24.49, 24.81, 'S3'], ['Celia,', 24.81, 25.29, 'S3'], ['we', 25.37, 25.45, 'S3'], ['have', 25.45, 25.69, 'S3'],
  ['to', 25.69, 25.81, 'S3'], ['follow', 25.81, 26.17, 'S3'], ['our', 26.17, 26.33, 'S3'], ['passions.', 26.33, 27.01, 'S3'],
  ['You', 27.29, 27.49, 'S3'], ['have', 27.49, 27.61, 'S3'], ['your', 27.61, 27.77, 'S3'], ['robotics,', 27.77, 28.29, 'S3'],
  ['and', 28.29, 28.45, 'S3'], ['I', 28.45, 28.5, 'S3'], ['just', 28.5, 28.65, 'S3'], ['want', 28.65, 28.81, 'S3'],
  ['to', 28.81, 28.89, 'S3'], ['be', 28.89, 29.05, 'S3'], ['awesome', 29.13, 29.53, 'S3'], ['in', 29.53, 29.65, 'S3'],
  ['space.', 29.65, 30.17, 'S3'], ['Why', 30.65, 30.77, 'S2'], ["don't", 30.97, 31.13, 'S2'], ['you', 31.13, 31.21, 'S2'],
  ['just', 31.21, 31.49, 'S2'], ['admit', 31.57, 31.89, 'S2'], ['that', 31.89, 32.01, 'S2'], ["you're", 32.01, 32.33, 'S2'],
  ['freaked', 32.57, 33.05, 'S2'], ['out', 33.05, 33.13, 'S2'], ['by', 33.25, 33.37, 'S2'], ['my', 33.37, 33.53, 'S2'],
  ['robot', 33.53, 33.97, 'S2'], ['hand?', 34.01, 34.41, 'S2'],
];
const BRIDGE_WORDS: SpeakerWord[] = BRIDGE.map(([text, start, end, speaker]) => ({ text, start, end, speaker }));
const SENTENCE = 'I think that we should go to the station before the train leaves, and then we can find the others.';

async function cases(): Promise<Case[]> {
  const out: Case[] = [];
  for (const file of ['talk.srt', 'interview.vtt']) {
    const source = await readRecutSource(join(SUBTITLES, file), file);
    if (source.kind === 'overtone') throw new Error('expected subtitles');
    const words = estimateWordTimes(source.parsed.cues);
    out.push({ name: file.replace('.', '-'), language: 'en', words, duration: words.at(-1)!.end });
  }
  const sample = JSON.parse(readFileSync(SAMPLE, 'utf8')) as OvertoneDocument;
  const sampleWords = flattenTurns(sample.turns);
  out.push({ name: 'sample', language: sample.language, words: sampleWords, duration: sample.duration });
  // a fixed LLM proposal on the sample: a cue every 6 words, a line break 3 words in (the merge keeps or repairs them)
  const cueStarts = sampleWords.map((_, k) => k).filter((k) => k % 6 === 0);
  out.push({ name: 'sample-proposal', language: sample.language, words: sampleWords, duration: sample.duration, proposal: { cueStarts, lineStarts: cueStarts.map((k) => k + 3) } });
  // one pause of each length after "to" (a preposition) and after "leaves," (a clause end)
  for (const p of PAUSES) {
    const words = synthetic(SENTENCE, { 6: p, 12: p });
    out.push({ name: `pause-${p.toFixed(2)}`, language: 'en', words, duration: words.at(-1)!.end + 1 });
  }
  // every pause length in one block, two speakers, and Dutch
  const mixed = [
    ...synthetic('Well, so the thing is that we never really planned for this kind of growth in the first place.', { 1: 0.45, 4: 0.3, 9: 0.55, 13: 0.8 }),
    ...synthetic('Right. And what did you do when it happened?', { 0: 0.45, 4: 1.2 }, 'S2', 9),
    ...synthetic('We hired three people, then the servers went down, and we had to start over again.', { 3: 1.2, 7: 0.3, 10: 0.55, 13: 0.45 }, 'S1', 13),
  ];
  out.push({ name: 'mixed-en', language: 'en', words: mixed, duration: mixed.at(-1)!.end + 1 });
  const nl = synthetic('Ik denk dat we eerst naar het station moeten gaan, en daarna kunnen we de anderen zoeken in de stad.', { 2: 0.45, 5: 0.3, 7: 0.55, 9: 0.8, 13: 1.2 });
  out.push({ name: 'mixed-nl', language: 'nl', words: nl, duration: nl.at(-1)!.end + 1 });
  out.push({ name: 'tears-of-steel-bridge', language: 'en', words: BRIDGE_WORDS, duration: 35 });
  return out;
}

const all = await cases();

describe.each(Object.values(RULESETS).map((rs) => [rs.id, rs] as const))('rule set %s (frozen): golden outputs', (rulesId, ruleset) => {
  it.each(all.map((c) => [c.name, c] as const))('%s', (name, c) => {
    const actual: Record<string, unknown> = { language: c.language };
    for (const [id, p] of Object.entries(ruleset.profiles)) {
      const built = buildProfile(c.words, { id, ...p }, { language: c.language, glossary: [], duration: c.duration, ruleset, ...(c.proposal ? { proposal: c.proposal } : {}) });
      actual[id] = show(built.profile.cues);
    }
    const file = join(GOLDEN(rulesId), `${name}.json`);
    if (WRITE) {
      mkdirSync(GOLDEN(rulesId), { recursive: true });
      writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(existsSync(file), `missing golden file ${file}`).toBe(true);
    expect(actual).toEqual(JSON.parse(readFileSync(file, 'utf8')));
  });
});

it('the golden cases cover every pause length around the 0.4 s floor and the 1 s cue rule', () => {
  expect(all.map((c) => c.name)).toEqual(expect.arrayContaining(PAUSES.map((p) => `pause-${p.toFixed(2)}`)));
});

describe('Tears of Steel in 9:16: lines too long for one row break where the sentence does', () => {
  const vertical = (rs: RuleSet) => {
    const built = buildProfile(BRIDGE_WORDS, { id: 'vertical', ...rs.profiles.vertical }, { language: 'en', glossary: [], duration: 35, ruleset: rs });
    return built.profile.cues.map((c) => c.lines.map((l) => l.text).join(' / '));
  };

  it('rule set 1 ends the line on a main-verb "have" and on the subject of the question head', () => {
    const cues = vertical(RULESETS['1']);
    expect(cues).toEqual(expect.arrayContaining(['You have / your robotics,', "Why don't you / just admit"]));
    expect(cues.filter((c) => /^\S+ \//.test(c))).toEqual([]);
  });

  it('without logic.mainVerb and logic.questionHead a lone word or two stays on the top line', () => {
    const rs = RULESETS['1'];
    const off: RuleSet = { ...rs, logic: { ...rs.logic, mainVerb: false, questionHead: false } };
    expect(vertical(off)).toEqual(expect.arrayContaining(['You / have your robotics,', "Why don't / you just admit"]));
  });
});
