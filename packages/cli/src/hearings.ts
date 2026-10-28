// Turns the hearings into the caption's words, times and speakers. pipeline/align.ts calls it with live (cached)
// providers, the regression gate (test/bench/run.ts) with frozen answers.
// 1. Times: each text word takes the time the most precise engine heard. Misses fall back to the other engines'
//    whole-file words, then to snippet re-listens (align/relisten.ts); the rest get an unknown time (align/fill.ts).
// 2. Words: where the hearings disagree, the text vote decides (reconcile/vote.ts).
// 3. Speakers: from the engine that tells speakers apart best (align/speakers.ts).
// Stretched words are trimmed (STRETCHED_WORD); sentence starts heard in the music move to their sentence (STRAY_FRAGMENT).
import { roundTime } from 'overtone-format';
import { alignWords, isUntimed, MIN_WORD_DURATION } from './align/align.js';
import { naturalLength, speakingRate, splitSpan, spokenLength } from './align/rate.js';
import { relisten, type Listener, type TimingRetry } from './align/relisten.js';
import { assignSpeakers } from './align/speakers.js';
import { isFiller, langOf } from './lang/index.js';
import type { Logger } from './log.js';
import type { RefusalSink } from './refusals.js';
import type { LlmProvider } from './providers/types.js';
import { loadPhonetics, usesDictionary } from './reconcile/phonetics.js';
import { vote, type TextVote } from './reconcile/vote.js';
import { normalizeText } from './text/normalize.js';
import { endsSentence } from './turns.js';
import type { AlignedWord, TimedWord } from './types.js';

/** One engine's hearing of the whole file. */
export interface EngineHearing {
  /** Provider id ("azure-speech", "elevenlabs:scribe_v2"). */
  id: string;
  /** How the chooser prompt and the log name it ("Azure Speech"). */
  label: string;
  words: readonly TimedWord[];
  /** Sends a snippet to this engine again (absolute times in and out). Absent: no snippet requests. */
  listen?: (start: number, end: number) => Promise<TimedWord[]>;
}

export interface HearInput {
  /** The text hearing as display words (an engine's words where the text engine gave none). */
  text: readonly string[];
  /** The engines, timing provider first. */
  engines: readonly EngineHearing[];
  /** Index of the engine whose times are used (the most precise one). */
  timeBy: number;
  /** Index of the engine whose speakers are used. */
  speakersBy: number;
  /** Index of the engine whose words the whole text is (the text engine gave none); it does not vote. */
  textIsEngine?: number;
  /** How the chooser prompt names the text engine. Default gpt-transcribe. */
  textEngine?: string;
  language: string;
  duration: number;
  /** For the chooser: what the media is about, plus names and terms. */
  context?: string;
  names?: readonly string[];
}

export interface HearDeps {
  /** Snippet re-listen with the text engine ('' for nothing). No vote without it and `llm`. */
  relistenText?: (start: number, end: number, prompt: string | undefined) => Promise<string>;
  /** The chooser of the vote. */
  llm?: LlmProvider;
  log?: Logger;
  /** Told about a chooser request the provider refused. */
  onRefusal?: RefusalSink;
}

export interface HearResult {
  words: AlignedWord[];
  /** Snippet requests for timing (`meta.timingRetries`). */
  retries: TimingRetry[];
  /** Every region the vote looked at (`meta.textVotes`). */
  votes: TextVote[];
}

/**
 * Words of `extra` where `base` has none within `margin` seconds. Overlapping snippets hear a word twice: the same
 * word starting within 0.15 s is added once. Different words this close are both kept ("I am ready" in fast speech).
 */
export function withSnippets(base: readonly TimedWord[], extra: readonly TimedWord[], margin = 0.3): TimedWord[] {
  const added: TimedWord[] = [];
  const key = (w: TimedWord) => w.text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]/gu, '');
  for (const w of extra) {
    const mid = (w.start + w.end) / 2;
    if (base.some((o) => o.start - margin < mid && mid < o.end + margin)) continue;
    if (added.some((o) => Math.abs(o.start - w.start) < 0.15 && key(o) === key(w))) continue;
    added.push(w);
  }
  return [...base, ...added].sort((a, b) => a.start - b.start);
}

