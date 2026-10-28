import { EDIT_REASONS, rangeText, roundTime, type Edit, type EditReason } from 'overtone-format';
import { isUntimed } from '../align/align.js';
import { charWeight, splitSpan } from '../align/rate.js';
import { isFiller, langOf, type Lang } from '../lang/index.js';
import { tokenizeDisplay } from '../text/normalize.js';
import { nonOverlapping } from '../util/ranges.js';
import type { SpeakerWord } from '../turns.js';
import { piecesOf, sharedEnds, spacelessPieces, SPACELESS, texts, type Piece } from './pieces.js';

/**
 * The limits an edit is checked against. The editor judges the words; code checks only an edit's structure (range,
 * size, speakers, room for the new words, repetition, overlaps).
 */
export interface EditGuards {
  /** Longest span an edit may replace, in words (`edits.maxSpan`, default 6). */
  maxSpan: number;
  language: string;
}

/**
 * An edit as the LLM proposed it (inclusive global word indices). `sure: false`: a plausible guess to check by ear; it
 * is applied and goes on the review list, with `note` saying why.
 */
export interface ProposedEdit { first: number; last: number; to: string; reason: EditReason; sure?: boolean; note?: string }
export interface RejectedEdit { edit: ProposedEdit; from: string; why: string }
/** An applied edit the editor was not sure about, for the review list. */
export interface UnsureEdit { edit: ProposedEdit; from: string; start: number; end: number }

export interface EditResult { words: SpeakerWord[]; edits: Edit[]; rejected: RejectedEdit[]; unsure: UnsureEdit[] }

const ms = (seconds: number) => Math.round(seconds * 1000);
/** Differing characters allowed per word of `maxSpan` in a spaceless script (a word there is 1–4 characters). */
const SPACELESS_CHARS_PER_WORD = 3;

/**
 * Times for `tokens` replacing `span`: with the same word count each word keeps its time; otherwise the span is split
 * by character length on a 1 ms grid, at least 1 ms per word (checkEdit ensures the room).
 */
function spreadTimes(span: readonly SpeakerWord[], tokens: readonly string[]): Array<[number, number]> {
  if (tokens.length === span.length) return span.map((w) => [w.start, w.end]);
  const start = ms(span[0].start);
  const end = ms(span[span.length - 1].end);
  const cuts = splitSpan(start, end, tokens.map(charWeight)).map(([s]) => Math.round(s));
  const n = cuts.length;
  for (let k = 1; k < n; k++) cuts[k] = Math.max(cuts[k], cuts[k - 1] + 1);
  for (let k = n - 1; k >= 1; k--) cuts[k] = Math.min(cuts[k], (k === n - 1 ? end : cuts[k + 1]) - 1);
  return cuts.map((c, k) => [c / 1000, (k === n - 1 ? end : cuts[k + 1]) / 1000]);
}

const count = (xs: readonly string[], x: string) => xs.filter((y) => y === x).length;
/** Non-overlapping occurrences of x in s. */
const occurrences = (x: string, s: string) => (x === '' ? 0 : s.split(x).length - 1);

/**
 * A word the edit repeats that the original did not have twice, in the replacement or next to it ("theclass" → "the
 * the class"). A word written twice in the original ("Peacocks.Peacocks.") may be split; an existing stutter may stay.
 */
export function repeatObjection(words: readonly SpeakerWord[], first: number, last: number, to: string, lang: Lang): string | null {
  const neighbour = (i: number) => (i >= 0 && i < words.length ? texts(piecesOf([words[i].text], lang)) : []);
  const fromTexts = texts(piecesOf(words.slice(first, last + 1).map((w) => w.text), lang));
  const toTexts = texts(piecesOf(tokenizeDisplay(to), lang));
  const local = [...neighbour(first - 1), ...toTexts, ...neighbour(last + 1)];
  for (const x of new Set(toTexts)) {
    if (isFiller(x, lang)) continue;
    const add = count(toTexts, x) - count(fromTexts, x);
    const glued = occurrences(x, fromTexts.filter((t) => t !== x).join(''));
    if (add > glued && count(local, x) >= 2) {
      const shown = [first > 0 ? words[first - 1].text : '', to, last + 1 < words.length ? words[last + 1].text : ''].filter(Boolean).join(' ');
      return `repeats "${x}" ("${shown}")`;
    }
  }
  return null;
}

/**
 * In a spaceless script one display word is a whole phrase, so `maxSpan` limits nothing: allow at most
 * SPACELESS_CHARS_PER_WORD differing characters per word of it.
 */
export function spacelessObjection(from: string, to: string, maxSpan: number, lang: Lang): string | null {
  const pieces = (s: string) => spacelessPieces(piecesOf(tokenizeDisplay(s), lang));
  const [a, b] = [pieces(from), pieces(to)];
  const [head, tail] = sharedEnds(a, b);
  const changed = (ps: readonly Piece[]) => ps.filter((p) => SPACELESS.test(p.text)).length;
  const n = Math.max(changed(a.slice(head, a.length - tail)), changed(b.slice(head, b.length - tail)));
  const max = maxSpan * SPACELESS_CHARS_PER_WORD;
  return n > max ? `changes ${n} characters, more than the maximum of ${max}` : null;
}

