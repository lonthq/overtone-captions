import type { Turn, Word } from 'overtone-format';
import { SHARED } from './lang/index.js';
import type { AlignedWord } from './types.js';

/** A speaker boundary moves to the nearest sentence end within this many seconds. */
const SNAP_WINDOW = 1.0;

export interface TurnOptions {
  /** Absorb non-sentence runs of at most this many words into the speaker they continue (default 2; 0: off). */
  maxBlipWords?: number;
}

const CLOSERS = '["\'”’»)\\]」』）]*';
const SENTENCE_END = new RegExp(`[.!?…。？！؟।]${CLOSERS}$`, 'u');
const CLOSERS_END = new RegExp(`${CLOSERS}$`, 'u');
/** Abbreviations whose "." does not end a sentence, from all language packs (lowercase). */
const ABBREVIATIONS = SHARED.abbreviations;

/** Abbreviations that still end a sentence when a capitalized word follows ("… cats, etc. Then we …"). */
const ENDING_ABBREVIATIONS = SHARED.endingAbbreviations;
const stripOpeners = (w: string) => w.replace(/^[^\p{L}\p{N}]+/u, '');
const startsCapital = (w: string) => /^\p{Lu}/u.test(stripOpeners(w));

/** What is known about a word's neighbors; see `endsSentence`. */
export interface SentenceContext {
  /** The previous word's text. */
  prev?: string;
  /** The next word's text. */
  next?: string;
  /** The last word of the text, so a sentence ends here. */
  last?: boolean;
}

/**
 * True when the word ends a sentence ("part?", "free.", "so…”"). Common abbreviations ("Dr.", "e.g.") and initials
 * ("J.") do not. With `ctx`:
 * - a capital + "." is an initial only after a capitalized word or initial ("John F.", "J. R."), so "plan B." ends one;
 * - "etc.", "U.S." and "U.K." end a sentence when the next word is capitalized;
 * - the last word of the text ends a sentence, punctuated or not.
 */
export function endsSentence(text: string, ctx: SentenceContext = {}): boolean {
  if (ctx.last) return true;
  if (!SENTENCE_END.test(text)) return false;
  const core = stripOpeners(text.replace(CLOSERS_END, ''));
  if (!core.endsWith('.')) return true;
  const lower = core.toLowerCase();
  if (ENDING_ABBREVIATIONS.has(lower)) return ctx.next !== undefined && startsCapital(ctx.next);
  if (ABBREVIATIONS.has(lower)) return false;
  if (/^\p{Lu}\.$/u.test(core)) {
    const prev = ctx.prev;
    return prev !== undefined && !(startsCapital(prev) || /^\p{Lu}\.$/u.test(stripOpeners(prev.replace(CLOSERS_END, ''))));
  }
  return true;
}

/** `endsSentence` for words[i], with its neighbors. */
function endsAt(words: readonly AlignedWord[], i: number): boolean {
  return endsSentence(words[i].text, { prev: words[i - 1]?.text, next: words[i + 1]?.text, last: i === words.length - 1 });
}

/** Indices where the speaker changes (first word of each new run). */
function boundaries(speakers: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < speakers.length; i++) if (speakers[i] !== speakers[i - 1]) out.push(i);
  return out;
}

/** True when words[from, to) starts after a sentence end and ends one. */
function isSentenceSpan(words: readonly AlignedWord[], from: number, to: number): boolean {
  return (from === 0 || endsAt(words, from - 1)) && endsAt(words, to - 1);
}

/** Runs as [from, to) index pairs. */
function runsOf(speakers: readonly string[]): Array<[number, number]> {
  const b = [0, ...boundaries(speakers), speakers.length];
  return b.slice(0, -1).map((from, r) => [from, b[r + 1]]);
}

/**
 * Remove short diarization blips so a glitch never starts or ends a turn mid-sentence. A run of at most `maxBlip` words
 * stays only when it is a complete sentence (a real interjection); otherwise:
 * - between two runs of the same speaker it joins them;
 * - with `edges`, a one-word run at the start or end joins its only neighbor (not when `maxBlip` is 0);
 * - with `edges`, between two speakers it joins the side where it does not form a sentence boundary.
 */