/**
 * A word timed this long was stretched over what followed (music, a pause): its start holds, its end is unknown.
 * Stretched: longer than `seconds` and than `perChar` seconds per spoken character (so a long compound is not). No
 * real word in the regression gate's fixtures is longer than 3 s.
 */
export const STRETCHED_WORD = { seconds: 3, perChar: 0.4 } as const;

/** `words` where each stretched word (STRETCHED_WORD) ends after its natural length at the engine's speaking rate. */
export function trimStretched(words: readonly TimedWord[], language: string | undefined): TimedWord[] {
  const lang = langOf(language);
  const stretched = (w: TimedWord) => {
    const d = w.end - w.start;
    return d > STRETCHED_WORD.seconds && d > STRETCHED_WORD.perChar * spokenLength(w.text, lang);
  };
  if (!words.some(stretched)) return [...words];
  const rate = speakingRate(words.map((w) => w.text), words.map((w) => ({ start: w.start, match: 'exact' })), language);
  return words.map((w) => (stretched(w) ? { ...w, end: roundTime(Math.min(w.end, w.start + naturalLength(w.text, rate, MIN_WORD_DURATION, lang))) } : w));
}

/** An engine's hearing with stretched words trimmed, also in the snippets it is sent. */
function trimmedHearing(e: EngineHearing, language: string, log?: Logger): EngineHearing {
  const words = trimStretched(e.words, language);
  words.forEach((w, k) => {
    const was = e.words[k]!;
    if (w !== was) log?.info(`  timing: ${e.label} timed "${w.text}" ${(was.end - was.start).toFixed(1)} s long (${was.start.toFixed(2)}–${was.end.toFixed(2)} s); it ends after its natural length`);
  });
  const listen = e.listen;
  return { ...e, words, ...(listen ? { listen: async (s: number, t: number) => trimStretched(await listen(s, t), language) } : {}) };
}

/**
 * Sentence starts timed far before the rest were heard in the music or noise before the speech. A fragment of at most
 * `maxWords` words, separated from its sentence by a pause over `gap` seconds, takes an unknown time just before the
 * rest, unless another engine heard its first word within `agree` seconds. In the regression gate every in-sentence
 * pause over 5 s was an engine error; the longest real pause was 3.5 s.
 */
export const STRAY_FRAGMENT = { gap: 5, maxWords: 3, agree: 1 } as const;

/** A fragment placeStrays moved: its word keys, the stretch before its sentence it may have been heard in, its new times. */
export interface StrayMove { keys: string[]; before: [number, number]; spans: Array<[number, number]> }

/**
 * Moves each stray fragment just before the rest of its sentence, at natural length, with an unknown time and the
 * rest's speaker. `others`: the other engines' words, for the check.
 */
