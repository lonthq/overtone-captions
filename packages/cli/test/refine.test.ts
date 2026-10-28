import { DEFAULT_PROFILES, validate, type OvertoneDocument } from 'overtone-format';
import { describe, expect, it } from 'vitest';
import { memoryLogger } from '../src/log.js';
import type { LlmProvider, LlmRequest } from '../src/providers/types.js';
import { assertSupportedSchema } from '../src/providers/structured.js';
import { refine, type RefineOptions } from '../src/refine/llm-steps.js';
import { CORRECTIONS_SCHEMA, LINEBREAKS_SCHEMA, STYLING_SCHEMA } from '../src/refine/schemas.js';
import { correctionsPrompt, linebreaksPrompt, renderWords, stylingPrompt } from '../src/refine/prompts.js';
import { tokenizeDisplay } from '../src/text/normalize.js';
import { groupTurns, type SpeakerWord } from '../src/turns.js';

function speak(text: string, speaker: string, start: number): SpeakerWord[] {
  return tokenizeDisplay(text).map((t, k) => ({ text: t, start: +(start + k * 0.4).toFixed(3), end: +(start + k * 0.4 + 0.35).toFixed(3), speaker, match: 'exact', confidence: 1 }));
}
const WORDS: SpeakerWord[] = [
  ...speak('Every year, one in five drivers has some kind of car damage.', 'S1', 0),
  ...speak('With Drive Cover from Lamora, you’re insured from day one, for just twelve euros a month.', 'S1', 5),
  ...speak('And the best part? You can claim directly in the app.', 'S2', 12),
];
WORDS[13].match = 'fuzzy';

/** A fake LLM answering by schema name; records every request. */
function fakeLlm(answers: Record<string, (req: LlmRequest) => unknown>): LlmProvider & { requests: LlmRequest[] } {
  const requests: LlmRequest[] = [];
  return {
    id: 'fake',
    requests,
    async complete<T>(req: LlmRequest): Promise<T> {
      requests.push(req);
      const a = answers[req.name];
      if (!a) throw new Error(`no answer for ${req.name}`);
      return a(req) as T;
    },
  };
}

const OPTS: RefineOptions = {
  context: 'Lumora Insurance ad for DriveCover',
  glossary: ['DriveCover', 'Lumora'],
  style: { numbers: 'digits', currency: 'symbol' },
  language: 'en',
  pinnedSpeakers: { S2: 'Tom' },
  edits: { maxSpan: 6 },
  styling: { maxStyledRatio: 0.15, maxKeyPerCue: 1 },
  profiles: [{ id: 'horizontal', ...DEFAULT_PROFILES.horizontal }, { id: 'vertical', ...DEFAULT_PROFILES.vertical }],
  duration: 18,
};

describe('prompts', () => {
  it('renders numbered words per speaker run with uncertainty marks and context lines', () => {
    const text = renderWords(WORDS, { first: 10, last: 15, ownFirst: 12, ownLast: 15 });
    expect(text).toBe('(context) [S1 @4.0s] 10:car 11:damage.\n[S1 @5.0s] 12:With *13:Drive 14:Cover 15:from');
  });

  it('puts context, glossary, style and speakers in the corrections prompt', () => {
    const { user: task, system: shared } = correctionsPrompt({ ...OPTS, maxSpan: 6, maxStyledRatio: 0.15 }, WORDS, { first: 0, last: 5, ownFirst: 0, ownLast: 5 }, ['S1']);
    expect(task).toMatch(/at most 6 words/);
    expect(shared).toContain('What this media is about: Lumora Insurance ad for DriveCover');
    expect(shared).toContain('Glossary (correct spellings of names and terms): DriveCover; Lumora');
    expect(shared).toContain('Write numbers as digits');
    expect(shared).toContain('Write money with the currency symbol');
    expect(task).toContain('Speaker ids: S1');
  });
});

