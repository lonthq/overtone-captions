import { roundTime } from 'overtone-format';
import type { Logger } from '../log.js';
import type { AlignedWord, Heard, TimedWord } from '../types.js';
import { alignWords, isHeard, isUntimed, MIN_WORD_DURATION } from './align.js';
import { finalize, interpolate, type Timing } from './fill.js';
import { speakingRate } from './rate.js';

/**
 * Re-listening for timing: the hearings fill each other's holes. An **unheard stretch** (a run of interpolated
 * words) is looked up, in order, in:
 * 1. the whole-file words of another engine (`Listener.whole`, no request), for every stretch;
 * 2. a snippet sent again to the timing engine, then to the other engine, for a stretch in a gap of at least
 *    `minGap` seconds or of at least `minWords` words. The snippet is the gap plus up to `context` words on each side
 *    (within `contextSeconds`), padded by `pad` seconds.
 *
 * The stretch and its context words are aligned to the window's words with the whole-file alignment (the text wins).
 * A stretch word heard (`isHeard`) takes the heard time, unless it lands on a neighbor that keeps its time (it heard
 * the neighbor's audio). A neighbor heard again where it was takes the new time, which frees room it may have taken
 * from the stretch. The context words also fix a stretch that starts with the word its neighbor ends with
 * ("You go." | "Go!"). The hearing with the most words wins; a word only another one heard is added where it fits.
 * Speakers stay. Windows over `maxWindow` seconds are not sent. What no engine heard keeps an unknown time.
 */
export const RELISTEN = {
  /** An unheard stretch: interpolated words in a gap of at least this many seconds … */
  minGap: 2,
  /** … or at least this many interpolated words in a row. */
  minWords: 4,
  /** Words of text on each side of the stretch aligned with it (the first one, a timed word, is its anchor) … */
  context: 3,
  /** … that start or end at most this many seconds from the gap. */
  contextSeconds: 2,
  /** Seconds of audio added on each side of the window (the gap plus its context words). */
  pad: 0.5,
  /** Longest window sent to a provider (seconds); a longer gap keeps its unknown times. */
  maxWindow: 120,
  /**
   * The audio sent for a window starts and ends on a multiple of this many seconds (widened, inside the media), so
   * windows that differ by a few milliseconds after a small alignment change send the same audio and reuse the
   * same cached answer (cache.ts). The words heard in the extra audio are not used (see `alignStretch`).
   */
  grid: 0.25,
} as const;

/** Text words [first, last] (indices) with no timing support, in the gap [start, end] between timed words. */
export interface Stretch { first: number; last: number; start: number; end: number }

/** One attempt or placement, recorded in `meta.timingRetries`. */
export interface TimingRetry {
  /** The gap the stretch was in (seconds). */
  start: number;
  end: number;
  /** Words of the stretch. */
  words: number;
  /** The provider asked (absent for a placement). */
  provider?: string;
  /** Words the provider heard (provider attempts only). */
  heard?: number;
  /** heard: every word; partial: some; none: no word. */
  result: 'heard' | 'partial' | 'none';
}

/** A timing provider asked again for a window of the audio: its words in absolute seconds. */
export interface Listener {
  id: string;
  /** How the log names it: "timing provider", "second opinion", "whole file" or "snippets". */
  role: string;
  /** A whole-file hearing of another engine (no request): asked for every unheard stretch, before snippet listeners. */
  whole?: boolean;
  listen(start: number, end: number): Promise<TimedWord[]>;
}

export interface RelistenOptions {
  language?: string;
  duration: number;
  /** First `heard` index for snippet words (after the whole file's timing words, so ranges never collide). */
  heardBase?: number;
}

export interface RelistenDeps {
  listeners: readonly Listener[];
  log?: Logger;
}

/** Does a stretch qualify for sending audio again (see RELISTEN)? */
const worthSending = (s: Stretch): boolean => s.end - s.start >= RELISTEN.minGap || s.last - s.first + 1 >= RELISTEN.minWords;

