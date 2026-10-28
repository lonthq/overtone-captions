// The text vote: where the hearings disagree about the words, the text engine re-listens the snippet and the chooser
// decides. assessVote holds the few checks on its answer.
import { langOf } from '../lang/index.js';
import type { Logger } from '../log.js';
import type { LlmProvider } from '../providers/types.js';
import type { RefusalSink } from '../refusals.js';
import { runLimited } from '../refine/llm-steps.js';
import { flatSimilarity } from '../text/similarity.js';
import { tokenizeDisplay } from '../text/normalize.js';
import { soundSimilarity } from './phonetics.js';
import { choose, type ChooserAnswer, type ChooserItem } from './choose.js';
import { findRegions, phraseKey, REGIONS, wordKey, type EngineWords, type Region, type TextWord } from './regions.js';
import type { TimedWord } from '../types.js';
import { nonOverlapping } from '../util/ranges.js';

/** The vote's limits. */
export const VOTE = {
  /** Seconds of audio around a region in the snippet re-listen. */
  pad: 2.5,
  /** Words of caption text before the snippet sent as its prompt (at most `promptChars` characters). */
  promptWords: 40,
  promptChars: 300,
  /** Snippet re-listens in flight at once (Azure OpenAI's S0 tier answers 4 at once with 429s). */
  concurrency: 2,
} as const;

/** Best sound similarity (±1 syllable) of `line` to any non-empty hearing; spelling similarity in scripts without letter-to-sound rules. */
export function soundsLike(line: string, hearings: readonly string[], language: string): number {
  let best = 0;
  for (const h of hearings) {
    if (!h.trim()) continue;
    const s = soundSimilarity(line, h, language);
    if (!s.phonetic || Math.abs(s.syllables[0] - s.syllables[1]) <= 1) best = Math.max(best, s.similarity);
  }
  return best;
}

/** One region the vote looked at, for `meta.textVotes` and the log. */
export interface TextVote {
  start: number;
  end: number;
  class: Region['cls'];
  /** The caption's words there ('' for a place between words). */
  from: string;
  /** The words now there (the same as `from` when kept). */
  to: string;
  /** kept: the chooser kept it; rejected:<why>: the change failed a check. */
  result: 'changed' | 'kept' | `rejected:${string}`;
  /** What the engines and the snippet re-listen heard there. */
  heard: Record<string, string>;
  /** The chooser's reason, when it proposed a change. */
  basis?: string;
  /** A change no engine or re-listen heard: why it is on the review list. */
  review?: string;
}

export interface VoteInput {
  /** The caption's words with their aligned times. */
  words: readonly TextWord[];
  /** Whole file plus snippet re-listens. */
  engines: readonly EngineWords[];
  language: string;
  duration: number;
  /** The engine with the most precise times; splits regions at pauses. */
  precise?: number;
  /** The engine whose words are the caption (the text engine gave none); it does not vote. */
  textIsEngine?: number;
  /** How the chooser prompt names the text engine. */
  textEngine?: string;
  context?: string;
  names?: readonly string[];
}

export interface VoteDeps {
  /** Snippet re-listen with the text engine of [start, end] with `prompt`; '' for nothing. */
  relisten?: (start: number, end: number, prompt: string | undefined) => Promise<string>;
  llm?: LlmProvider;
  log?: Logger;
  /** Told about a chooser request the provider refused. */
  onRefusal?: RefusalSink;
}

const charSimilarity = (a: string, b: string) => (a === b ? 1 : flatSimilarity(a, b));

/**
 * mapBack's alignment: spellings less alike than `noMatch` cost a gap; a substitution costs `substitution` × its
 * dissimilarity, a little more than a gap, so loosely alike words do not pair; matches at least `anchor` good bound
 * the stretch.
 */
const MAP_BACK = { noMatch: 0.2, substitution: 1.2, anchor: 0.75 } as const;

