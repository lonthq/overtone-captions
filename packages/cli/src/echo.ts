import { alignWords, isHeard } from './align/align.js';
import { langOf } from './lang/index.js';
import { normalizeWords, tokenizeDisplay } from './text/normalize.js';
import type { AlignedWord, TimedWord } from './types.js';

/**
 * Prompt echo: a transcription model copies part of its prompt into the text (seen with gpt-transcribe: a `--context`
 * sentence, word for word, over 8 s of radio call signs). A run of text words is an echo when
 * 1. at least `minWords` of its words match the prompt in order (normalized keys; after 4 matched words, one word plus
 *    one per 10 matched may differ, be added or be left out). A run of glossary terms alone needs `minGlossaryTerms`
 *    whole terms in glossary order, since names on their own are normal speech;
 * 2. and the timing provider does not back it up: under `minSupport` of its words matched timing words (exact, split,
 *    merge, or fuzzy from `minConfidence`). A speaker reading the show's title aloud is heard by the timing provider
 *    too, so that text is kept.
 */
export const ECHO = {
  /** Text words that must match the prompt in order. */
  minWords: 5,
  /** Whole glossary terms a run must cover when it matches nothing but glossary terms. */
  minGlossaryTerms: 3,
  /** A run whose share of words heard by the timing provider is at least this is real speech. */
  minSupport: 0.5,
  /** A fuzzy match counts as heard from this confidence on (a near spelling: "Nichole" ~ "Nicole" is 0.86). */
  minConfidence: 0.75,
} as const;

/** The line that brings the glossary into the transcription prompt (pipeline/prompt.ts). */
export const GLOSSARY_PREFIX = 'Names and terms: ';

/** A run of text words that echoes the prompt: display words `from`..`to` (inclusive) and their aligned times. */
export interface PromptEcho {
  from: number;
  to: number;
  text: string;
  start: number;
  end: number;
  /** Prompt words matched in order. */
  matched: number;
  /** Share of the run's words heard by the timing provider. */
  support: number;
  /** The timing provider's words in the run's span, in time order. */
  heard: string;
}

export interface EchoResult {
  /** The text without the echoed runs (single spaces), or the text as given when there are none. */
  text: string;
  echoes: PromptEcho[];
}

/** A text or prompt word: its key, its display index (text) and its glossary term (prompt). */
interface Token {
  key: string;
  at: number;
  /** -2 outside the glossary line, -1 its prefix, else the glossary term's index. */
  term: number;
}

function promptTokens(prompt: string, lang: string): Token[] {
  const out: Token[] = [];
  for (const line of prompt.split('\n')) {
    if (line.startsWith(GLOSSARY_PREFIX)) {
      const prefix = tokenizeDisplay(GLOSSARY_PREFIX);
      for (const n of normalizeWords(prefix, lang)) if (n.key) out.push({ key: n.key, at: -1, term: -1 });
      const terms = line.slice(GLOSSARY_PREFIX.length).replace(/\.$/, '').split(', ');
      terms.forEach((term, ti) => {
        for (const n of normalizeWords(tokenizeDisplay(term), lang)) if (n.key) out.push({ key: n.key, at: -1, term: ti });
      });
      continue;
    }
    for (const n of normalizeWords(tokenizeDisplay(line), lang)) if (n.key) out.push({ key: n.key, at: -1, term: -2 });
  }
  return out;
}

/** Text tokens `a`..`b - 1` match the prompt; `terms`: glossary terms matched; `other`: any other prompt word matched. */
interface Run { a: number; b: number; matched: number; terms: Set<number>; other: boolean }