/** The unheard stretches of aligned words (see RELISTEN), in order; with `all`, every run of interpolated words. */
export function unheardStretches(words: ReadonlyArray<Pick<AlignedWord, 'start' | 'end' | 'match'>>, duration: number, all = false): Stretch[] {
  const out: Stretch[] = [];
  let i = 0;
  while (i < words.length) {
    if (!isUntimed(words[i])) { i++; continue; }
    let j = i;
    while (j + 1 < words.length && isUntimed(words[j + 1])) j++;
    const start = i > 0 ? words[i - 1].end : 0;
    const end = j + 1 < words.length ? words[j + 1].start : Math.max(duration, words[j].end);
    const s = { first: i, last: j, start, end };
    if (all || worthSending(s)) out.push(s);
    i = j + 1;
  }
  return out;
}

/** The context words of a stretch (see RELISTEN): text words [lo, hi] around [s.first, s.last]. */
export function contextOf(words: ReadonlyArray<Pick<AlignedWord, 'start' | 'end'>>, s: Stretch): { lo: number; hi: number } {
  let lo = s.first;
  while (lo > 0 && s.first - lo < RELISTEN.context && (lo === s.first || s.start - words[lo - 1].start <= RELISTEN.contextSeconds)) lo--;
  let hi = s.last;
  while (hi + 1 < words.length && hi - s.last < RELISTEN.context && (hi === s.last || words[hi + 1].end - s.end <= RELISTEN.contextSeconds)) hi++;
  return { lo, hi };
}

/** The window sent for a stretch: the gap plus its context words, padded, inside the media. */
export function windowOf(words: ReadonlyArray<Pick<AlignedWord, 'start' | 'end'>>, s: Stretch, duration: number): { start: number; end: number } {
  const { lo, hi } = contextOf(words, s);
  const from = Math.min(s.start, words[lo].start);
  const to = Math.max(s.end, words[hi].end);
  return { start: roundTime(Math.max(0, from - RELISTEN.pad)), end: roundTime(Math.min(Math.max(duration, to), to + RELISTEN.pad)) };
}

/** The audio actually cut and sent for the window [start, end]: widened to the RELISTEN.grid, inside [0, duration]. */
export function snapWindow(start: number, end: number, duration: number): { start: number; end: number } {
  const g = RELISTEN.grid;
  // a bound already on the grid (within float noise) stays where it is
  const down = (t: number) => Math.floor(t / g + 1e-6) * g;
  const up = (t: number) => Math.ceil(t / g - 1e-6) * g;
  return { start: roundTime(Math.max(0, down(start))), end: roundTime(Math.max(end, Math.min(up(end), duration))) };
}

const fmt = (t: number) => t.toFixed(2);
const quote = (words: readonly AlignedWord[], s: Stretch) => {
  const text = words.slice(s.first, s.last + 1).map((w) => w.text).join(' ');
  return text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
};
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** Per word: the working timing, and what the timing side heard there. */
interface State { timings: Timing[]; heard: Array<Heard | undefined>; speakers: string[] }

/** What one provider heard of a stretch: new times for the anchors and for the stretch words it heard. */
interface Hearing {
  /** Stretch words heard: word index → timing and `heard` record. */
  words: Map<number, { timing: Timing; heard?: Heard }>;
  /** Anchor word index → new start/end (an anchor heard again where it was). */
  anchors: Map<number, { start: number; end: number }>;
}

/**
 * Align the stretch and its context words to the words heard in its window. A stretch word heard where an anchor
 * keeps its time (or beyond it) heard the anchor's audio: it stays unheard.
 */
