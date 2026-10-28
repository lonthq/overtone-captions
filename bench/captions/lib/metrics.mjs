// Readability rule checks on a caption track (definitions: README.md, "Metrics"). Every check reads the track's
// own text, with the word lists and sentence/clause/name/number detection of Overtone's language packs
// (packages/cli/src/lang, segment/groups.ts), so a system is judged on its own punctuation and casing.
//
// Pauses (timed tracks, see tracks.mjs timeTrack; each system's own word times): a break followed by a pause of at
// least HESITATION_PAUSE (0.5 s, see lib/overtone-src.ts) is an expressive break. It shows the hesitation, so
// no rule check counts it; it is counted in `waived` instead. A 1–3-word cue is exempt when both its edges are such
// a pause, a speaker change or the clip edge; a lone-word line when a line or cue break next to it is; an
// unbalanced two-line cue when its line break is. The same definitions as bench/experiments/2026-10-18-pauses/v2
// (metrics.mjs) at T = 0.5 s.
import { flatten } from './tracks.mjs';

/** The rule checks a pause can waive (all of them except the length, line-count and timing checks). */
export const WAIVABLE = ['badEnd', 'pronounEnd', 'adjNounSplit', 'groupSplit', 'sentenceStartAtEnd', 'sentenceEndCarried', 'loneWordLines', 'shortFragmentCues', 'unbalanced'];

/**
 * Counts for one track. Each metric is { n, of } (a count and its denominator), so clips can be pooled by adding
 * counts; a few distributions (cps, balance) are kept as raw values. `n` leaves out the hits at a pause (see
 * above); `waived[metric]` counts those.
 */