/** Why an edit fails a structure check, or null when it passes. */
export function checkEdit(words: readonly SpeakerWord[], e: ProposedEdit, guards: EditGuards): string | null {
  if (!(EDIT_REASONS as readonly unknown[]).includes(e.reason)) return `unknown reason "${String(e.reason)}"`;
  if (Number.isInteger(e.first) && Number.isInteger(e.last) && e.last < e.first) return `word range [${e.first}, ${e.last}] is reversed`;
  if (!Number.isInteger(e.first) || !Number.isInteger(e.last) || e.first < 0 || e.last >= words.length) {
    return `word range [${e.first}, ${e.last}] is out of range`;
  }
  const span = e.last - e.first + 1;
  if (span > guards.maxSpan) return `span of ${span} words exceeds the maximum of ${guards.maxSpan}`;
  const tokens = tokenizeDisplay(e.to);
  if (tokens.length === 0) return 'empty replacement';
  for (let i = e.first + 1; i <= e.last; i++) if (words[i].speaker !== words[e.first].speaker) return 'crosses a speaker change';
  const room = ms(words[e.last].end) - ms(words[e.first].start);
  if (tokens.length !== span && room < tokens.length) return `span too short (${room} ms for ${tokens.length} words)`;
  const lang = langOf(guards.language);
  const from = words.slice(e.first, e.last + 1).map((w) => w.text).join(' ');
  return spacelessObjection(from, e.to, guards.maxSpan, lang) ?? repeatObjection(words, e.first, e.last, e.to, lang);
}

/**
 * Apply LLM edits. Replacements are re-tokenized and timed by spreadTimes; new words get match "edited", the lowest
 * confidence of the words they replace, and `untimed` when they stand in for a word no engine heard. Duplicates and
 * edits overlapping an applied one are rejected; no-ops are dropped. Returns the new words, the applied edits (new
 * numbering), the rejected edits (input order) and the unsure ones.
 */
export function applyEdits(input: readonly SpeakerWord[], proposed: readonly ProposedEdit[], guards: EditGuards): EditResult {
  const rejected: Array<RejectedEdit & { index: number }> = [];
  const candidates: Array<{ edit: ProposedEdit; index: number; from: string }> = [];
  const seen = new Set<string>();
  proposed.forEach((e, index) => {
    const from = e.first >= 0 && e.last < input.length && e.first <= e.last ? rangeText(input, [e.first, e.last]) : '';
    const key = JSON.stringify([e.first, e.last, e.to, e.reason]);
    const why = seen.has(key) ? 'duplicate edit' : checkEdit(input, e, guards);
    seen.add(key);
    if (why) rejected.push({ edit: e, from, why, index });
    else if (tokenizeDisplay(e.to).join(' ') !== from) candidates.push({ edit: e, index, from });
  });

  candidates.sort((x, y) => x.edit.first - y.edit.first || x.edit.last - y.edit.last || x.index - y.index);
  const { accepted, overlapping } = nonOverlapping(candidates, (c) => c.edit);
  for (const c of overlapping) rejected.push({ edit: c.edit, from: c.from, why: 'overlaps another edit', index: c.index });

  const words: SpeakerWord[] = [];
  const edits: Edit[] = [];
  const unsure: UnsureEdit[] = [];
  let next = 0;
  for (const { edit: e, from } of accepted) {
    words.push(...input.slice(next, e.first));
    const span = input.slice(e.first, e.last + 1);
    const tokens = tokenizeDisplay(e.to);
    const times = spreadTimes(span, tokens);
    const confidence = Math.min(...span.map((w) => w.confidence ?? 1));
    const first = words.length;
    // a new word replacing an unheard word has an estimated time too: per word with the same count, else when any
    // replaced word was untimed (its time is spread over the whole span)
    const anyUntimed = span.some(isUntimed);
    tokens.forEach((text, k) => {
      const untimed = tokens.length === span.length ? isUntimed(span[k]) : anyUntimed;
      words.push({ text, start: roundTime(times[k][0]), end: roundTime(times[k][1]), speaker: span[0].speaker, match: 'edited', confidence, ...(untimed ? { untimed: true as const } : {}) });
    });
    edits.push({ words: [first, words.length - 1], from: rangeText(span, [0, span.length - 1]), to: tokens.join(' '), reason: e.reason });
    if (e.sure === false) unsure.push({ edit: e, from, start: span[0].start, end: span[span.length - 1].end });
    next = e.last + 1;
  }
  words.push(...input.slice(next));
  rejected.sort((x, y) => x.index - y.index);
  return { words, edits, rejected: rejected.map(({ index: _index, ...r }) => r), unsure };
}