export function placeStrays(words: readonly AlignedWord[], others: ReadonlyArray<readonly TimedWord[]>, language: string, log?: Logger): { words: AlignedWord[]; moves: StrayMove[] } {
  const lang = langOf(language);
  const out = [...words];
  const moves: StrayMove[] = [];
  const key = (text: string) => normalizeText(text, lang);
  let rate: number | undefined;
  let s = 0;
  for (let e = 0; e < out.length; e++) {
    if (!endsSentence(out[e]!.text, { prev: out[e - 1]?.text, next: out[e + 1]?.text, last: e === out.length - 1 })) continue;
    const first = s;
    s = e + 1;
    let g = e - 1;
    while (g >= first && out[g + 1]!.start - out[g]!.end <= STRAY_FRAGMENT.gap) g--;
    if (g < first || g - first + 1 > STRAY_FRAGMENT.maxWords) continue;
    const lead = out[first]!;
    const k = key(lead.text);
    if (others.some((ws) => ws.some((w) => Math.abs(w.start - lead.start) <= STRAY_FRAGMENT.agree && key(w.text) === k))) continue;
    rate ??= speakingRate(out.map((w) => w.text), out, language);
    const next = out[g + 1]!;
    const texts = out.slice(first, g + 1).map((w) => w.text);
    const natural = texts.reduce((sum, t) => sum + naturalLength(t, rate!, MIN_WORD_DURATION, lang), 0);
    const prevEnd = first > 0 ? out[first - 1]!.end : 0;
    log?.info(`  timing: "${texts.join(' ')}" was timed ${(next.start - out[g]!.end).toFixed(1)} s before the rest of its sentence (${lead.start.toFixed(2)} s); it now sits just before "${next.text}"`);
    const spans = splitSpan(Math.max(prevEnd, next.start - natural), next.start, texts.map((t) => spokenLength(t, lang))).map(([a, b]): [number, number] => [roundTime(a), roundTime(b)]);
    // the old `heard` span says nothing about the new time
    spans.forEach(([a, b], j) => {
      const { heard: _heard, ...w } = out[first + j]!;
      out[first + j] = { ...w, start: a, end: b, speaker: next.speaker, match: 'interpolated', confidence: 0 };
    });
    moves.push({ keys: texts.map(key), before: [prevEnd, next.start - STRAY_FRAGMENT.gap], spans });
  }
  return { words: out, moves };
}

/**
 * An engine's words with the moved stray fragments (`moves`) placed where the caption now has them, so the text vote
 * does not compare them against the music. Engine words alone cannot show strays: snippet words have no punctuation.
 */