/**
 * The words of re-listen `hyp` that stand where window words [a, b] stand (b < a: the place before a). Aligned by
 * spelling; the stretch lies between the nearest confident matches.
 */
export function mapBack(window: readonly string[], hyp: readonly string[], a: number, b: number): string[] {
  const O = window.map(wordKey);
  const Hk = hyp.map(wordKey);
  const n = O.length;
  const m = Hk.length;
  const d = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) d[i]![0] = i;
  for (let j = 1; j <= m; j++) d[0]![j] = j;
  const sub = (i: number, j: number) => (1 - Math.max(0, charSimilarity(O[i]!, Hk[j]!) - MAP_BACK.noMatch) / (1 - MAP_BACK.noMatch)) * MAP_BACK.substitution;
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) d[i]![j] = Math.min(d[i - 1]![j - 1]! + sub(i - 1, j - 1), d[i - 1]![j]! + 1, d[i]![j - 1]! + 1);
  const pairOf = new Array<number>(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (Math.abs(d[i]![j]! - (d[i - 1]![j - 1]! + sub(i - 1, j - 1))) < 1e-9) { pairOf[i - 1] = j - 1; i--; j--; }
    else if (Math.abs(d[i]![j]! - (d[i - 1]![j]! + 1)) < 1e-9) i--;
    else j--;
  }
  let hL = -1;
  let hR = m;
  for (let k = a - 1; k >= 0; k--) if (pairOf[k]! >= 0 && charSimilarity(O[k]!, Hk[pairOf[k]!]!) >= MAP_BACK.anchor) { hL = pairOf[k]!; break; }
  for (let k = b + 1; k < n; k++) if (pairOf[k]! >= 0 && charSimilarity(O[k]!, Hk[pairOf[k]!]!) >= MAP_BACK.anchor) { hR = pairOf[k]!; break; }
  return hyp.slice(hL + 1, Math.max(hL + 1, hR));
}

/** Non-overlapping occurrences of the key sequence `k` in `keys`. */
function occurrences(k: readonly string[], keys: readonly string[]): number {
  let n = 0;
  for (let i = 0; i + k.length <= keys.length;) {
    if (k.every((x, j) => keys[i + j] === x)) { n++; i += k.length; } else i++;
  }
  return n;
}

/**
 * Does inserting `text` repeat the caption words next to it? True when those words (as many as the insertion on each
 * side, plus those within REGIONS.window seconds) contain its phrase and no voting engine heard it there more often.
 * This is an alignment artifact: words more than REGIONS.window apart look missing. A repeat the engines heard twice
 * where the caption has it once is still inserted.
 */
export function repeatsCaption(r: Region, text: string, words: readonly TextWord[], engineWords: ReadonlyArray<readonly TimedWord[]>, language: string): boolean {
  if (r.last >= r.first || words.length === 0) return false;
  const k = phraseKey(text, language).split(' ').filter(Boolean);
  if (k.length === 0) return false;
  const n = tokenizeDisplay(text).length;
  const lo = Math.max(0, r.first - n);
  const hi = Math.min(words.length - 1, r.first + n - 1);
  if (hi < lo) return false;
  const from = Math.min(r.start, words[lo]!.start) - REGIONS.window;
  const to = Math.max(r.end, words[hi]!.end) + REGIONS.window;
  const within = (w: { start: number; end: number }) => { const m = (w.start + w.end) / 2; return m >= from && m <= to; };
  const keysOf = (ws: ReadonlyArray<{ text: string }>) => phraseKey(ws.map((w) => w.text).join(' '), language).split(' ').filter(Boolean);
  const caption = occurrences(k, keysOf(words.filter((w, i) => (i >= lo && i <= hi) || within(w))));
  if (caption === 0) return false;
  return engineWords.every((ws) => occurrences(k, keysOf(ws.filter(within))) <= caption);
}