describe('prompt instructions', () => {
  const P = { ...OPTS, maxSpan: 6, maxStyledRatio: 0.15 };
  const WIN = { first: 0, last: 5, ownFirst: 0, ownLast: 5 };

  it('5a: fix what was misheard, keep what was said; fillers merged; small edits; sure and note; clear speaker labels only', () => {
    const { user: task } = correctionsPrompt(P, WORDS, WIN, ['S1']);
    expect(task).toMatch(/correct what the speech recognition got wrong/);
    for (const k of ['spelling', 'casing', 'punctuation', 'glossary', 'split or merged', 'style settings', 'homophones']) expect(task).toContain(k);
    expect(task).toMatch(/Fix what was misheard, also a name, a number or a negation/);
    expect(task).toMatch(/Keep what was said: never paraphrase, summarize, reorder, add or drop content/);
    expect(task).not.toMatch(/Never change the meaning/);
    expect(task).toMatch(/Fillers \(uh, um, er\) are not content/);
    expect(task).toMatch(/merge it into an edit of a neighbouring word: words "uh think" → to "think", reason "correction"/);
    expect(task).toMatch(/A glossary edit replaces only the misheard words with the term; put any other fix in a separate edit/);
    expect(task).toMatch(/never empty/);
    expect(task).toMatch(/at most 6 words/);
    expect(task).toMatch(/sure: true when .* false when it is a plausible guess/);
    expect(task).toMatch(/only when the transcript or the context makes it clear; otherwise label = the id unchanged/);
    expect(task).not.toMatch(/timestamp/i);
  });

  it('5b: semantic classes with meanings, sparing because the budget is enforced', () => {
    const { user: task } = stylingPrompt(P, WORDS, WIN);
    for (const c of ['"emphasis" =', '"key" =', '"brand" =', '"number" =', '"soft" =']) expect(task).toContain(c);
    expect(task).toMatch(/Use only these classes/);
    expect(task).toMatch(/"key" = a short phrase of at most 4 words that the viewer should remember/);
    expect(task).toMatch(/at most one per sentence, never a whole clause/);
    expect(task).toMatch(/at most 0 styled words in this part/); // 6 owned words × 15 %
    expect(stylingPrompt(P, WORDS, { first: 0, last: 38, ownFirst: 0, ownLast: 38 }).user).toMatch(/at most 5 styled words in this part/);
    expect(task).toMatch(/"brand" = the name of a brand, product, company or organization/);
    expect(task).not.toMatch(/"brand" = glossary terms/);
    expect(task).toMatch(/Usually one class per range; combine only "key" with another class/);
    expect(task).toMatch(/budget is enforced in code/);
    expect(task).toMatch(/prioritise/);
  });

  it('5b: "brand" is never a person or a place; the speakers are listed as people', () => {
    const { user: task, system: shared } = stylingPrompt(P, WORDS, WIN, ['Allard Beutel', 'Jim Dutton']);
    expect(task).toMatch(/Never use "brand" for the name of a person \(also when the name is in the glossary or is a speaker\), a place/);
    expect(task).toMatch(/The glossary only gives correct spellings: it can list people and places too/);
    expect(task).toContain('People in this media (never "brand"): Allard Beutel; Jim Dutton');
    // the glossary is still offered as correct spellings
    expect(shared).toContain('Glossary (correct spellings of names and terms): DriveCover; Lumora');
    expect(stylingPrompt(P, WORDS, WIN).user).not.toContain('People in this media');
  });

  it('every step of a window gets the same shared prompt (prompt caching); the task follows it', () => {
    const shared = correctionsPrompt(P, WORDS, WIN, ['S1']).system;
    expect(shared).toContain('Style settings:');
    expect(shared).toMatch(/Transcript:\n\[S1 @0\.0s\] 0:Every/);
    expect(stylingPrompt(P, WORDS, WIN).system).toBe(shared);
    expect(linebreaksPrompt(P, WORDS, WIN, OPTS.profiles[1]).system).toBe(shared);
    expect(linebreaksPrompt(P, WORDS, WIN, OPTS.profiles[0]).system).toBe(shared);
    for (const task of [correctionsPrompt(P, WORDS, WIN, ['S1']).user, stylingPrompt(P, WORDS, WIN).user]) expect(task).toMatch(/^Task: /);
    expect(shared).not.toContain('Task:');
  });

  it('lists inferred names and terms as unverified hints, apart from the glossary', () => {
    const shared = stylingPrompt({ ...P, inferredTerms: ['Jim Dutton', 'STS-124'] }, WORDS, WIN).system;
    expect(shared).toContain('Names and terms that probably occur (inferred from the transcript, not verified): Jim Dutton; STS-124');
    expect(shared).toContain('Glossary (correct spellings of names and terms): DriveCover; Lumora');
  });

  it('5c: pauses are marked and must end a caption', () => {
    const ws = [...speak('Hello there.', 'S1', 0), ...speak('Next part.', 'S1', 3)];
    const all = { first: 0, last: 3, ownFirst: 0, ownLast: 3 };
    const { user: task, system: shared } = linebreaksPrompt(P, ws, all, OPTS.profiles[1]);
    expect(shared).toContain('[S1 @0.0s] 0:Hello 1:there. ‖ 2:Next 3:part.');
    expect(task).toContain('A caption must end at every ‖ (a pause).');
    expect(renderWords(ws, all)).not.toContain('‖');
  });

  it('5c: hesitations of 0.4–1.5 s (rule set 1) are marked with their length, apart from the long pauses', () => {
    const at = (text: string, start: number) => speak(text, 'S1', start);
    // gaps after "one" 0.45 s, "two" 0.75 s, "three" 1.15 s, "four" 1.65 s; none across a speaker change
    const ws = [...at('One', 0), ...at('two', 0.8), ...at('three', 1.9), ...at('four', 3.4), ...at('five', 5.4), ...speak('Six', 'S2', 6.0)];
    const all = { first: 0, last: 5, ownFirst: 0, ownLast: 5 };
    const { user: task, system: shared } = linebreaksPrompt(P, ws, all, OPTS.profiles[1]);
    expect(shared).toContain('0:One ·0.4s 1:two ·0.7s 2:three ·1.1s 3:four ‖ 4:five\n[S2 @6.0s] 5:Six');
    // below the 0.4 s floor: no mark
    const short = [...at('One', 0), ...at('two', 0.7)];
    expect(linebreaksPrompt(P, short, { first: 0, last: 1, ownFirst: 0, ownLast: 1 }, OPTS.profiles[1]).system).toContain('0:One 1:two');
    expect(shared).toContain('" ‖" after a word marks a long pause, " ·0.7s" a shorter one (here 0.7 s).');
    expect(task).toContain('A "·" mark (e.g. "·0.7s") is a hesitation: break the line or caption there when it helps show the hesitation, even after a short word');
    expect(task).toContain('at 1 s or more prefer ending the caption, and never hide it inside a line.');
    expect(renderWords(ws, all)).not.toContain('·');
  });

  it('5c: natural breaks, no split groups, the profile limits', () => {
    const { user: task, system: shared } = linebreaksPrompt(P, WORDS, WIN, OPTS.profiles[1]);
    expect(task).toContain('about 3–4 words');
    expect(task).toContain('at most 2 lines per caption, so at most 44 characters (about 6–8 words) per caption');
    expect(task).toMatch(/cutting more often gives the viewer no extra reading time \(speech often runs faster than the 15 characters per second/);
    expect(task).toMatch(/fill each caption up to the limit unless a sentence ends, the speaker pauses \(‖\)/);
    expect(task).toContain('Avoid captions of only 1–3 words.');
    expect(task).not.toContain('cut more often.');
    expect(task).not.toMatch(/captions of at least/);
    expect(task).toMatch(/Never end a line or caption on an article/);
    expect(task).toMatch(/Avoid ending one on a subject pronoun or relative word \(I, we, you, they, who, what, which, that\)/);
    expect(task).toMatch(/Keep adjectives with their nouns \("an operational pilot"/);
    expect(task).toMatch(/Never put a single word on a line of its own, except a short interjection/);
    expect(task).toMatch(/Never start a new sentence in the last word or two of a line or caption/);
    expect(task).toMatch(/Use one line when the caption fits on one line/);
    expect(task).toMatch(/When a caption has no good line break, move its boundaries instead/);
    expect(task).toMatch(/the first word that is not on a \(context\) line always starts a caption/);
    expect(task).toMatch(/marks where speaker S1 starts talking/);
    expect(task).toContain('"vertical" display (Phone)');
    expect(task).toMatch(/natural phrase and clause boundaries/);
    expect(task).toMatch(/Never split names, number groups .* or glossary terms/);
    expect(task).toContain('at most 22 characters per line');
    expect(task).toContain('at most 2 lines per caption');
    expect(shared).toContain('Glossary (correct spellings of names and terms): DriveCover; Lumora');
    expect(task).not.toMatch(/timestamp/i);
  });
});

describe('schemas', () => {
  /** Every object: additionalProperties false and every property required (OpenAI strict mode, Anthropic). */
  function strictIssues(schema: Record<string, unknown>, path = '$'): string[] {
    const out: string[] = [];
    if (schema.type === 'object') {
      const props = Object.keys((schema.properties as object) ?? {});
      if (schema.additionalProperties !== false) out.push(`${path}: additionalProperties`);
      if (JSON.stringify([...((schema.required as string[]) ?? [])].sort()) !== JSON.stringify([...props].sort())) out.push(`${path}: required`);
      for (const [k, v] of Object.entries((schema.properties as Record<string, Record<string, unknown>>) ?? {})) out.push(...strictIssues(v, `${path}.${k}`));
    }
    if (schema.items) out.push(...strictIssues(schema.items as Record<string, unknown>, `${path}[]`));
    return out;
  }

  it('are strict-mode compatible and use only keywords the validator checks', () => {
    for (const schema of [CORRECTIONS_SCHEMA, STYLING_SCHEMA, LINEBREAKS_SCHEMA]) {
      expect(strictIssues(schema)).toEqual([]);
      expect(() => assertSupportedSchema(schema)).not.toThrow();
    }
  });
});

describe('refine', () => {
  const llm = () =>
    fakeLlm({
      corrections: () => ({
        edits: [
          { first: 13, last: 14, to: 'DriveCover', reason: 'brand' },
          { first: 16, last: 16, to: 'Lumora,', reason: 'brand' },
          { first: 24, last: 25, to: '€12', reason: 'style' },
          { first: 0, last: 9, to: 'Banana', reason: 'correction' },
        ],
        speakers: [{ id: 'S1', label: 'Maya', role: 'host' }, { id: 'S2', label: 'Guest', role: '' }],
      }),
      styling: () => ({
        styles: [
          { first: 13, last: 13, classes: ['brand'] },
          { first: 15, last: 15, classes: ['brand'] },
          { first: 23, last: 25, classes: ['number', 'key'] },
          { first: 2, last: 4, classes: ['key'] },
        ],
      }),
      'linebreaks-horizontal': () => ({ cueStarts: [0, 12, 21, 26], lineStarts: [6, 16, 30] }),
      'linebreaks-vertical': () => ({ cueStarts: [0], lineStarts: [] }),
    });

  it('shows the editor what the timing side heard, and lists an edit it is not sure about', async () => {
    // "kind" (word 8) was heard as "kite"
    const fake = fakeLlm({
      corrections: () => ({ edits: [{ first: 8, last: 8, to: 'kite', reason: 'correction', sure: false, note: 'the timing engine heard kite' }], speakers: [] }),
      styling: () => ({ styles: [] }),
      'linebreaks-horizontal': () => ({ cueStarts: [], lineStarts: [] }),
    });
    const heard = WORDS.map((w, k) => ({ text: k === 8 ? 'kite' : w.text, first: k, last: k }));
    const res = await refine(fake, WORDS, { ...OPTS, edits: { maxSpan: 6 }, profiles: [OPTS.profiles[0]], heard }, memoryLogger());
    expect(fake.requests.find((r) => r.name === 'corrections')!.user).toContain('8: kind → kite');
    expect(res.edits).toEqual([{ words: [8, 8], from: 'kind', to: 'kite', reason: 'correction' }]);
    expect(res.unsure.map((u) => [u.from, u.edit.to, u.edit.note])).toEqual([['kind', 'kite', 'the timing engine heard kite']]);
  });

  it('applies edits, labels speakers, styles words and cuts both profiles', async () => {
    const fake = llm();
    const log = memoryLogger();
    // the label "Maya" needs the user's context (or the transcript) to have the name
    const res = await refine(fake, WORDS, { ...OPTS, context: `${OPTS.context!}, hosted by Maya` }, log);
    const text = res.words.map((w) => w.text).join(' ');
    expect(text).toContain('With DriveCover from Lumora, you’re insured from day one, for just €12 a month.');
    expect(res.edits.map((e) => [e.from, e.to, e.reason])).toEqual([
      ['Drive Cover', 'DriveCover', 'brand'],
      ['Lamora,', 'Lumora,', 'brand'],
      ['twelve euros', '€12', 'style'],
    ]);
    expect(res.rejected).toHaveLength(1);
    expect(log.lines).toEqual([expect.stringMatching(/^warn: rejected edit \[0, 9\] "Every .*" → "Banana" \(correction\): span of 10 words exceeds the maximum of 6/)]);
    expect(res.speakers).toEqual([{ id: 'S1', label: 'Maya', role: 'host' }, { id: 'S2', label: 'Tom' }]);
    expect(res.words[13]).toMatchObject({ text: 'DriveCover', match: 'edited', classes: ['brand'] });
    expect(res.profiles.map((p) => p.id)).toEqual(['horizontal', 'vertical']);
    expect(res.cutting).toEqual([
      { profile: 'horizontal', blocks: 2, fromProposal: 2, proposalCues: 4, repairedCues: 0 },
      { profile: 'vertical', blocks: 2, fromProposal: 0, proposalCues: 0, repairedCues: res.profiles[1].cues.length },
    ]);
    expect(fake.requests.map((r) => r.name)).toEqual(['corrections', 'styling', 'linebreaks-horizontal', 'linebreaks-vertical']);
    // single names and roles are not listed as people (see the next test)
    expect(fake.requests[1].user).not.toContain('People in this media');

    const doc: OvertoneDocument = { format: 'overtone', version: 1, language: 'en', duration: 18, speakers: res.speakers, turns: groupTurns(res.words), profiles: res.profiles, edits: res.edits };
    expect(validate(doc)).toEqual({ valid: true, errors: [] });
  });

  it('lists the speakers whose labels are personal names as people in the 5b prompt, not roles', async () => {
    const answers = {
      corrections: () => ({ edits: [], speakers: [{ id: 'S1', label: 'Maya Jones (Lumora)', role: 'host' }, { id: 'S2', label: 'NASA Commentator', role: '' }] }),
      styling: () => ({ styles: [] }),
      'linebreaks-horizontal': () => ({ cueStarts: [], lineStarts: [] }),
      'linebreaks-vertical': () => ({ cueStarts: [], lineStarts: [] }),
    };
    const fake = fakeLlm(answers);
    await refine(fake, WORDS, { ...OPTS, context: `${OPTS.context!}, with Maya Jones`, pinnedSpeakers: {} }, memoryLogger());
    expect(fake.requests[1].user).toContain('People in this media (never "brand"): Maya Jones\n');
  });

  it('logs per profile which rules rejected proposed cues, at debug level only', async () => {
    const log = memoryLogger({ debug: true });
    await refine(llm(), WORDS, OPTS, log);
    const debug = log.lines.filter((l) => l.startsWith('debug: '));
    expect(debug[0]).toBe('debug: horizontal: 4/4 proposed cues used; rejected by rule: none; blocks cut deterministically for reading speed: 0');
    expect(debug.find((l) => l.startsWith('debug: vertical:'))).toMatch(/^debug: vertical: 0\/2 proposed cues used; rejected by rule: maxCharsPerLine 2[;,]/);
    expect(debug).toContainEqual(expect.stringMatching(/^debug: {3}maxCharsPerLine: "Every year, one in five drivers .*" \(\d+ chars: /));
    const quiet = memoryLogger();
    await refine(llm(), WORDS, OPTS, quiet);
    expect(quiet.lines.filter((l) => l.startsWith('debug:'))).toEqual([]);
  });

  it('keeps at most one key phrase per cue', async () => {
    const res = await refine(llm(), WORDS, OPTS, memoryLogger());
    for (const p of res.profiles) {
      for (const c of p.cues) {
        const ws = res.words.slice(c.lines[0].words[0], c.lines.at(-1)!.words[1] + 1);
        const starts = ws.filter((w, i) => w.classes?.includes('key') && !ws[i - 1]?.classes?.includes('key')).length;
        expect(starts).toBeLessThanOrEqual(1);
      }
    }
  });

  it('ignores edits outside the window it owns', async () => {
    const fake = fakeLlm({
      corrections: () => ({ edits: [{ first: 500, last: 500, to: 'x', reason: 'correction' }], speakers: [] }),
      styling: () => ({ styles: [] }),
      'linebreaks-horizontal': () => ({ cueStarts: [], lineStarts: [] }),
    });
    const res = await refine(fake, WORDS, { ...OPTS, profiles: [OPTS.profiles[0]] }, memoryLogger());
    expect(res.edits).toEqual([]);
    expect(res.rejected).toEqual([]);
    expect(res.speakers).toEqual([{ id: 'S1' }, { id: 'S2', label: 'Tom' }]);
  });

  it('shows an inferred topic and names to the editor', async () => {
    const answers = {
      corrections: () => ({ edits: [{ first: 16, last: 16, to: 'Lumora,', reason: 'correction' }], speakers: [] }),
      styling: () => ({ styles: [] }),
      'linebreaks-horizontal': () => ({ cueStarts: [], lineStarts: [] }),
    };
    const llm = fakeLlm(answers);
    const opts = { ...OPTS, glossary: ['DriveCover'], profiles: [OPTS.profiles[0]] };
    const inferred = await refine(llm, WORDS, { ...opts, context: undefined, inferredContext: OPTS.context, inferredTerms: ['Lumora'] }, memoryLogger());
    expect(inferred.edits.map((e) => e.to)).toEqual(['Lumora,']);
    const prompt = llm.requests.find((r) => r.name === 'corrections')!;
    expect(`${prompt.system}\n${prompt.user}`).toContain(OPTS.context!);
    expect(prompt.system).toContain('(inferred from the transcript, not verified): Lumora');
  });

  it('splits long transcripts into windows and keeps only owned results', async () => {
    const fake = fakeLlm({
      // every window proposes the same two edits: only the window that owns a range may apply it
      corrections: () => ({
        edits: [{ first: 13, last: 14, to: 'DriveCover', reason: 'brand' }, { first: 31, last: 31, to: 'part!', reason: 'punctuation' }],
        speakers: [{ id: 'S1', label: 'Maya', role: '' }, { id: 'S2', label: 'S2', role: '' }],
      }),
      styling: () => ({ styles: [] }),
      'linebreaks-horizontal': () => ({ cueStarts: [], lineStarts: [] }),
    });
    const res = await refine(fake, WORDS, { ...OPTS, context: `${OPTS.context!}, hosted by Maya`, pinnedSpeakers: {}, profiles: [OPTS.profiles[0]], windowWords: 15 }, memoryLogger());
    const calls = fake.requests.filter((r) => r.name === 'corrections');
    expect(calls.length).toBeGreaterThan(1);
    // the other windows show word 13 as read-only context
    expect(calls.filter((r) => r.system.split('\n').some((l) => l.startsWith('(context)') && l.includes(' *13:Drive ')))).toHaveLength(calls.length - 1);
    expect(res.edits.map((e) => e.to)).toEqual(['DriveCover', 'part!']);
    expect(res.rejected).toEqual([]);
    // a label equal to the id means "no label"
    expect(res.speakers).toEqual([{ id: 'S1', label: 'Maya' }, { id: 'S2' }]);
  });

  it('applies a range crossing a window boundary exactly once (in the window owning its first word)', async () => {
    const ws: SpeakerWord[] = Array.from({ length: 40 }, (_, i) => ({ text: i === 19 ? 'end.' : 'word', start: i, end: i + 0.5, speaker: 'S1' }));
    const loose = { id: 'wide', aspect: '16:9', rules: { maxCharsPerLine: 1000, maxLines: 1 } };
    const fake = fakeLlm({
      corrections: () => ({ edits: [{ first: 19, last: 20, to: 'end. Word', reason: 'punctuation' }], speakers: [] }),
      styling: () => ({ styles: [{ first: 19, last: 20, classes: ['key'] }] }),
      'linebreaks-wide': () => ({ cueStarts: [], lineStarts: [] }),
    });
    const res = await refine(fake, ws, { ...OPTS, glossary: [], pinnedSpeakers: {}, profiles: [loose], duration: 40, windowWords: 25 }, memoryLogger());
    expect(fake.requests.filter((r) => r.name === 'corrections')).toHaveLength(2);
    expect(res.edits).toEqual([{ words: [19, 20], from: 'end. word', to: 'end. Word', reason: 'punctuation' }]);
    expect(res.rejected).toEqual([]);
    expect(res.words.map((w, i) => (w.classes ? i : -1)).filter((i) => i >= 0)).toEqual([19, 20]);
    // every later window's first owned word starts a caption
    expect(res.profiles[0].cues.map((c) => c.lines[0].words[0])).toEqual([0, 20]);
    expect(res.cutting[0]).toMatchObject({ proposalCues: 2, repairedCues: 0 });
  });

  it('treats id-like labels as no label and keeps a role without a label', async () => {
    const ws = [...speak('Hi there.', 'S1', 0), ...speak('Hello.', 'S2', 2), ...speak('Welcome.', 'S3', 4), ...speak('Thanks.', 'S4', 6)];
    const fake = fakeLlm({
      corrections: () => ({
        edits: [],
        speakers: [
          { id: 'S1', label: 's1', role: 'host' },
          { id: 'S2', label: 'Speaker 2', role: '' },
          { id: 'S3', label: 'S7', role: '' },
          { id: 'S4', label: 'Anna', role: 'guest' },
        ],
      }),
      styling: () => ({ styles: [] }),
      'linebreaks-horizontal': () => ({ cueStarts: [], lineStarts: [] }),
    });
    const res = await refine(fake, ws, { ...OPTS, context: 'An interview with Anna', pinnedSpeakers: {}, profiles: [OPTS.profiles[0]], duration: 8 }, memoryLogger());
    expect(res.speakers).toEqual([{ id: 'S1', role: 'host' }, { id: 'S2' }, { id: 'S3' }, { id: 'S4', label: 'Anna', role: 'guest' }]);
  });

  it('shortens long ranges in rejected-edit warnings', async () => {
    const ws = Array.from({ length: 30 }, (_, i) => ({ text: `longword${i}`, start: i, end: i + 0.5, speaker: 'S1' }));
    const fake = fakeLlm({
      corrections: () => ({ edits: [{ first: 0, last: 29, to: 'x', reason: 'correction' }], speakers: [] }),
      styling: () => ({ styles: [] }),
      'linebreaks-horizontal': () => ({ cueStarts: [], lineStarts: [] }),
    });
    const log = memoryLogger();
    await refine(fake, ws, { ...OPTS, glossary: [], pinnedSpeakers: {}, profiles: [OPTS.profiles[0]], duration: 30 }, log);
    expect(log.lines).toHaveLength(1);
    const from = /"([^"]*)" →/.exec(log.lines[0])![1];
    expect(from.length).toBeLessThanOrEqual(80);
    expect(from).toMatch(/^longword0 longword1 .*…$/);
  });
});