function smoothBlips(words: readonly AlignedWord[], speakers: string[], maxBlip: number, edges: boolean): void {
  const sweep = (pick: (r: number, last: number, from: number, to: number) => string | undefined, limit: number) => {
    const runs = runsOf(speakers);
    const last = runs.length - 1;
    for (let r = 0; r <= last; r++) {
      const [from, to] = runs[r];
      if (runs.length < 2 || to - from > limit || isSentenceSpan(words, from, to)) continue;
      const target = pick(r, last, from, to);
      if (target !== undefined) for (let k = from; k < to; k++) speakers[k] = target;
    }
  };
  sweep((r, last, from, to) => (r > 0 && r < last && speakers[from - 1] === speakers[to] ? speakers[to] : undefined), maxBlip);
  if (!edges) return;
  sweep((r, last, from, to) => (r === 0 ? speakers[to] : r === last ? speakers[from - 1] : undefined), Math.min(1, maxBlip));
  sweep((r, last, from, to) => {
    if (r === 0 || r === last) return undefined;
    const startsSentence = endsAt(words, from - 1);
    const endsHere = endsAt(words, to - 1);
    if (startsSentence && !endsHere) return speakers[to];
    if (!startsSentence && endsHere) return speakers[from - 1];
    return undefined; // mid-sentence on both sides: ambiguous, leave it
  }, maxBlip);
}

/**
 * Group aligned words into speaker turns. Boundaries move to the nearest sentence end within SNAP_WINDOW seconds;
 * blips that still start or end a turn mid-sentence merge into the speaker they continue.
 */
export function buildTurns(words: readonly AlignedWord[], opts: TurnOptions = {}): Turn[] {
  if (words.length === 0) return [];
  const maxBlip = opts.maxBlipWords ?? 2;
  const speakers = words.map((w) => w.speaker);
  smoothBlips(words, speakers, maxBlip, false);

  const original = boundaries(speakers);
  const runSpeakers = [speakers[0], ...original.map((b) => speakers[b])];
  const snapped: number[] = [];
  original.forEach((b, k) => {
    const lo = snapped.length > 0 ? snapped[snapped.length - 1] : 0;
    const hi = k + 1 < original.length ? original[k + 1] : words.length;
    if (endsAt(words, b - 1)) { snapped.push(b); return; }
    let best = b;
    let bestDist = Infinity;
    for (let c = lo + 1; c < hi; c++) {
      if (!endsAt(words, c - 1)) continue;
      const dist = Math.abs(words[c].start - words[b].start);
      if (dist <= SNAP_WINDOW && dist < bestDist) { best = c; bestDist = dist; }
    }
    snapped.push(best);
  });

  // speaker per word after snapping, then absorb what snapping could not repair
  const edges = [0, ...snapped, words.length];
  const final: string[] = [];
  for (let k = 0; k + 1 < edges.length; k++) {
    for (let i = edges[k]; i < edges[k + 1]; i++) final.push(runSpeakers[k]);
  }
  smoothBlips(words, final, maxBlip, true);

  return groupTurns(words.map((w, i) => ({ text: w.text, start: w.start, end: w.end, match: w.match, confidence: w.confidence, speaker: final[i] })));
}

/**
 * A word with its speaker: the flat form refine and line cutting use. `untimed`: an edit replaced a word no engine
 * heard, so this time is an estimate too. Internal only; groupTurns leaves it out.
 */
export interface SpeakerWord extends Word { speaker: string; untimed?: true }

/** Turns → flat words; the array index is the global word index. */
export function flattenTurns(turns: readonly Turn[]): SpeakerWord[] {
  return turns.flatMap((t) => t.words.map((w) => ({ ...w, speaker: t.speaker })));
}

/** Flat words → one turn per run of the same speaker (no snapping). Drops the internal `untimed`. */
export function groupTurns(words: readonly SpeakerWord[]): Turn[] {
  const turns: Turn[] = [];
  for (const { speaker, untimed: _untimed, ...word } of words) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === speaker) {
      last.words.push(word);
      last.end = word.end;
    } else {
      turns.push({ speaker, start: word.start, end: word.end, words: [word] });
    }
  }
  return turns;
}
