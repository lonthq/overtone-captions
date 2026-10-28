import { STYLE_CLASSES, type Profile, type StyleClass } from 'overtone-format';
import { NAME_PARTICLES, plain } from '../segment/groups.js';
import type { SpeakerWord } from '../turns.js';

/** Classes are dropped in this order when over budget (lowest priority first). */
export const DROP_ORDER: readonly StyleClass[] = ['soft', 'emphasis', 'key', 'number', 'brand'];

export interface StyleSpan { first: number; last: number; classes: StyleClass[] }

/** Set classes from LLM ranges, ignoring invalid ranges and unknown classes. Returns the spans applied. */
export function applyStyles(words: SpeakerWord[], spans: readonly StyleSpan[]): number {
  let applied = 0;
  for (const s of spans) {
    if (!Number.isInteger(s.first) || !Number.isInteger(s.last) || s.first < 0 || s.last < s.first || s.last >= words.length) continue;
    const classes = s.classes.filter((c) => (STYLE_CLASSES as readonly string[]).includes(c));
    if (classes.length === 0) continue;
    for (let i = s.first; i <= s.last; i++) {
      const set = new Set([...(words[i].classes ?? []), ...classes]);
      words[i].classes = STYLE_CLASSES.filter((c) => set.has(c));
    }
    applied++;
  }
  return applied;
}

/** Maximal runs of consecutive words carrying `cls` within [from, to]. */
export function phrases(words: readonly SpeakerWord[], cls: StyleClass, from = 0, to = words.length - 1): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = from; i <= to; i++) {
    if (!words[i].classes?.includes(cls)) continue;
    if (out.length > 0 && out[out.length - 1][1] === i - 1) out[out.length - 1][1] = i;
    else out.push([i, i]);
  }
  return out;
}

function removeClass(words: SpeakerWord[], cls: StyleClass, [a, b]: [number, number]): void {
  for (let i = a; i <= b; i++) {
    const rest = (words[i].classes ?? []).filter((c) => c !== cls);
    if (rest.length > 0) words[i].classes = rest;
    else delete words[i].classes;
  }
}

/** Words of phrase [a, b] that carry only `cls`, so dropping `cls` unstyles them. */
function freedBy(words: readonly SpeakerWord[], cls: StyleClass, [a, b]: [number, number]): number {
  let n = 0;
  for (let i = a; i <= b; i++) if (words[i].classes?.every((c) => c === cls)) n++;
  return n;
}

/**
 * Keep at most `maxRatio` of the words styled: drop whole phrases of the lowest-priority class first, the phrase that
 * frees the most words first (then the largest, then the later). A class on words that keep another class frees
 * nothing, so pass 1 skips it; pass 2 drops in the same order regardless. Returns the phrases dropped.
 */
export function enforceStyleBudget(words: SpeakerWord[], maxRatio: number): number {
  const limit = Math.floor(words.length * maxRatio);
  const styled = () => words.filter((w) => (w.classes?.length ?? 0) > 0).length;
  let dropped = 0;
  for (const mustFree of [true, false]) {
    for (const cls of DROP_ORDER) {
      while (styled() > limit) {
        const list = phrases(words, cls)
          .map((ph) => ({ ph, freed: freedBy(words, cls, ph), size: ph[1] - ph[0] + 1 }))
          .filter((x) => !mustFree || x.freed > 0);
        if (list.length === 0) break;
        list.sort((x, y) => y.freed - x.freed || y.size - x.size || y.ph[0] - x.ph[0]);
        removeClass(words, cls, list[0].ph);
        dropped++;
      }
    }
  }
  return dropped;
}

/** At most `max` key phrases per cue in every profile; extra ones lose the class. Returns the phrases dropped. */
export function enforceKeyPerCue(words: SpeakerWord[], profiles: readonly Profile[], max: number): number {
  let dropped = 0;
  for (const p of profiles) {
    for (const cue of p.cues) {
      const keys = phrases(words, 'key', cue.lines[0].words[0], cue.lines[cue.lines.length - 1].words[1]);
      for (const extra of keys.slice(max)) { removeClass(words, 'key', extra); dropped++; }
    }
  }
  return dropped;
}

/** Lowercase name part without punctuation or possessive: "Dutton's," → "dutton". */
const namePart = (text: string) => plain(text).replace(/'s$/, '');

/** A capitalized word that is not an acronym ("NASA"): possibly part of a personal name. */
const capitalizedName = (text: string) => {
  const letters = text.replace(/[^\p{L}]/gu, '');
  return /^\P{L}*\p{Lu}/u.test(text) && !(letters.length > 1 && letters === letters.toUpperCase());
};

/**
 * The personal name parts in a speaker label ("Jim Dutton (NASA)" → jim, dutton): capitalized words without acronyms,
 * parenthesized parts and particles ("van der"). Undefined below two parts: a role ("Host") or a single name is too
 * ambiguous to match.
 */
export function personName(label: string): string[] | undefined {
  const parts = label.replace(/\([^)]*\)/g, ' ').split(/\s+/).filter((w) => w && capitalizedName(w)).map(namePart).filter((p) => p.length >= 2);
  return parts.length >= 2 ? parts : undefined;
}

/**
 * People are never brands: a branded run (up to punctuation) loses "brand" when every word is a name part of a speaker
 * label (personName) or a particle. "Jim Dutton," loses it; "Jim Beam" and "Dutton Industries" keep it. Returns the
 * words changed.
 */
export function unbrandPeople(words: SpeakerWord[], names: readonly string[]): number {
  const parts = new Set(names.flatMap((n) => personName(n) ?? []));
  if (parts.size === 0) return 0;
  const isPart = (w: SpeakerWord) => capitalizedName(w.text) && parts.has(namePart(w.text));
  const isParticle = (w: SpeakerWord) => NAME_PARTICLES.has(w.text);
  const branded = (i: number) => words[i]?.classes?.includes('brand') ?? false;
  let changed = 0;
  for (let i = 0; i < words.length; i++) {
    if (!branded(i)) continue;
    let j = i;
    while (!/[\p{P}]$/u.test(words[j].text) && branded(j + 1)) j++;
    const run = words.slice(i, j + 1);
    if (run.every((w) => isPart(w) || isParticle(w)) && run.some(isPart)) {
      for (const w of run) {
        const rest = w.classes!.filter((c) => c !== 'brand');
        if (rest.length > 0) w.classes = rest;
        else delete w.classes;
        changed++;
      }
    }
    i = j;
  }
  return changed;
}