function alignStretch(texts: readonly string[], state: Readonly<State>, s: Stretch, heardWords: readonly TimedWord[], win: { start: number; end: number }, o: { language?: string; heardBase: number }): Hearing {
  const n = texts.length;
  const none: Hearing = { words: new Map(), anchors: new Map() };
  const { lo, hi } = contextOf(state.timings, s);
  // a provider cannot hear a word outside the audio it was sent
  const inside = heardWords.filter((w) => w.end > win.start - 0.05 && w.start < win.end + 0.05).sort((x, y) => x.start - y.start);
  if (inside.length === 0) return none;
  const aligned = alignWords(texts.slice(lo, hi + 1), inside, { language: o.language, duration: win.end });
  const got = (k: number) => aligned[k - lo];
  const prev = s.first > 0 ? s.first - 1 : undefined;
  const next = s.last + 1 < n ? s.last + 1 : undefined;
  // the outer bounds: the words beyond the anchors keep their times
  const outerLo = prev !== undefined && prev > 0 ? state.timings[prev - 1].end : 0;
  const outerHi = next !== undefined && next + 1 < n ? state.timings[next + 1].start : Infinity;
  const clamp = (t: number) => Math.min(outerHi, Math.max(outerLo, t));
  const anchors = new Map<number, { start: number; end: number }>();
  for (const k of [prev, next]) {
    if (k === undefined) continue;
    const old = state.timings[k];
    const a = got(k);
    // the anchor heard again where it was: it takes the new time (it may have held the stretch's time)
    if (isHeard(a) && a.end > old.start && a.start < old.end) anchors.set(k, { start: clamp(a.start), end: clamp(a.end) });
  }
  const lowest = prev === undefined ? outerLo : (anchors.get(prev)?.end ?? state.timings[prev].end);
  const highest = next === undefined ? outerHi : (anchors.get(next)?.start ?? state.timings[next].start);
  const words = new Map<number, { timing: Timing; heard?: Heard }>();
  for (let k = s.first; k <= s.last; k++) {
    const a = got(k);
    const mid = (a.start + a.end) / 2;
    if (!isHeard(a) || mid <= lowest || mid >= highest) continue;
    const timing: Timing = { start: Math.max(lowest, clamp(a.start)), end: Math.min(highest, clamp(a.end)), speaker: state.speakers[k], match: a.match, confidence: a.confidence };
    words.set(k, { timing, ...(a.heard ? { heard: { text: a.heard.text, first: a.heard.first + o.heardBase, last: a.heard.last + o.heardBase } } : {}) });
  }
  return words.size === 0 ? none : { words, anchors };
}

/**
 * Merge a stretch's hearings into `state`: the one with the most words (first of equals) wins, with its anchors; a
 * word only another heard is added when it fits between its neighbors. Returns the words left unheard.
 */
function apply(state: State, s: Stretch, hearings: readonly Hearing[]): number[] {
  const all: number[] = [];
  for (let k = s.first; k <= s.last; k++) all.push(k);
  const best = hearings.reduce<Hearing | undefined>((b, h) => (h.words.size > (b?.words.size ?? 0) ? h : b), undefined);
  if (!best) return all;
  for (const [k, t] of best.anchors) state.timings[k] = { ...state.timings[k], start: t.start, end: t.end };
  const taken = new Map(best.words);
  for (const h of hearings) {
    if (h === best) continue;
    for (const [k, w] of h.words) {
      if (taken.has(k)) continue;
      let before = s.first > 0 ? state.timings[s.first - 1].end : -Infinity;
      for (let x = k - 1; x >= s.first; x--) if (taken.has(x)) { before = taken.get(x)!.timing.end; break; }
      let after = s.last + 1 < state.timings.length ? state.timings[s.last + 1].start : Infinity;
      for (let x = k + 1; x <= s.last; x++) if (taken.has(x)) { after = taken.get(x)!.timing.start; break; }
      if (w.timing.start >= before - 1e-9 && w.timing.end <= after + 1e-9) taken.set(k, w);
    }
  }
  for (const [k, w] of taken) { state.timings[k] = w.timing; state.heard[k] = w.heard; }
  return all.filter((k) => !taken.has(k));
}

/** Interpolate the words in `open` again between their (new) neighbors, keeping their speakers. */
function reinterpolate(texts: readonly string[], state: State, open: ReadonlySet<number>, o: { duration: number; language?: string }): void {
  if (open.size === 0) return;
  const work: Array<Timing | null> = state.timings.map((t, k) => (open.has(k) ? null : t));
  const secPerChar = speakingRate(texts, work, o.language);
  interpolate(texts, work, { duration: o.duration, minWordDuration: MIN_WORD_DURATION, secPerChar, language: o.language });
  for (const k of open) {
    state.timings[k] = { ...work[k]!, speaker: state.speakers[k] };
    state.heard[k] = undefined;
  }
}

