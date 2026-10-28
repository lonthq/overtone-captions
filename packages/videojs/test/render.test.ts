// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getProfile } from 'overtone-format';
import { renderCue, shouldShowSpeaker, turnOf, updateActiveWords, wordsOf } from '../src/core/render';
import { loadFixture } from './helpers';

const doc = loadFixture();
const horizontal = getProfile(doc, 'horizontal')!;

describe('renderCue', () => {
  it('renders one .ot-line per cue line with the words in order', () => {
    const el = renderCue(doc, horizontal, 1);
    expect(el.className).toBe('ot-cue');
    expect(el.dataset.speaker).toBe('S1');
    const lines = [...el.querySelectorAll('.ot-line')].map((line) => line.textContent);
    expect(lines).toEqual(['With DriveCover from Lumora,', "you're insured from day one,"]);
  });

  it('gives every word ot-word plus ot-<class> for each style class', () => {
    const el = renderCue(doc, horizontal, 2); // "for just $12 a month."
    const words = [...el.querySelectorAll('.ot-word')].map((span) => [span.textContent, span.className]);
    expect(words).toEqual([
      ['for', 'ot-word'],
      ['just', 'ot-word'],
      ['$12 ', 'ot-word ot-number ot-key'], // the space to the next key word is inside the span
      ['a ', 'ot-word ot-key'],
      ['month.', 'ot-word ot-key'],
    ]);
  });

  it('puts the space between two consecutive key words inside the first word, so a highlight has no gap', () => {
    const el = renderCue(doc, horizontal, 2); // "for just $12 a month." with key on "$12 a month."
    const line = el.querySelector('.ot-line')!;
    expect(line.textContent).toBe('for just $12 a month.');
    expect([...line.querySelectorAll('.ot-word')].map((span) => span.textContent)).toEqual(['for', 'just', '$12 ', 'a ', 'month.']);
    expect([...line.querySelectorAll<HTMLElement>('.ot-word')].map((span) => span.hasAttribute('data-joined'))).toEqual([false, false, true, true, false]);
    // the joined words have no text node between them; the other gaps stay text nodes
    expect([...line.childNodes].map((n) => (n.nodeType === Node.TEXT_NODE ? `"${n.textContent}"` : n.textContent))).toEqual([
      'for', '" "', 'just', '" "', '$12 ', 'a ', 'month.',
    ]);
  });

  it('puts each word\'s text (with its punctuation) in an .ot-text element, and a joined word\'s space after it', () => {
    const el = renderCue(doc, horizontal, 2); // "for just $12 a month." with key on "$12 a month."
    const spans = [...el.querySelectorAll<HTMLElement>('.ot-line .ot-word')];
    expect(spans.map((span) => span.querySelector('.ot-text')?.textContent)).toEqual(['for', 'just', '$12', 'a', 'month.']);
    // the space sits in the word's box (under the marker), outside its text, which may move
    expect(spans.map((span) => [...span.childNodes].map((n) => (n.nodeType === Node.TEXT_NODE ? `"${n.textContent}"` : n.textContent)))).toEqual([
      ['for'], ['just'], ['$12', '" "'], ['a', '" "'], ['month.'],
    ]);
  });

  it('only joins words of the same line, and only when both are key words', () => {
    const copy = loadFixture();
    const flat = wordsOf(copy);
    for (const w of flat) w.classes = undefined;
    // line 1 = words 12-15 "With DriveCover from Lumora,", line 2 = words 16-20 "you're insured from day one,"
    for (const i of [13, 14, 15, 16, 17, 19]) flat[i].classes = ['key'];
    flat[20].classes = ['emphasis'];
    const lines = [...renderCue(copy, getProfile(copy, 'horizontal')!, 1).querySelectorAll('.ot-line')];
    expect(lines.map((l) => l.textContent)).toEqual(['With DriveCover from Lumora,', "you're insured from day one,"]);
    const spans = lines.map((l) => [...l.querySelectorAll('.ot-word')].map((s) => s.textContent));
    expect(spans).toEqual([
      ['With', 'DriveCover ', 'from ', 'Lumora,'], // the line's last word never gets a trailing space
      ["you're ", 'insured', 'from', 'day', 'one,'], // "day" is key but "one," is not
    ]);
  });

  it('keeps an ot-word span for every word, so the active-word pop still works', () => {
    const el = renderCue(doc, horizontal, 2);
    expect(el.querySelectorAll('.ot-word')).toHaveLength(5);
    updateActiveWords(el, 8.7);
    expect([...el.querySelectorAll('.ot-active')].map((span) => span.textContent)).toEqual(['$12 ']);
    updateActiveWords(el, 9.3);
    expect([...el.querySelectorAll('.ot-active')].map((span) => span.textContent)).toEqual(['a ']);
  });

  it('stores word times on the spans', () => {
    const span = renderCue(doc, horizontal, 0).querySelector<HTMLElement>('.ot-word')!;
    expect(span.dataset.start).toBe('0.5');
    expect(span.dataset.end).toBe('0.823');
  });

  it('gives every word a side to turn to (--ot-turn: 1 or -1), random per word but the same on every render', () => {
    const doc = loadFixture();
    const profile = getProfile(doc, 'horizontal')!;
    const turns = (index: number) => [...renderCue(doc, profile, index).querySelectorAll<HTMLElement>('.ot-word')].map((s) => s.style.getPropertyValue('--ot-turn'));
    const all = profile.cues.flatMap((_, k) => turns(k));
    expect(all.every((t) => t === '1' || t === '-1')).toBe(true);
    expect(new Set(all)).toEqual(new Set(['1', '-1']));
    expect(profile.cues.flatMap((_, k) => turns(k))).toEqual(all);
    // not a plain alternation: some neighbors turn the same way
    expect(all.some((t, i) => i > 0 && t === all[i - 1])).toBe(true);
    expect(turnOf(0)).toBe(turnOf(0));
  });

  it('escapes word text (textContent, never innerHTML)', () => {
    const copy = loadFixture();
    copy.turns[0].words[0].text = '<b>Every</b>';
    const el = renderCue(copy, getProfile(copy, 'horizontal')!, 0);
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('.ot-word')!.textContent).toBe('<b>Every</b>');
  });

  it('adds no speaker label by default', () => {
    for (const i of horizontal.cues.keys()) {
      expect(renderCue(doc, horizontal, i).querySelector('.ot-speaker')).toBeNull();
    }
  });

  it('adds the speaker label according to the speakers option', () => {
    expect(renderCue(doc, horizontal, 3, { speakers: 'change' }).querySelector('.ot-speaker')?.textContent).toBe('Tom');
    expect(renderCue(doc, horizontal, 2, { speakers: 'change' }).querySelector('.ot-speaker')).toBeNull();
    expect(renderCue(doc, horizontal, 2, { speakers: 'always' }).querySelector('.ot-speaker')?.textContent).toBe('Maya');
    expect(renderCue(doc, horizontal, 3, { speakers: 'never' }).querySelector('.ot-speaker')).toBeNull();
  });
});

