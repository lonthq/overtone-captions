import { isUntimed } from '../align/align.js';
import type { StyleSettings } from 'overtone-format';
import type { ResolvedProfile } from '../config.js';
import { LATEST_RULESET, type RuleSet } from '../segment/rulesets/index.js';
import type { SpeakerWord } from '../turns.js';
import type { Window } from './windows.js';

export interface PromptContext {
  context?: string;
  glossary: readonly string[];
  /** Names and terms inferred from the transcript (no user context given): hints, not a glossary. */
  inferredTerms?: readonly string[];
  style: StyleSettings;
  language: string;
  maxSpan: number;
  maxStyledRatio: number;
  /** Its pause thresholds mark pauses in the transcript. Default: the latest. */
  ruleset?: RuleSet;
}

const UNCERTAIN = new Set(['fuzzy', 'interpolated']);

/**
 * A window's words, one line per speaker run: "[S1 @12.3s] 0:Every 1:year, *2:one …". `*` marks an uncertain alignment
 * (likely misheard); words outside the owned range sit on "(context)" lines. With `pauses` (a rule set's thresholds;
 * true: the latest), " ‖" follows a word before a pause of at least `force` (a caption must end) and " ·0.7s" one before
 * a pause of at least `marker` (rounded down to 0.1 s; segment/pauses.ts).
 */
export function renderWords(words: readonly SpeakerWord[], win: Window, marks = true, pauses: boolean | RuleSet['pauses'] = false): string {
  const p = pauses === true ? LATEST_RULESET.pauses : pauses || undefined;
  const lines: string[] = [];
  let current = '';
  let key = '';
  for (let i = win.first; i <= win.last; i++) {
    const w = words[i];
    const own = i >= win.ownFirst && i <= win.ownLast;
    const k = `${w.speaker}|${own}`;
    if (k !== key) {
      if (current) lines.push(current);
      current = `${own ? '' : '(context) '}[${w.speaker} @${w.start.toFixed(1)}s]`;
      key = k;
    }
    current += ` ${marks && w.match && UNCERTAIN.has(w.match) ? '*' : ''}${i}:${w.text}`;
    const next = words[i + 1];
    // no pause next to a word with an unknown time: its gaps are where it was placed
    const gap = p && i < win.last && next.speaker === w.speaker && !isUntimed(w) && !isUntimed(next) ? next.start - w.end : 0;
    if (!p || gap <= 0) continue;
    if (gap >= p.force) current += ' ‖';
    else if (gap >= p.marker) current += ` ·${(Math.floor(gap * 10 + 1e-6) / 10).toFixed(1)}s`;
  }
  if (current) lines.push(current);
  return lines.join('\n');
}

function styleLines(style: StyleSettings): string[] {
  const out: string[] = [];
  if (style.numbers === 'digits') out.push('Write numbers as digits ("5", "1,000", "3rd").');
  if (style.numbers === 'words') out.push('Write numbers as words ("five", "one thousand", "third").');
  if (style.currency === 'symbol') out.push('Write money with the currency symbol before the amount ("€12").');
  if (style.currency === 'code') out.push('Write money with the ISO code ("EUR 12").');
  if (style.currency === 'words') out.push('Write money in words ("twelve euros").');
  if (style.guide) out.push(`Style guide: ${style.guide}`);
  return out;
}

/** Shared prompt header; only the corrections step (5a) uses the style settings. */
function header(p: PromptContext): string {
  const parts = [`Language: ${p.language}`];
  if (p.context) parts.push(`What this media is about: ${p.context}`);
  if (p.glossary.length > 0) parts.push(`Glossary (correct spellings of names and terms): ${p.glossary.join('; ')}`);
  if (p.inferredTerms && p.inferredTerms.length > 0) parts.push(`Names and terms that probably occur (inferred from the transcript, not verified): ${p.inferredTerms.join('; ')}`);
  const style = styleLines(p.style);
  if (style.length > 0) parts.push(`Style settings:\n- ${style.join('\n- ')}`);
  return parts.join('\n');
}

/**
 * The stable part of every refine prompt for a window (`system`): role, notation, header and numbered transcript. It is
 * identical for steps that see the same words, so prompt caching reuses it; the step's task follows in `user`.
 */