/**
 * Re-listen to the unheard stretches (see RELISTEN), each listener in turn for what is still unheard. Returns the
 * words (same texts and speakers, new times where heard) and the requests sent, for `meta.timingRetries`.
 */
export async function relisten(words: readonly AlignedWord[], o: RelistenOptions, deps: RelistenDeps): Promise<{ words: AlignedWord[]; retries: TimingRetry[] }> {
  const log = deps.log;
  const duration = o.duration;
  const texts = words.map((w) => w.text);
  const state: State = {
    timings: words.map((w) => ({ start: w.start, end: w.end, speaker: w.speaker, match: w.match, confidence: w.confidence })),
    heard: words.map((w) => w.heard),
    speakers: words.map((w) => w.speaker),
  };
  const retries: TimingRetry[] = [];
  let heardBase = o.heardBase ?? 0;
  const current = () => state.timings.map((t) => ({ start: t.start, end: t.end, match: t.match }));
  const view = (): AlignedWord[] => texts.map((text, k) => ({ text, ...state.timings[k] }));
  let changed = false;

  // each stretch of the first alignment: the whole-file hearings, then the snippet listeners for what is still unheard
  const base: State = { timings: state.timings.map((t) => ({ ...t })), heard: [...state.heard], speakers: state.speakers };
  const open = new Set<number>();
  const anyWhole = deps.listeners.some((l) => l.whole);
  for (const s of deps.listeners.length > 0 ? unheardStretches(current(), duration, anyWhole) : []) {
    const n = s.last - s.first + 1;
    const win = windowOf(base.timings, s, duration);
    const what = `${plural(n, 'word')} in ${fmt(s.start)}–${fmt(s.end)} s ("${quote(view(), s)}")`;
    const send = worthSending(s) && win.end - win.start <= RELISTEN.maxWindow;
    if (worthSending(s) && !send) log?.info(`  timing: ${what} have no timing words; the gap is longer than ${RELISTEN.maxWindow} s, so it is not sent again`);
    const hearings: Hearing[] = [];
    let asked = 0;
    for (const listener of deps.listeners) {
      if (!listener.whole && !send) continue;
      if (!listener.whole) log?.info(`  timing: ${asked === 0 ? `${what} have no timing words; asking` : 'asking'} ${listener.id} (${listener.role}) for ${fmt(win.start)}–${fmt(win.end)} s`);
      if (!listener.whole) asked++;
      const heardWords = await listener.listen(win.start, win.end);
      const h = alignStretch(texts, base, s, heardWords, win, { language: o.language, heardBase });
      heardBase += heardWords.length;
      hearings.push(h);
      const got = Math.max(...hearings.map((x) => x.words.size));
      if (!listener.whole) {
        retries.push({ start: roundTime(s.start), end: roundTime(s.end), words: n, provider: listener.id, heard: h.words.size, result: h.words.size === n ? 'heard' : h.words.size > 0 ? 'partial' : 'none' });
        log?.info(`  timing: ${listener.id} heard ${h.words.size === n ? (n === 1 ? 'it' : `all ${n}`) : h.words.size > 0 ? `${h.words.size} of the ${n}` : 'none of them'}${heardWords.length > 0 && h.words.size === 0 ? ` (it heard "${heardWords.map((w) => w.text).join(' ').slice(0, 60)}")` : ''}`);
      } else if (h.words.size > 0) {
        log?.debug(`  timing: ${listener.id} (${listener.role}) heard ${h.words.size} of ${what}`);
      }
      if (got === n) break;
    }
    const left = apply(state, s, hearings);
    if (left.length < n) {
      changed = true;
      for (const k of left) open.add(k);
    }
  }
  reinterpolate(texts, state, open, { duration, language: o.language });

  if (!changed) return { words: words.map((w) => ({ ...w })), retries };
  const out = finalize(texts, state.timings, { duration, minWordDuration: MIN_WORD_DURATION });
  return { words: out.map((w, k) => (state.heard[k] ? { ...w, heard: state.heard[k] } : w)), retries };
}