describe('shouldShowSpeaker', () => {
  it('in change mode shows the label when the speaker differs from the previous cue', () => {
    const shown = horizontal.cues.map((_, i) => shouldShowSpeaker(doc, horizontal.cues, i, 'change'));
    expect(shown).toEqual([true, false, false, true, true]);
  });

  it('in change mode hides the first label when the document has one speaker', () => {
    const single = { ...doc, speakers: [doc.speakers[0]] };
    expect(shouldShowSpeaker(single, horizontal.cues, 0, 'change')).toBe(false);
  });

  it('in change mode treats the first cue inside the profile window as a change', () => {
    // Cue 2 (S1) follows cue 1 (S1); with a window starting after cue 1 it is the first visible cue.
    const window = { start: 8.06, end: 18 };
    expect(shouldShowSpeaker(doc, horizontal.cues, 2, 'change', window)).toBe(true);
    expect(shouldShowSpeaker(doc, horizontal.cues, 2, 'change', { start: 0, end: 18 })).toBe(false);
    // Cue 1 still overlaps a window starting at 8.0, so cue 2 is not the first visible one.
    expect(shouldShowSpeaker(doc, horizontal.cues, 2, 'change', { start: 8, end: 18 })).toBe(false);
    const single = { ...doc, speakers: [doc.speakers[0]] };
    expect(shouldShowSpeaker(single, horizontal.cues, 2, 'change', window)).toBe(false);
  });

  it('in change mode labels the first visible cue when the previous cue ends exactly at the window start', () => {
    // Cue 1 ends at 8.057: with the window starting there it is not shown, so cue 2 is the first visible cue.
    const window = { start: horizontal.cues[1].end, end: 18 };
    expect(shouldShowSpeaker(doc, horizontal.cues, 2, 'change', window)).toBe(true);
    const copy = loadFixture();
    const profile = getProfile(copy, 'horizontal')!;
    profile.window = window;
    expect(renderCue(copy, profile, 2, { speakers: 'change' }).querySelector('.ot-speaker')?.textContent).toBe('Maya');
  });

  it('renderCue applies the profile window to the change rule', () => {
    const copy = loadFixture();
    const profile = getProfile(copy, 'horizontal')!;
    profile.window = { start: 8.06, end: 18 };
    expect(renderCue(copy, profile, 2, { speakers: 'change' }).querySelector('.ot-speaker')?.textContent).toBe('Maya');
  });
});

describe('updateActiveWords', () => {
  it('marks only the words being spoken with ot-active', () => {
    const el = renderCue(doc, horizontal, 2);
    updateActiveWords(el, 8.7); // inside "$12" (8.626–9.248)
    const active = [...el.querySelectorAll('.ot-active')].map((span) => span.textContent);
    expect(active).toEqual(['$12 ']);
    updateActiveWords(el, 9.25); // gap between "$12" and "a"
    expect(el.querySelectorAll('.ot-active')).toHaveLength(0);
  });
});

describe('wordsOf', () => {
  it('returns the same array for the same document and a different one for another document', () => {
    expect(wordsOf(doc)).toBe(wordsOf(doc));
    expect(wordsOf(loadFixture())).not.toBe(wordsOf(doc));
  });
});

describe('renderCue class filtering', () => {
  it('ignores class names that are not style classes', () => {
    const copy = loadFixture();
    copy.turns[0].words[0].classes = ['key ot-active', 'bogus', 'key'] as never;
    const el = renderCue(copy, getProfile(copy, 'horizontal')!, 0);
    expect(el.querySelector('.ot-word')!.className).toBe('ot-word ot-key');
  });
});