/** What acceptChange needs besides the region and the answer. */
export interface ChangeContext {
  language: string;
  engineText: readonly string[];
  relisten: string;
  showRelisten: boolean;
  words?: readonly TextWord[];
  engineWords?: ReadonlyArray<readonly TimedWord[]>;
}

/** A change's verdict: why it is not applied (null: applied), and why it goes on the review list. */
export interface VoteVerdict { why: string | null; review?: string }

/**
 * The checks on a chooser's change. The chooser judges the words; code rejects only an empty change, an insertion that
 * repeats its neighbors (repeatsCaption), and a class a or b change the snippet re-listen contradicts (the chooser
 * does not get that audio for those classes). A reading no hearing had goes on the review list.
 */
export function assessVote(r: Region, answer: ChooserAnswer, o: ChangeContext): VoteVerdict {
  const lang = o.language;
  if (!answer.text.trim()) return { why: 'empty' };
  if (o.words && repeatsCaption(r, answer.text, o.words, o.engineWords ?? [], lang)) return { why: 'repeat' };
  // two engines can agree and both be wrong ("then" heard as "and"): a re-listen closer to the caption than to the
  // change vetoes a class a or b change
  if ((r.cls === 'a' || r.cls === 'b') && o.relisten.trim()) {
    const change = soundsLike(answer.text, [o.relisten], lang);
    const caption = r.text.trim() ? soundsLike(r.text, [o.relisten], lang) : 0;
    if (caption > change) return { why: 'relisten' };
  }
  const key = phraseKey(answer.text, lang);
  if ([...o.engineText, o.relisten].some((h) => h.trim() && phraseKey(h, lang) === key)) return { why: null };
  return { why: null, review: `the chooser wrote "${answer.text}"; no engine heard it so there` };
}

/** Why a change is not applied (null: applied); see assessVote. */
export function acceptChange(r: Region, answer: ChooserAnswer, o: ChangeContext): string | null {
  return assessVote(r, answer, o).why;
}

/**
 * Vote on the caption's words: returns the new display words and every region looked at. Without an LLM or regions,
 * the words stay.
 */