export function sharedPrompt(p: PromptContext, words: readonly SpeakerWord[], win: Window): string {
  return [
    'You are a meticulous caption editor. You get a machine transcript as numbered words, then one task about it.',
    'Notation: "[S1 @12.3s]" marks where speaker S1 starts talking (at 12.3 s). A word marked * was hard to align and is the most likely to be misheard. " ‖" after a word marks a long pause, " ·0.7s" a shorter one (here 0.7 s). Words on lines starting with "(context)" are only shown for context: never change, mark or cover them.',
    '',
    header(p),
    '',
    'Transcript:',
    renderWords(words, win, true, (p.ruleset ?? LATEST_RULESET).pauses),
  ].join('\n');
}

/** "about 3–4 words" for a line of `chars` characters (5–6.5 characters per word with the space). */
function wordsPerLine(chars: number): string {
  const lo = Math.max(1, Math.floor(chars / 6.5));
  const hi = Math.max(lo, Math.ceil(chars / 5.5));
  return lo === hi ? `about ${lo} word${lo === 1 ? '' : 's'}` : `about ${lo}–${hi} words`;
}

/** A place where another engine heard something else: transcript words first..last, and what was heard. */
export interface Alternative { first: number; last: number; heard: string }

export function correctionsPrompt(p: PromptContext, words: readonly SpeakerWord[], win: Window, speakerIds: readonly string[], alternatives: readonly Alternative[] = []): { system: string; user: string } {
  const task = [
    'Task: correct what the speech recognition got wrong. The transcript is already very accurate: most words are right, so most of it needs no edit.',
    'Judge each sentence as a whole, with the context and the glossary. Look hardest at words marked *, at words another engine heard differently (listed below), and at homophones, names and terms that do not fit the sentence or the topic. Fix what was misheard, also a name, a number or a negation when the sentence, the context or the other engine makes clear what was said.',
    'Also fix spelling, casing, punctuation, glossary/brand spellings, words that were wrongly split or merged, and the writing style of numbers and money as the style settings ask.',
    'Keep what was said: never paraphrase, summarize, reorder, add or drop content, and keep the speaker\'s own words, grammar and hesitations ("I I think" stays). Change a word only when you have a reason to think it was misheard.',
    'Return edits as {first, last, to, reason, sure, note}: words first..last (inclusive indices) are replaced by "to" (one or more words, with punctuation). Only edit words that are not on (context) lines.',
    `Each edit is a range of at most ${p.maxSpan} words. Keep edits as small as possible.`,
    'A glossary edit replaces only the misheard words with the term; put any other fix in a separate edit.',
    'Fillers (uh, um, er) are not content. To remove one, merge it into an edit of a neighbouring word: words "uh think" → to "think", reason "correction". "to" is never empty.',
    'reason: "correction" = a transcription error; "brand" = spelling of a brand, product or person name (use the glossary); "style" = apply the style settings (must keep every numeric value); "punctuation" = punctuation or capitalization only; "split-word" = a word wrongly split or joined.',
    'sure: true when the sentence, the context or the other engine makes the fix clear; false when it is a plausible guess that a person should check by ear (it is applied, and listed for review). note: for an edit that is not sure, a few words on why you made it; otherwise "".',
    'Return an empty edits list when nothing needs fixing.',
    'Speakers: return one entry per speaker id. label = the person\'s name or role (e.g. "Host", "Interviewer") only when the transcript or the context makes it clear; otherwise label = the id unchanged (e.g. "S1"). role = a short role, or "" if unknown. Never guess.',
  ];
  const own = alternatives.filter((a) => a.first >= win.ownFirst && a.last <= win.ownLast);
  if (own.length > 0) {
    task.push('', 'Where another speech engine (the one that timed the words) heard something else, as "first–last: transcript → heard". Neither is always right:');
    for (const a of own) task.push(`${a.first === a.last ? a.first : `${a.first}–${a.last}`}: ${words.slice(a.first, a.last + 1).map((w) => w.text).join(' ')} → ${a.heard}`);
  }
  return { system: sharedPrompt(p, words, win), user: `${task.join('\n')}\nSpeaker ids: ${speakerIds.join(', ')}` };
}

/**
 * 5b prompt. `people`: people known to be in the media (the speaker labels from 5a), listed so the model never marks
 * them "brand"; glossary terms are often people's names.
 */