export function ruleCounts(track, { lang, maxChars, maxLines = 2, ot }) {
  const T = ot.HESITATION_PAUSE;
  const FORCE = ot.FORCE_BREAK_PAUSE;
  const lc = ot.rulesOf(lang).lineCutting;
  const pack = ot.getPack(lang).lineCutting ?? {};
  const classes = {
    article: new Set(pack.articles ?? []),
    preposition: new Set(pack.prepositions ?? []),
    possessive: new Set(pack.possessives ?? []),
    auxiliary: new Set(pack.auxiliaries ?? []),
    conjunction: new Set(pack.lineStartConjunctions ?? []),
  };
  const words = flatten(track);
  const texts = words.map((w) => w.text);
  const keep = ot.noBreakAfter(texts, lang, []);
  const P = ot.plain;
  const clauseEnd = (i) => i >= 0 && i < texts.length && ot.clauseEndAt(texts, i);
  const sentenceEnd = (i) => ot.sentenceEndAt(texts, i);

  // adjective + noun, as in groups.ts (adjectiveLike / contentWord; not exported there)
  const adjectiveLike = (t) => {
    const p = P(t);
    if (!lc || !/^\p{Ll}/u.test(t) || lc.notAdjectives.has(p)) return false;
    if (/^\p{Ll}[\p{L}\p{N}]*(-[\p{L}\p{N}]+)+$/u.test(t)) return true;
    return lc.adjectives.has(p) || (p.length >= 6 && lc.adjectiveSuffixes.some((s) => p.endsWith(s)));
  };
  const contentWord = (t) => {
    const p = P(t);
    return !!lc && /^\p{Ll}/u.test(t) && !lc.noLineEnd.has(p) && !lc.conjunctions.has(p) && !lc.pronouns.has(p);
  };

  const c = (n = 0, of = 0) => ({ n, of });
  const m = {
    breaks: c(), badEnd: c(), badEndByClass: Object.fromEntries(Object.keys(classes).map((k) => [k, 0])),
    pronounEnd: c(), adjNounSplit: c(), groupSplit: c(), sentenceStartAtEnd: c(), sentenceEndCarried: c(),
    lineBreaks: 0, cueBreaks: 0,
    lines: c(), overLimit: c(), loneWordLines: c(),
    cues: c(), overTwoLines: c(), twoLineCues: c(), shortCues: c(), shortFragmentCues: c(),
    cps17: c(), cps20: c(), under1s: c(), over7s: c(), unbalanced: c(),
    words: words.length, chars: 0, seconds: 0, cps: [], balance: [],
    // pauses: breaks followed by a pause >= T, rule hits waived there, and the same-speaker pauses of T to FORCE
    // seconds (shorter than FORCE: those always end a cue) shown as a cue break, a line break or hidden in a line
    timed: track.pauses ? 1 : 0, hesitationBreaks: c(), waived: Object.fromEntries(WAIVABLE.map((k) => [k, 0])),
    pauses: { n: 0, cue: 0, line: 0, hidden: 0, seconds: 0, shownSeconds: 0 },
  };
  for (const p of track.pauses ?? []) {
    if (p.gap < T || p.gap >= FORCE) continue;
    m.pauses.n++;
    m.pauses.seconds += p.gap;
    if (p.brk) { m.pauses[p.brk]++; m.pauses.shownSeconds += p.gap; } else m.pauses.hidden++;
  }
  // the silence after a line's last word (timed tracks; -Infinity = unknown, never a pause)
  const gapAfter = (line) => line?.after?.gap ?? -Infinity;
  /** A cue edge: a pause of at least T, a speaker change or the clip edge. */
  const edge = (line) => !line || (line.after ? !line.after.same || line.after.gap >= T : false);

  // breaks: every word with more text after it on another line or in another cue
  words.forEach((w, i) => {
    if (!w.brk) return;
    m.breaks.of++;
    if (w.brk === 'line') m.lineBreaks++; else m.cueBreaks++;
    const p = P(w.text);
    const ended = clauseEnd(i);
    const atPause = (w.after?.gap ?? -Infinity) >= T;
    m.hesitationBreaks.of++;
    if (atPause) m.hesitationBreaks.n++;
    const hit = (name, yes) => {
      m[name].of++;
      if (!yes) return;
      if (atPause) m.waived[name]++;
      else m[name].n++;
    };
    const cls = ended ? undefined : Object.keys(classes).find((k) => classes[k].has(p));
    hit('badEnd', !!cls);
    if (cls && !atPause) m.badEndByClass[cls]++;
    hit('pronounEnd', ot.pronounEndAt(texts, lang, i) === 'subject');
    hit('adjNounSplit', !ended && adjectiveLike(w.text) && contentWord(texts[i + 1]));
    hit('groupSplit', keep[i]);
    // a new sentence starts in the last one or two words before the break ("That's correct. I | think")
    hit('sentenceStartAtEnd', !ended && ((i - 1 >= w.lineStart && sentenceEnd(i - 1))
      || (i - 2 >= w.lineStart && sentenceEnd(i - 2) && !clauseEnd(i - 1))));
    // the last one or two words of a sentence are carried over the break ("the 2004 | class.")
    hit('sentenceEndCarried', !ended && (sentenceEnd(i + 1) || (sentenceEnd(i + 2) && !clauseEnd(i + 1))));
  });

  let at = 0; // index of the cue's first word in `words`
  /** Count a cue-level hit, unless `exempt` (a pause shows it). */
  const cueHit = (name, yes, exempt) => {
    m[name].of++;
    if (!yes) return;
    if (exempt) m.waived[name]++;
    else m[name].n++;
  };
  let prevLast; // the last line of the previous cue
  for (const cue of track.cues) {
    const n = cue.lines.reduce((s, l) => s + l.words.length, 0);
    m.cues.of++;
    const chars = cue.lines.reduce((s, l) => s + l.text.length, 0) + cue.lines.length - 1;
    const dur = Math.max(0.001, cue.end - cue.start);
    m.chars += chars;
    m.seconds += dur;
    const cps = chars / dur;
    m.cps.push(cps);
    const yes = (metric, v) => { metric.of++; if (v) metric.n++; };
    yes(m.overTwoLines, cue.lines.length > maxLines);
    yes(m.twoLineCues, cue.lines.length === 2);
    yes(m.cps17, cps > 17);
    yes(m.cps20, cps > 20);
    yes(m.under1s, dur < 1);
    yes(m.over7s, dur > 7);
    yes(m.shortCues, n <= 3);
    // a 1–3-word cue that is not a sentence of its own ("Watch out!" is one; "every single" is not)
    const first = at;
    const last = at + n - 1;
    const wholeSentence = (first === 0 || sentenceEnd(first - 1)) && (sentenceEnd(last) || last === words.length - 1);
    const timed = !!cue.lines[0].after;
    cueHit('shortFragmentCues', n <= 3 && !wholeSentence, timed && edge(prevLast) && edge(cue.lines.at(-1)));
    cue.lines.forEach((line, l) => {
      m.lines.of++;
      if (line.text.length > maxChars && line.words.length > 1) m.overLimit.n++;
      m.overLimit.of++;
      // a line of one word in a multi-line cue, unless it is a top line that ends a clause ("Okay." / "Well,")
      const lone = cue.lines.length > 1 && line.words.length === 1
        && !(l === 0 && clauseEnd(at + cue.lines.slice(0, l).reduce((s, x) => s + x.words.length, 0)));
      // exempt when a line break next to it sits at a pause
      const g = Math.max(l < cue.lines.length - 1 ? gapAfter(line) : -Infinity, l > 0 ? gapAfter(cue.lines[l - 1]) : -Infinity);
      cueHit('loneWordLines', lone, g >= T);
    });
    if (cue.lines.length === 2) {
      const [top, bottom] = cue.lines.map((l) => l.text.length);
      m.balance.push(bottom / top);
      cueHit('unbalanced', Math.min(top, bottom) / Math.max(top, bottom) < 0.5, gapAfter(cue.lines[0]) >= T);
    }
    prevLast = cue.lines.at(-1);
    at += n;
  }
  return m;
}

/** Add the counts of several ruleCounts results (for pooling clips). */
export function poolCounts(list) {
  const out = structuredClone(list[0]);
  for (const r of list.slice(1)) {
    for (const [k, v] of Object.entries(r)) {
      if (Array.isArray(v)) out[k].push(...v);
      else if (typeof v === 'number') out[k] += v;
      else if (v && 'of' in v) { out[k].n += v.n; out[k].of += v.of; }
      else for (const [kk, vv] of Object.entries(v)) out[k][kk] += vv;
    }
  }
  return out;
}

export const pct = (x) => (x.of ? (100 * x.n) / x.of : NaN);
/** Pauses of 0.5–1.5 s shown as a cue or line break, as { n, of } (for pct). */
export const shown = (p) => ({ n: p.cue + p.line, of: p.n });
/** A rule's count without the pause exemption (hits at a pause included). */
export const raw = (m, name) => ({ n: m[name].n + m.waived[name], of: m[name].of });
export const median = (xs) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