export async function vote(input: VoteInput, deps: VoteDeps): Promise<{ words: string[]; votes: TextVote[] }> {
  const { words: T, engines, language } = input;
  const keep = { words: T.map((w) => w.text), votes: [] as TextVote[] };
  if (!deps.llm || T.length + engines.reduce((n, e) => n + e.words.length, 0) === 0) return keep;
  const regions = findRegions(T, engines, { language, precise: input.precise, textIsEngine: input.textIsEngine });
  const engineWords = engines.filter((_, x) => x !== input.textIsEngine).map((e) => e.words);
  if (regions.length === 0) return keep;
  const log = deps.log;
  log?.info(`  vote: ${regions.length} region${regions.length === 1 ? '' : 's'} where the hearings disagree (${(['a', 'b', 'c'] as const).map((c) => `${regions.filter((r) => r.cls === c).length} ${c}`).join(', ')})`);

  // 1) re-listen each region's snippet with the text engine; the prompt is the caption text before it
  const relistened = await runLimited(regions.map((r) => async () => {
    if (!deps.relisten) return { span: '', whole: '' };
    const start = Math.max(0, r.start - VOTE.pad);
    const end = Math.min(input.duration, r.end + VOTE.pad);
    const inside = T.map((w, i) => ({ w, i })).filter(({ w }) => w.end > start + 0.05 && w.start < end - 0.05);
    const prior = T.filter((w) => w.end <= start + 0.05).slice(-VOTE.promptWords).map((w) => w.text).join(' ').slice(-VOTE.promptChars).trim();
    const whole = (await deps.relisten(start, end, prior || undefined)).trim();
    if (!whole) return { span: '', whole: '' };
    const a = inside.filter(({ i }) => i < r.first).length;
    const b = a + (r.last - r.first);
    return { span: mapBack(inside.map(({ w }) => w.text), whole.split(/\s+/).filter(Boolean), a, b).join(' '), whole };
  }), VOTE.concurrency);

  // 2) the chooser
  const text = T.map((w) => w.text);
  const items: ChooserItem[] = regions.map((r, k) => ({
    region: r,
    before: text.slice(Math.max(0, r.first - 40), r.first).join(' '),
    after: text.slice(r.last + 1, r.last + 41).join(' '),
    ...(r.cls === 'c' ? { relisten: relistened[k]! } : {}),
  }));
  const answers = await choose(deps.llm, items, engines, { language, context: input.context, names: input.names ?? [], textEngine: input.textEngine, textIsEngine: input.textIsEngine, ...(deps.onRefusal ? { onRefusal: deps.onRefusal } : {}) });

  // 3) the checks, then the changes from the end so indices stay valid
  const votes: TextVote[] = [];
  const changes: Array<{ r: Region; to: string[]; vote: number; answer: ChooserAnswer }> = [];
  regions.forEach((r, k) => {
    const engineText = r.heard.map((ws, e) => (e === input.textIsEngine ? '' : ws.map((w) => w.text).join(' ')));
    const heard: Record<string, string> = {};
    engines.forEach((e, x) => { if (x !== input.textIsEngine) heard[e.id] = engineText[x]!; });
    heard.relisten = relistened[k]!.span;
    const base = { start: Math.round(r.start * 1000) / 1000, end: Math.round(r.end * 1000) / 1000, class: r.cls, from: r.text, heard };
    const answer = answers.get(r.id);
    const same = answer !== undefined && phraseKey(answer.text, language) === phraseKey(r.text, language);
    if (!answer || answer.decision === 'keep' || same || (!r.text.trim() && !answer.text.trim())) {
      votes.push({ ...base, to: r.text, result: 'kept' });
      return;
    }
    const v = assessVote(r, answer, { language, engineText, relisten: relistened[k]!.span, showRelisten: r.cls === 'c', words: T, engineWords });
    const why = v.why;
    if (why) {
      votes.push({ ...base, to: r.text, result: `rejected:${why}`, basis: `${answer.text} (${answer.basis})` });
      log?.info(`  vote: kept "${r.text}" at ${r.start.toFixed(1)} s; the change to "${answer.text}" failed the ${why} check`);
      return;
    }
    changes.push({ r, to: tokenizeDisplay(answer.text), vote: votes.length, answer });
    votes.push({ ...base, to: answer.text, result: 'changed', basis: answer.basis, ...(v.review ? { review: v.review } : {}) });
    log?.info(`  vote: ${r.text.trim() ? `"${r.text}" → ` : 'inserted '}"${answer.text}" at ${r.start.toFixed(1)} s (${answer.basis})`);
  });
  const out = [...text];
  // from the end; at one index a replacement goes before an insertion (which then lands in front of it), and of two
  // insertions the later one first
  const isInsert = (r: Region) => (r.last < r.first ? 1 : 0);
  const ordered = [...changes].sort((x, y) => y.r.first - x.r.first || isInsert(x.r) - isInsert(y.r) || y.r.start - x.r.start);
  // a change overlapping an earlier accepted one would splice away its words, so it is rejected
  const { overlapping } = nonOverlapping([...ordered].reverse(), (c) => c.r);
  for (const c of overlapping) {
    const v = votes[c.vote]!;
    votes[c.vote] = { ...v, to: v.from, result: 'rejected:overlap', basis: `${c.answer.text} (${c.answer.basis})` };
    log?.info(`  vote: kept "${c.r.text}" at ${c.r.start.toFixed(1)} s; the change to "${c.answer.text}" overlaps another change`);
  }
  for (const c of ordered) if (!overlapping.includes(c)) out.splice(c.r.first, c.r.last - c.r.first + 1, ...c.to);
  return { words: out, votes };
}
