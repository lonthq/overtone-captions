import { DEFAULT_PROFILES } from 'overtone-format';
import { describe, expect, it } from 'vitest';
import { memoryLogger } from '../src/log.js';
import type { LlmProvider, LlmRequest } from '../src/providers/types.js';
import { labelObjection, labelVouchers, roleObjection } from '../src/refine/labels.js';
import { refine, type RefineOptions } from '../src/refine/llm-steps.js';
import { tokenizeDisplay } from '../src/text/normalize.js';
import type { SpeakerWord } from '../src/turns.js';

function speak(text: string, speaker: string, start: number): SpeakerWord[] {
  return tokenizeDisplay(text).map((t, k) => ({ text: t, start: +(start + k * 0.4).toFixed(3), end: +(start + k * 0.4 + 0.35).toFixed(3), speaker, match: 'exact', confidence: 1 }));
}
const WORDS: SpeakerWord[] = [...speak('Welcome back, I am Maya.', 'S1', 0), ...speak('Thanks for having me.', 'S2', 3), ...speak('So, how was the trip?', 'S3', 6)];

const OPTS: RefineOptions = {
  context: 'Interview with Tom Jansen about DriveCover',
  glossary: ['Lumora'],
  style: { numbers: 'digits', currency: 'symbol' },
  language: 'en',
  pinnedSpeakers: {},
  edits: { maxSpan: 6 },
  styling: { maxStyledRatio: 0.15, maxKeyPerCue: 1 },
  profiles: [{ id: 'horizontal', ...DEFAULT_PROFILES.horizontal }],
  llmLinebreaks: false,
  duration: 10,
};

function fakeLlm(speakers: Array<{ id: string; label: string; role: string }>): LlmProvider {
  return {
    id: 'fake',
    async complete<T>(req: LlmRequest): Promise<T> {
      if (req.name === 'corrections') return { edits: [], speakers } as T;
      if (req.name === 'styling') return { styles: [] } as T;
      return { cueStarts: [], lineStarts: [] } as T;
    },
  };
}

describe('LLM speaker labels are checked in code', () => {
  it('keeps a name from the transcript, the context or the glossary, and drops an invented one with a warning', async () => {
    const log = memoryLogger();
    const res = await refine(fakeLlm([
      { id: 'S1', label: 'Maya', role: 'host' },
      { id: 'S2', label: 'Tom Jansen', role: 'guest' },
      { id: 'S3', label: 'Peter Smith', role: '' },
    ]), WORDS, OPTS, log);
    expect(res.speakers).toEqual([{ id: 'S1', label: 'Maya', role: 'host' }, { id: 'S2', label: 'Tom Jansen', role: 'guest' }, { id: 'S3' }]);
    expect(res.rejectedLabels).toEqual([{ id: 'S3', label: 'Peter Smith', why: '"peter", "smith" is not in the transcript, context or glossary' }]);
    expect(log.lines).toContain('warn: rejected speaker label S3 "Peter Smith": "peter", "smith" is not in the transcript, context or glossary');
  });

  it('falls back to the role when the label is dropped, and keeps a label that only repeats the role', async () => {
    const res = await refine(fakeLlm([
      { id: 'S1', label: 'Host', role: 'host' },
      { id: 'S2', label: 'Anna Berg', role: 'guest' },
      { id: 'S3', label: 'Maya (interviewer)', role: 'interviewer' },
    ]), WORDS, OPTS, memoryLogger());
    expect(res.speakers).toEqual([{ id: 'S1', label: 'Host', role: 'host' }, { id: 'S2', role: 'guest' }, { id: 'S3', label: 'Maya (interviewer)', role: 'interviewer' }]);
  });

  it('does not let an inferred context vouch for a name', async () => {
    const opts = { ...OPTS, context: undefined, inferredContext: 'Interview with Anna Berg', inferredTerms: ['Anna Berg'] };
    const res = await refine(fakeLlm([{ id: 'S2', label: 'Anna Berg', role: '' }]), WORDS, opts, memoryLogger());
    expect(res.speakers.find((s) => s.id === 'S2')).toEqual({ id: 'S2' });
  });

  it('never checks a pinned label', async () => {
    const res = await refine(fakeLlm([{ id: 'S3', label: 'Peter', role: '' }]), WORDS, { ...OPTS, pinnedSpeakers: { S3: 'Zoë Q.' } }, memoryLogger());
    expect(res.speakers.find((s) => s.id === 'S3')).toEqual({ id: 'S3', label: 'Zoë Q.' });
    expect(res.rejectedLabels).toEqual([]);
  });

  it('drops a label or a role that is too long', async () => {
    const long = 'Maya '.repeat(12).trim();
    const res = await refine(fakeLlm([{ id: 'S1', label: long, role: 'the host of this long running weekly podcast about cars' }]), WORDS, OPTS, memoryLogger());
    expect(res.speakers.find((s) => s.id === 'S1')).toEqual({ id: 'S1' });
  });

  it('accepts a glossary term written as two words', () => {
    const known = labelVouchers(['Hello there.'], ['DriveCover'], 'en');
    expect(labelObjection('Drive Cover', '', known, 'en')).toBeNull();
    expect(labelObjection('DriveCover Team', '', known, 'en')).toMatch(/"team" is not in/);
  });
});