export function stylingPrompt(p: PromptContext, words: readonly SpeakerWord[], win: Window, people: readonly string[] = []): { system: string; user: string } {
  const owned = win.ownLast - win.ownFirst + 1;
  const cap = Math.floor(owned * p.maxStyledRatio);
  const task = [
    'Task: mark words in captions with semantic classes that a video player renders with subtle styling. Mark what the words mean, not how they should look.',
    'Use only these classes: "emphasis" = a word the speaker clearly stresses; "key" = a short phrase of at most 4 words that the viewer should remember: the heart of the core message (at most one per sentence, never a whole clause); "brand" = the name of a brand, product, company or organization (including its programs, missions and vehicles); "number" = figures, prices, dates, percentages; "soft" = an aside or filler of lower importance.',
    'Never use "brand" for the name of a person (also when the name is in the glossary or is a speaker), a place or a job title. The glossary only gives correct spellings: it can list people and places too.',
    'Usually one class per range; combine only "key" with another class.',
    `Be sparing: at most ${cap} styled words in this part (${Math.round(p.maxStyledRatio * 100)} % of the words not on (context) lines), never whole sentences. This budget is enforced in code: when you exceed it, marks are dropped (soft first, then emphasis, key, number, brand), so mark only what matters most and prioritise.`,
    'Return {first, last, classes} ranges of word indices (inclusive). Only mark words that are not on (context) lines.',
  ].join('\n');
  const names = people.length > 0 ? `\nPeople in this media (never "brand"): ${people.join('; ')}\n` : '';
  return { system: sharedPrompt(p, words, win), user: `${task}${names}` };
}

export function linebreaksPrompt(p: PromptContext, words: readonly SpeakerWord[], win: Window, profile: ResolvedProfile): { system: string; user: string } {
  const r = profile.rules;
  const rs = p.ruleset ?? LATEST_RULESET;
  const task = [
    `Task: cut the transcript into captions for the "${profile.id}" display${profile.description ? ` (${profile.description})` : ''}.`,
    `Hard rules: at most ${r.maxCharsPerLine} characters per line (the words joined by single spaces, punctuation included; that is ${wordsPerLine(r.maxCharsPerLine)}), at most ${r.maxLines} line${r.maxLines === 1 ? '' : 's'} per caption, so at most ${r.maxCharsPerLine * r.maxLines} characters (${wordsPerLine(r.maxCharsPerLine * r.maxLines)}) per caption. A new caption starts at every speaker change. A caption must end at every ‖ (a pause).`,
    `A caption is shown only while its words are spoken (at most ${rs.layout.maxExtension} s longer), so cutting more often gives the viewer no extra reading time${r.maxCps ? ` (speech often runs faster than the ${r.maxCps} characters per second viewers read comfortably)` : ''}: fill each caption up to the limit unless a sentence ends, the speaker pauses (‖) or a clause ends near it. Avoid captions of only 1–3 words.`,
    'Cut at natural phrase and clause boundaries: break after sentence ends, then after commas/colons, then before conjunctions. Use one line when the caption fits on one line. Balance the lines of a two-line caption (the bottom line may be slightly longer).',
    'Never end a line or caption on an article, preposition, possessive or auxiliary verb. Avoid ending one on a subject pronoun or relative word (I, we, you, they, who, what, which, that): keep it with the words it opens. Keep adjectives with their nouns ("an operational pilot", "a very long gap") and verbs with their particles ("grew up", "carry on"). Never put a single word on a line of its own, except a short interjection such as "Okay." or "Well," on the top line. Never start a new sentence in the last word or two of a line or caption, and never carry only the last word or two of a sentence over to the next line or caption.',
    'Never split names, number groups ("€12 a month", "one in five") or glossary terms over two lines or captions.',
    `A "·" mark (e.g. "·0.7s") is a hesitation: break the line or caption there when it helps show the hesitation, even after a short word such as an article or preposition; at ${rs.pauses.cue} s or more prefer ending the caption, and never hide it inside a line.`,
    'When a caption has no good line break, move its boundaries instead. Before answering, check every line end against these rules.',
    'Return cueStarts = word indices where a caption starts and lineStarts = word indices where a new line starts inside a caption. Only cover words that are not on (context) lines; the first word that is not on a (context) line always starts a caption. "[S1 @12.3s]" marks where speaker S1 starts talking (at 12.3 s).',
  ].join('\n');
  return { system: sharedPrompt(p, words, win), user: task };
}