/** Extend a match of text token `i` with prompt token `j` as far as it goes, resyncing over single differences. */
function extend(t: readonly Token[], p: readonly Token[], i: number, j: number): Run {
  const eq = (x: number, y: number) => x < t.length && y < p.length && t[x]!.key === p[y]!.key;
  let a = i;
  let b = j;
  let matched = 0;
  let errors = 0;
  let endA = i;
  const terms = new Set<number>();
  let other = false;
  const used: number[] = [];
  while (a < t.length && b < p.length) {
    if (eq(a, b)) {
      used.push(b);
      matched++;
      a++;
      b++;
      endA = a;
      continue;
    }
    if (matched < 4 || errors >= 1 + Math.floor(matched / 10)) break;
    if (eq(a + 1, b + 1) && eq(a + 2, b + 2)) { a++; b++; } // one word differs
    else if (eq(a + 1, b) && eq(a + 2, b + 1)) a++; // a word added
    else if (eq(a, b + 1) && eq(a + 1, b + 2)) b++; // a word left out
    else break;
    errors++;
  }
  for (const u of used) {
    const term = p[u]!.term;
    if (term >= 0) terms.add(term);
    else other = true;
  }
  return { a: i, b: endA, matched, terms, other };
}

/** Heard, with a fuzzy match counting only from ECHO.minConfidence. */
const heardWell = (w: AlignedWord) => isHeard(w) && (w.match !== 'fuzzy' || w.confidence >= ECHO.minConfidence);

/**
 * Every run of `text` that matches `prompt` in order (rule 1 of ECHO) with its timing support, including runs that
 * are backed up and kept. `timingWords`: the timing provider's words in the text's span.
 */
export function promptRuns(text: string, prompt: string | undefined, timingWords: readonly TimedWord[], opts: { language?: string } = {}): PromptEcho[] {
  if (!prompt || !text.trim()) return [];
  const lang = langOf(opts.language);
  const display = tokenizeDisplay(text);
  const t: Token[] = [];
  normalizeWords(display, lang).forEach((n, at) => { if (n.key) t.push({ key: n.key, at, term: -2 }); });
  const p = promptTokens(prompt, lang);
  if (t.length < ECHO.minWords || p.length < ECHO.minWords) return [];
  const where = new Map<string, number[]>();
  p.forEach((tok, j) => where.set(tok.key, [...(where.get(tok.key) ?? []), j]));

  const runs: Run[] = [];
  for (let i = 0; i < t.length;) {
    let best: Run | undefined;
    for (const j of where.get(t[i]!.key) ?? []) {
      const r = extend(t, p, i, j);
      if (!best || r.matched > best.matched) best = r;
    }
    const counts = best && best.matched >= ECHO.minWords && (best.other || best.terms.size >= ECHO.minGlossaryTerms);
    if (counts) { runs.push(best!); i = best!.b; } else i++;
  }
  if (runs.length === 0) return [];

  const timed = [...timingWords].sort((x, y) => x.start - y.start);
  const aligned = alignWords(display, timed, { language: opts.language });
  return runs.map((r) => {
    const from = t[r.a]!.at;
    const to = t[r.b - 1]!.at;
    const words = aligned.slice(from, to + 1);
    const support = words.filter(heardWell).length / words.length;
    const start = Math.min(...words.map((w) => w.start));
    const end = Math.max(...words.map((w) => w.end));
    const heard = timed.filter((w) => w.end > start && w.start < end).map((w) => w.text).join(' ');
    return { from, to, text: display.slice(from, to + 1).join(' '), start, end, matched: r.matched, support: Math.round(support * 100) / 100, heard };
  });
}

/** The runs of `text` that echo `prompt` without timing support (ECHO), and the text without them. */
export function findPromptEcho(text: string, prompt: string | undefined, timingWords: readonly TimedWord[], opts: { language?: string } = {}): EchoResult {
  const echoes = promptRuns(text, prompt, timingWords, opts).filter((r) => r.support < ECHO.minSupport);
  if (echoes.length === 0) return { text, echoes: [] };
  const drop = new Set(echoes.flatMap((e) => Array.from({ length: e.to - e.from + 1 }, (_, k) => e.from + k)));
  return { text: tokenizeDisplay(text).filter((_, k) => !drop.has(k)).join(' '), echoes };
}