describe('speaker roles are checked in code too', () => {
  it('does not let a role vouch for a name it invents, and drops that role with a warning', async () => {
    const log = memoryLogger();
    const res = await refine(fakeLlm([
      { id: 'S1', label: 'Barack Obama', role: 'Barack Obama' },
      { id: 'S2', label: 'S2', role: 'Barack Obama' },
      { id: 'S3', label: 'Host', role: 'Host' },
    ]), WORDS, OPTS, log);
    expect(res.speakers).toEqual([{ id: 'S1' }, { id: 'S2' }, { id: 'S3', label: 'Host', role: 'Host' }]);
    expect(res.rejectedLabels.map((r) => r.id)).toEqual(['S1']);
    expect(res.rejectedRoles).toEqual([
      { id: 'S1', role: 'Barack Obama', why: '"barack", "obama" is not in the transcript, context or glossary, nor a role word' },
      { id: 'S2', role: 'Barack Obama', why: '"barack", "obama" is not in the transcript, context or glossary, nor a role word' },
    ]);
    expect(log.lines).toContain('warn: rejected speaker role S2 "Barack Obama": "barack", "obama" is not in the transcript, context or glossary, nor a role word');
  });

  it('keeps a role of lowercase words or role words, and one whose names the transcript or context has', () => {
    const known = labelVouchers(['Welcome back, I am Maya.'], [], 'en');
    for (const role of ['host', 'guest of the show', 'Guest Speaker', 'Co-host', "Maya's guest", 'Gast']) expect(roleObjection(role, known, 'en'), role).toBeNull();
    expect(roleObjection('Moderatorin', known, 'de')).toBeNull();
    expect(roleObjection('Lumora CEO', known, 'en')).toMatch(/"lumora", "ceo" is not in/);
    expect(roleObjection('司会の田中', known, 'ja')).toMatch(/is not in/);
  });
});

describe('labels: possessives, titles, a role after a comma, scripts without spaces', () => {
  const vouch = (text: string, language = 'en') => labelVouchers([...tokenizeDisplay(text)], [], language);

  it('lets a possessive vouch for the name', () => {
    expect(labelObjection('Maya', '', vouch("This is Maya's show."), 'en')).toBeNull();
    expect(labelObjection('Maya', '', vouch('This is Maya’s show.'), 'en')).toBeNull();
    expect(labelObjection('Mayas', '', vouch('This is Maya show.'), 'en')).toMatch(/"mayas" is not in/);
  });

  it('needs no vouching for a title when a vouched name remains', () => {
    expect(labelObjection('Dr. Smith', '', vouch('Welcome, Doctor Smith.'), 'en')).toBeNull();
    expect(labelObjection('Ms. Lee', '', vouch('Thank you, Miss Lee.'), 'en')).toBeNull();
    expect(labelObjection('Prof. Lee', '', vouch('Hi Lee.'), 'en')).toBeNull();
    expect(labelObjection('Herr Müller', '', vouch('Danke, Müller.', 'de'), 'de')).toBeNull();
    expect(labelObjection('Dr. Jones', '', vouch('Welcome, Doctor Smith.'), 'en')).toMatch(/"jones" is not in/);
    expect(labelObjection('Dr.', '', vouch('Welcome, Smith.'), 'en')).toMatch(/"dr" is not in/);
  });

  it('treats a role after a comma like a role in parentheses', () => {
    const known = vouch('Thanks, Lee.');
    expect(labelObjection('Lee, guest', 'guest', known, 'en')).toBeNull();
    expect(labelObjection('Lee (guest)', 'guest', known, 'en')).toBeNull();
    expect(labelObjection('Lee, guest', '', known, 'en')).toMatch(/"guest" is not in/);
  });

  it('finds a name in a script without spaces as a run of characters', () => {
    expect(labelObjection('田中', '', vouch('田中です。', 'ja'), 'ja')).toBeNull();
    expect(labelObjection('ソムチャイ', '', vouch('ソムチャイさん、こんにちは', 'ja'), 'ja')).toBeNull();
    expect(labelObjection('佐藤', '', vouch('田中です。', 'ja'), 'ja')).toMatch(/is not in/);
  });

  it('still drops a plain invented name', () => {
    expect(labelObjection('Peter Smith', '', vouch("This is Maya's show."), 'en')).toMatch(/"peter", "smith" is not in/);
  });
});

describe('a role does not vouch for a capitalized name in the label', () => {
  const known = labelVouchers(['Hello and welcome.'], [], 'en');
  it('rejects a lowercase name the role let through', () => {
    expect(labelObjection('Barack Obama', 'barack obama', known, 'en')).toMatch(/"barack", "obama" is not in/);
  });
  it('a role in parentheses or after a comma does not vouch for a name next to a vouched one', () => {
    const maya = labelVouchers(['Hello Maya.'], [], 'en');
    expect(labelObjection('Maya (Barack Obama)', 'barack obama', maya, 'en')).toMatch(/"barack", "obama" is not in/);
    expect(labelObjection('Maya, Barack Obama', 'barack obama', maya, 'en')).toMatch(/"barack", "obama" is not in/);
    expect(labelObjection('Maya (host)', 'host', maya, 'en')).toBe(null);
    expect(labelObjection('Maya, guest', 'guest', maya, 'en')).toBe(null);
  });
  it('keeps a label that repeats a role word or a lowercase role', () => {
    expect(labelObjection('Host', 'host', known, 'en')).toBe(null);
    expect(labelObjection('Guest Speaker', 'guest speaker', known, 'en')).toBe(null);
    expect(labelObjection('guest of the show', 'guest of the show', known, 'en')).toBe(null);
  });
});