export function moveHeardStrays(words: readonly TimedWord[], moves: readonly StrayMove[], language: string): TimedWord[] {
  if (moves.length === 0) return [...words];
  const lang = langOf(language);
  const out = [...words];
  for (const m of moves) {
    let from = 0;
    m.keys.forEach((k, j) => {
      const at = out.findIndex((w, i) => i >= from && w.start >= m.before[0] && w.start < m.before[1] && normalizeText(w.text, lang) === k);
      if (at < 0) return;
      out[at] = { ...out[at]!, start: m.spans[j]![0], end: m.spans[j]![1] };
      from = at + 1;
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Times for `text`: the time engine, then the others' whole-file words, then snippet listeners. `snippetWords`: per
 * engine, the words its snippets returned; pass 1 (`snippets`) sends the requests and fills it, pass 2 reuses it.
 */
async function timeText(
  text: readonly string[], engines: readonly EngineHearing[], timeBy: number,
  o: { language: string; duration: number; snippets: boolean }, snippetWords: TimedWord[][], log?: Logger,
): Promise<{ words: AlignedWord[]; retries: TimingRetry[]; moves: StrayMove[] }> {
  const time = engines[timeBy]!;
  const first = alignWords(text, time.words, { language: o.language, duration: o.duration });
  const order = [timeBy, ...engines.map((_, k) => k).filter((k) => k !== timeBy)];
  // listeners that send no request
  const inHand = (e: EngineHearing, role: string, words: readonly TimedWord[]): Listener[] => words.length === 0 ? [] : [{
    id: e.id, role, whole: true, listen: async (s: number, t: number) => words.filter((w) => w.end > s && w.start < t),
  }];
  // the time engine's own whole-file words are already aligned; its snippet words (pass 2) are not
  const ownSnippets = inHand(time, 'snippets', snippetWords[timeBy]!);
  const otherEngines = order.slice(1).flatMap((k) => inHand(engines[k]!, 'whole file', withSnippets(engines[k]!.words, snippetWords[k]!)));
  const requests: Listener[] = !o.snippets ? [] : order.flatMap((k) => {
    const e = engines[k]!;
    if (!e.listen) return [];
    return [{
      id: e.id, role: k === 0 ? 'timing provider' : 'second opinion',
      listen: async (s: number, t: number) => {
        const got = await e.listen!(s, t);
        snippetWords[k]!.push(...got);
        return got;
      },
    }];
  });
  // pass 1 has no snippet words yet: only the other engines' whole-file words, then the snippet requests
  const listeners = o.snippets ? [...otherEngines, ...requests] : [...ownSnippets, ...otherEngines];
  const { words, retries } = await relisten(first, { language: o.language, duration: o.duration, heardBase: time.words.length }, { listeners, log });
  // pass 2 times the vote's words again: its strays were already logged in pass 1
  const others = order.slice(1).map((k) => withSnippets(engines[k]!.words, snippetWords[k]!));
  return { ...placeStrays(words, others, o.language, o.snippets ? log : undefined), retries };
}

/** From the hearings to the caption's words (see the file header). */
export async function hear(input: HearInput, deps: HearDeps = {}): Promise<HearResult> {
  const { language, duration } = input;
  const log = deps.log;
  const engines = input.engines.map((e) => trimmedHearing(e, language, log));
  const snippetWords: TimedWord[][] = engines.map(() => []);
  // 1) times, with snippet requests where nothing was heard
  const first = await timeText(input.text, engines, input.timeBy, { language, duration, snippets: true }, snippetWords, log);
  let words = first.words;
  let votes: TextVote[] = [];
  // 2) the text vote
  if (deps.llm && engines.length > 0) {
    // English sounds come from the CMU dictionary (downloaded on first use)
    if (usesDictionary(language)) await loadPhonetics({ log });
    const voters = engines.map((e, k) => ({ id: e.id, label: e.label, words: moveHeardStrays(withSnippets(e.words, snippetWords[k]!), first.moves, language) }));
    const result = await vote({
      words: words.map((w) => ({ text: w.text, start: w.start, end: w.end, untimed: isUntimed(w) })),
      engines: voters, language, duration, precise: input.timeBy, textIsEngine: input.textIsEngine,
      ...(input.textEngine ? { textEngine: input.textEngine } : {}), context: input.context, names: input.names,
    }, { relisten: deps.relistenText, llm: deps.llm, log, ...(deps.onRefusal ? { onRefusal: deps.onRefusal } : {}) });
    votes = result.votes;
    if (votes.some((v) => v.result === 'changed')) {
      // time the new words from the hearings already made (no new requests)
      words = (await timeText(result.words, engines, input.timeBy, { language, duration, snippets: false }, snippetWords, log)).words;
    }
  }
  // 3) speakers from the engine that tells them apart best
  if (input.speakersBy !== input.timeBy && engines[input.speakersBy]) {
    words = assignSpeakers(words, withSnippets(engines[input.speakersBy]!.words, snippetWords[input.speakersBy]!));
  }
  return { words, retries: first.retries, votes };
}

/** Speakers that count when engines are compared: at least this many words, or this share of the engine's words. */
const SPEAKER_MIN = { words: 5, share: 0.02 } as const;

/** Distinct speakers an engine heard (SPEAKER_MIN). */
export function speakersHeard(words: readonly TimedWord[]): number {
  const counts = new Map<string, number>();
  for (const w of words) if (w.speaker !== undefined) counts.set(w.speaker, (counts.get(w.speaker) ?? 0) + 1);
  return [...counts.values()].filter((n) => n >= SPEAKER_MIN.words || n >= SPEAKER_MIN.share * words.length).length;
}

/**
 * The engine whose speakers are used: the one that told more voices apart, else the time engine (its speakers need no
 * mapping by time).
 */
export function speakerEngine(engines: readonly EngineHearing[], timeBy: number): number {
  let best = timeBy;
  let most = speakersHeard(engines[timeBy]?.words ?? []);
  engines.forEach((e, k) => {
    const n = speakersHeard(e.words);
    if (n > most) { best = k; most = n; }
  });
  return best;
}

/** Words whose midpoint lies in [start, end); with `last`, also a word ending at the very end. */
export function wordsInSpan(words: readonly TimedWord[], start: number, end: number, last = false): TimedWord[] {
  return words.filter((w) => {
    const mid = (w.start + w.end) / 2;
    return mid >= start && (mid < end || (last && mid <= end + 0.5));
  });
}

/** An engine's display words inside [start, end), for where the text engine gave none. */
export function engineText(words: readonly TimedWord[], start: number, end: number, last = false): string {
  return wordsInSpan(words, start, end, last).map((w) => w.text).join(' ');
}

const LABELS: Record<string, string> = {
  'azure-speech': 'Azure Speech', elevenlabs: 'ElevenLabs Scribe', openai: 'OpenAI', 'azure-openai': 'Azure OpenAI',
  'whisper-cpp': 'whisper.cpp', recorded: 'a recorded engine',
};
/** How the log and the chooser prompt name a provider ("azure-speech:fast" → "Azure Speech"). */
export function providerLabel(id: string): string {
  return LABELS[id.split(':')[0]!] ?? id;
}

/**
 * Stretches an engine heard that no word of `text` aligns with: at least `minWords` words (fillers not counted) over
 * at least `minSeconds`. For the --text-file warning; that text is kept as given.
 */
export function unmatchedStretches(text: readonly string[], engineWords: readonly TimedWord[], language: string | undefined, o = { minWords: 15, minSeconds: 6 }): Array<{ start: number; end: number; words: number }> {
  const sorted = [...engineWords].sort((a, b) => a.start - b.start);
  const used = new Set<number>();
  for (const w of alignWords(text, sorted, { language })) if (w.heard) for (let k = w.heard.first; k <= w.heard.last; k++) used.add(k);
  const lang = langOf(language);
  const out: Array<{ start: number; end: number; words: number }> = [];
  let run: TimedWord[] = [];
  const flush = () => {
    const words = run.filter((w) => !isFiller(normalizeText(w.text, lang), lang)).length;
    if (run.length > 0 && words >= o.minWords && run[run.length - 1]!.end - run[0]!.start >= o.minSeconds) out.push({ start: run[0]!.start, end: run[run.length - 1]!.end, words });
    run = [];
  };
  sorted.forEach((w, k) => { if (used.has(k)) flush(); else run.push(w); });
  flush();
  return out;
}

/**
 * The engine preferred for times and missing text: the second hearing when it heard any words (it is the most
 * precise), else the timing provider. An empty second hearing has nothing to give.
 */
export function preferredEngine(engines: readonly EngineHearing[]): number {
  return engines.length > 1 && engines[1]!.words.length > 0 ? 1 : 0;
}

/** A span whose text came from an engine because the text engine gave none (`meta.fallbacks`). */
export interface Fallback { start: number; end: number; reason: string; source: string }

/**
 * The text base: the text engine's chunks, where an empty chunk takes the preferred engine's words, else the first
 * other engine that heard words there. `textIsEngine`: every chunk came from one engine, which then does not vote.
 */
export function textBase<C extends { start: number; end: number; text: string }>(
  chunks: readonly C[], engines: readonly EngineHearing[], o: { duration: number },
): { chunks: Array<C & { source?: string }>; fallbacks: Fallback[]; textIsEngine?: number } {
  const from = preferredEngine(engines);
  const order = engines.map((_, i) => i).sort((a, b) => Number(b === from) - Number(a === from));
  const fallbacks: Fallback[] = [];
  const used: number[] = [];
  const out = chunks.map((c, k): C & { source?: string } => {
    if (c.text.trim()) return { ...c };
    for (const i of order) {
      const engine = engines[i]!;
      const text = engineText(engine.words, c.start, c.end, k === chunks.length - 1);
      if (!text) continue;
      used.push(i);
      fallbacks.push({ start: c.start, end: Math.min(c.end, o.duration), source: engine.id, reason: `the text provider returned no text for this span, also when retried; using ${engine.label}'s words` });
      return { ...c, text, source: engine.id };
    }
    return { ...c };
  });
  const only = used[0];
  const all = only !== undefined && used.length === out.length && used.every((i) => i === only);
  return { chunks: out, fallbacks, ...(all ? { textIsEngine: only } : {}) };
}

