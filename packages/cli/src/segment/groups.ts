import { SHARED, rulesOf, type Lang, type LineRules } from '../lang/index.js';
import { normalizeText, normalizeWords, trimApostrophes, unifyApostrophes } from '../text/normalize.js';
import { endsSentence } from '../turns.js';
import { LATEST_RULESET, type RuleSet } from './rulesets/index.js';

/** Lowercase particles inside surnames ("van", "von", "di"), from all language packs. */
export const NAME_PARTICLES: ReadonlySet<string> = SHARED.nameParticles;

/** Capitalized sentence openers that are not part of a following name, from all language packs. */
const SENTENCE_OPENERS: ReadonlySet<string> = SHARED.sentenceOpeners;

/**
 * Lowercase display word without punctuation, apostrophes and accents kept, as the line-cutting lists write words:
 * "Month." → "month", "M’n" → "m'n", and "één" typed as e + combining accent → "één".
 */
export function plain(text: string): string {
  return trimApostrophes(unifyApostrophes(text.normalize('NFC')).replace(/[^\p{L}\p{M}\p{N}']/gu, ''));
}

/** Inclusive [first, last] word ranges of number groups ("€12 a month", "one in five", "twaalf euro per maand"). */
function numberGroups(texts: readonly string[], lang: Lang): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const norm = normalizeWords(texts, lang);
  const key = (i: number) => norm[i]?.key ?? '';
  const isNumberHead = (i: number) => i < texts.length && !norm[i].cont && /^\d/.test(key(i));
  const groupEnd = (i: number) => { let j = i; while (j + 1 < texts.length && norm[j + 1].cont) j++; return j; };
  const rate = rulesOf(lang).rates;
  for (let i = 0; i < texts.length; i++) {
    if (!isNumberHead(i)) continue;
    let end = groupEnd(i);
    // a comma or a sentence end after the number closes it: "I paid €12, a month later", "one, in five years"
    if (rate && !clauseEndAt(texts, end)) {
      const a = plain(texts[end + 1] ?? '');
      const b = plain(texts[end + 2] ?? '');
      if (rate.per.has(a) && rate.periods.has(b.replace(/s$/, ''))) end += 2;
      else if (rate.ratio.has(a)) {
        let n = end + 2;
        // "two out of three", "één op de vijf"
        const follower = rate.ratioFollowers[a];
        if (follower !== undefined && plain(texts[n] ?? '') === follower) n++;
        if (isNumberHead(n)) end = groupEnd(n);
      }
    }
    out.push([i, end]);
    i = end;
  }
  return out;
}

/** tails[i] = true when word i ends a multi-word number group ("one in five", "€12 a month"). */
export function numberGroupEnds(texts: readonly string[], lang: Lang): boolean[] {
  const tails = texts.map(() => false);
  for (const [from, to] of numberGroups(texts, lang)) if (to > from) tails[to] = true;
  return tails;
}

/**
 * keep[i] = true: never break between words i and i+1. Covers number groups ("€12 a month", "één op de vijf"),
 * multi-word glossary terms and names (capitalized runs of at most breaks.maxNameWords: "Maya van der Berg").
 */
export function noBreakAfter(texts: readonly string[], lang: Lang, glossary: readonly string[], ruleset: RuleSet = LATEST_RULESET): boolean[] {
  const maxNameWords = ruleset.breaks.maxNameWords;
  const keep = texts.map(() => false);
  const norm = normalizeWords(texts, lang);
  const key = (i: number) => norm[i]?.key ?? '';
  const join = (from: number, to: number) => { for (let k = from; k < to; k++) keep[k] = true; };
  for (const [from, to] of numberGroups(texts, lang)) join(from, to);

  for (const term of glossary) {
    const parts = normalizeText(term, lang).split(' ').filter(Boolean);
    if (parts.length < 2) continue;
    for (let i = 0; i + parts.length <= texts.length; i++) {
      if (parts.every((p, k) => key(i + k) === p)) join(i, i + parts.length - 1);
    }
  }

  // Names: capitalized runs with lowercase particles between ("Maya van der Berg"). A run may start a sentence
  // unless its first word is a sentence opener ("Yesterday", "De"). All-caps words and single-word glossary terms
  // (brands) are not name parts.
  const brands = new Set(glossary.filter((g) => g.trim().split(/\s+/).length === 1).map((g) => plain(g)));
  const capital = (t: string) => {
    if (!/^["'“‘(]?\p{Lu}/u.test(t) || plain(t) === 'i' || brands.has(plain(t))) return false;
    const letters = t.replace(/[^\p{L}]/gu, '');
    return !(letters.length > 1 && letters === letters.toUpperCase());
  };
  const stops = (t: string) => endsSentence(t) || /[,;:]["'”’)]*$/.test(t);
  for (let i = 0; i + 1 < texts.length; i++) {
    if (!capital(texts[i])) continue;
    if ((i === 0 || endsSentence(texts[i - 1])) && SENTENCE_OPENERS.has(plain(texts[i]))) continue;
    let end = i;
    let words = 1;
    while (words < maxNameWords && !stops(texts[end])) {
      let k = end + 1;
      while (k < texts.length && NAME_PARTICLES.has(plain(texts[k])) && !capital(texts[k]) && !stops(texts[k])) k++;
      if (k >= texts.length || !capital(texts[k])) break;
      end = k;
      words++;
    }
    if (end > i) {
      join(i, end);
      i = end;
    }
  }
  return keep;
}

/** Does word i end a sentence, judged with its neighbors ("so do I." does, the initial in "J. Smith" does not)? */
export function sentenceEndAt(texts: readonly string[], i: number): boolean {
  return i >= 0 && i < texts.length && endsSentence(texts[i], { prev: texts[i - 1], next: texts[i + 1] });
}

/** True when word i ends a sentence or a clause (comma, semicolon, colon, dash): a line may end on it. */
export function clauseEndAt(texts: readonly string[], i: number): boolean {
  return sentenceEndAt(texts, i) || /[,;:]["'”’)]*$/.test(texts[i]) || /\s[-–—]$/.test(texts[i]);
}

/**
 * A lowercase common adjective or intensifier ("new", "very"), a hyphenated modifier ("five-year") or a word
 * with a typical adjective ending ("operational").
 */
function adjectiveLike(text: string, rules: LineRules): boolean {
  const p = plain(text);
  if (!/^\p{Ll}/u.test(text) || rules.notAdjectives.has(p)) return false;
  if (/^\p{Ll}[\p{L}\p{N}]*(-[\p{L}\p{N}]+)+$/u.test(text)) return true;
  return rules.adjectives.has(p) || (p.length >= 6 && rules.adjectiveSuffixes.some((s) => p.endsWith(s)));
}

/** A lowercase content word: not an article, preposition, auxiliary, conjunction or pronoun. */
function contentWord(text: string, rules: LineRules): boolean {
  const p = plain(text);
  return /^\p{Ll}/u.test(text) && !rules.noLineEnd.has(p) && !rules.conjunctions.has(p) && !rules.pronouns.has(p);
}

/**
 * The kind of pronoun a line ending after word i ends on: "subject" = a subject pronoun or relative word that opens
 * what follows ("we | affectionately call", "walk through what | they're doing"); "other" = one that may be an object
 * or demonstrative ("thank you | so much", "did what | was right"). None before a preposition ("thank you | for") or
 * punctuation, for "before that | I flew", or for the subject closing a question head (questionHeadAt).
 */
export function pronounEndAt(texts: readonly string[], lang: Lang, i: number, ruleset: RuleSet = LATEST_RULESET): 'subject' | 'other' | undefined {
  const rules = rulesOf(lang).lineCutting;
  if (!rules || clauseEndAt(texts, i)) return undefined;
  const p = plain(texts[i]);
  if (!rules.pronouns.has(p) || questionHeadAt(texts, lang, i, ruleset)) return undefined;
  const next = texts[i + 1];
  if (next === undefined || rules.prepositions.has(plain(next))) return undefined;
  // "and before that | I flew": a demonstrative after a preposition closes its phrase when a new one follows
  // (not in "with that | car")
  const opensPhrase = /^\P{L}*\p{Lu}/u.test(next) || rules.pronouns.has(plain(next)) || rules.conjunctions.has(plain(next));
  if (i > 0 && rules.demonstratives.has(p) && rules.prepositions.has(plain(texts[i - 1])) && opensPhrase) return undefined;
  if (rules.subjectPronouns.has(p)) return 'subject';
  return rules.clauseWords.has(p) && !verbLike(texts, rules, i - 1) ? 'subject' : 'other';
}

/**
 * Does word i, an auxiliary, close a question opening ("How did | the project start?", "Where are | you going?")?
 * Then a line may end on it. The question word must open the sentence or clause (also after "and", "so"; not
 * "that's what is | needed"), and a pronoun, article, possessive or capitalized word must follow (not
 * "What is | needed"). False when logic.questionAuxiliary is off.
 */
export function invertedAuxiliaryAt(texts: readonly string[], lang: Lang, i: number, ruleset: RuleSet = LATEST_RULESET): boolean {
  const rules = rulesOf(lang).lineCutting;
  if (!ruleset.logic.questionAuxiliary || !rules || i < 1 || i + 1 >= texts.length || clauseEndAt(texts, i) || clauseEndAt(texts, i - 1)) return false;
  if (!rules.auxiliaries.has(plain(texts[i])) || !rules.questionWords.has(plain(texts[i - 1]))) return false;
  let k = i - 2;
  if (k >= 0 && rules.lineStartConjunctions.has(plain(texts[k]))) k--;
  if (k >= 0 && !clauseEndAt(texts, k)) return false;
  const next = texts[i + 1];
  const p = plain(next);
  return rules.pronouns.has(p) || rules.articles.has(p) || rules.possessives.has(p) || /^\P{L}*\p{Lu}/u.test(next);
}

/** A subject pronoun, or a pronoun that may be one ("you"), but not a clause word or demonstrative ("what", "that"). */
function subjectLike(rules: LineRules, p: string): boolean {
  return rules.subjectPronouns.has(p) || (rules.pronouns.has(p) && !rules.clauseWords.has(p) && !rules.demonstratives.has(p));
}

/** An auxiliary, or a contraction that opens with one ("don't" → "do not", "won't" → "will not"). */
function auxiliaryLike(text: string, rules: LineRules, lang: Lang): boolean {
  if (rules.auxiliaries.has(plain(text))) return true;
  const pieces = normalizeText(text, lang).split(' ');
  return pieces.length > 1 && rules.auxiliaries.has(pieces[0]);
}

/**
 * Does word i, a subject pronoun, close a question head after its auxiliary ("Why don't you | just admit", "Can
 * you | tell me")? Then a line may end on it. The auxiliary (or a contraction opening with one) must open the
 * sentence or clause, or follow a question word that does (also after "and", "so"). Not for a clause word or
 * demonstrative ("Do what | you want", "Is that | car yours?"). False when logic.questionHead is off.
 */
export function questionHeadAt(texts: readonly string[], lang: Lang, i: number, ruleset: RuleSet = LATEST_RULESET): boolean {
  const rules = rulesOf(lang).lineCutting;
  if (!ruleset.logic.questionHead || !rules || i < 1 || i + 1 >= texts.length || clauseEndAt(texts, i) || clauseEndAt(texts, i - 1)) return false;
  if (!subjectLike(rules, plain(texts[i])) || !auxiliaryLike(texts[i - 1], rules, lang)) return false;
  let k = i - 2;
  if (k >= 0 && rules.questionWords.has(plain(texts[k]))) k--;
  if (k >= 0 && rules.lineStartConjunctions.has(plain(texts[k]))) k--;
  return k < 0 || clauseEndAt(texts, k);
}

/**
 * Is word i an auxiliary used as the main verb, between a subject pronoun and its object's article or possessive
 * ("You have | your robotics", "we did | the work")? Then a line may end on it. False when logic.mainVerb is off.
 */
export function mainVerbAt(texts: readonly string[], lang: Lang, i: number, ruleset: RuleSet = LATEST_RULESET): boolean {
  const rules = rulesOf(lang).lineCutting;
  if (!ruleset.logic.mainVerb || !rules || i < 1 || i + 1 >= texts.length || clauseEndAt(texts, i) || clauseEndAt(texts, i - 1)) return false;
  if (!rules.auxiliaries.has(plain(texts[i])) || !subjectLike(rules, plain(texts[i - 1]))) return false;
  const next = plain(texts[i + 1]);
  return rules.articles.has(next) || rules.possessives.has(next);
}

/** A lowercase word that can be a verb before an object pronoun ("thank | you", "did | that", "heb | ze"). */
function verbLike(texts: readonly string[], rules: LineRules, i: number): boolean {
  if (i < 0 || clauseEndAt(texts, i)) return false;
  const p = plain(texts[i]);
  return /^\p{Ll}/u.test(texts[i]) && !rules.articles.has(p) && !rules.prepositions.has(p) && !rules.conjunctions.has(p)
    && !rules.pronouns.has(p);
}

/** The words a break is judged in, with `keep` (noBreakAfter), `tails` (numberGroupEnds) and the rule set (default: latest). */
export interface BreakContext {
  texts: readonly string[];
  keep: readonly boolean[];
  lang: Lang;
  tails?: readonly boolean[];
  ruleset?: RuleSet;
}

/**
 * Soft cost of ending a line or cue after word i; lower is better (costs: the rule set's `breaks`). `lineStart`: the
 * first word of the line ending here, so a sentence that starts the line is not "cut off". `hesitation`: weight
 * (0..1, hesitationWeight) of the pause after the break. The break shows that pause, so its text penalties are waived
 * by that weight, at weight 1 down to the cost of a break after a comma (logic.hesitationWaiver). `keep` words and the
 * noun after a number group keep their cost.
 */
export function breakCost(ctx: BreakContext, i: number, o: { lineStart?: number; hesitation?: number } = {}): number {
  const { texts, keep, lang, tails } = ctx;
  const lineStart = o.lineStart ?? 0;
  const ruleset = ctx.ruleset ?? LATEST_RULESET;
  const B = ruleset.breaks;
  const w = texts[i];
  const next = texts[i + 1];
  const ended = clauseEndAt(texts, i);
  const rules = rulesOf(lang).lineCutting;
  let cost: number;
  if (sentenceEndAt(texts, i)) cost = B.sentenceEnd;
  else if (ended) cost = B.clauseEnd;
  else if (next !== undefined && rules?.conjunctions.has(plain(next))) cost = B.beforeConjunction;
  else cost = B.other;
  const base = cost;
  if (rules && !ended) {
    const p = plain(w);
    const pronoun = pronounEndAt(texts, lang, i, ruleset);
    if (rules.noLineEnd.has(p)) cost += invertedAuxiliaryAt(texts, lang, i, ruleset) || mainVerbAt(texts, lang, i, ruleset) ? 0 : B.noLineEnd;
    else if (pronoun) cost += pronoun === 'other' && verbLike(texts, rules, i - 1) ? B.weakPronounEnd : B.pronounEnd;
    else if (rules.contractedPronouns.has(p)) cost += B.weakPronounEnd;
    else if (next !== undefined && adjectiveLike(w, rules) && contentWord(next, rules)) cost += B.adjectiveEnd;
    if (rules.lineStartConjunctions.has(p) && cost >= B.other) cost += B.conjunctionLineEnd;
  }
  // a sentence that starts just before the break, or ends just after it, is cut off from the rest of it
  if (!ended && next !== undefined) {
    if (i - 1 >= lineStart && sentenceEndAt(texts, i - 1)) cost += B.sentenceEdge;
    else if (i - 2 >= lineStart && sentenceEndAt(texts, i - 2) && !clauseEndAt(texts, i - 1)) cost += B.nearSentenceEdge;
    if (sentenceEndAt(texts, i + 1)) cost += B.sentenceEdge;
    else if (sentenceEndAt(texts, i + 2) && !clauseEndAt(texts, i + 1)) cost += B.nearSentenceEdge;
  }
  const text = cost;
  const weight = o.hesitation ?? 0;
  if (ruleset.logic.hesitationWaiver && weight > 0) cost -= weight * (cost - Math.min(base, B.clauseEnd));
  if (keep[i]) cost += B.keep;
  // right after a number group ("one in five | drivers") the noun it counts is cut off from it
  else if (tails?.[i] && text >= B.other && next !== undefined) cost += B.groupTail;
  return cost;
}
