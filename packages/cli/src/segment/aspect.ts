import { parseAspect, type ProfileRules } from 'overtone-format';
import type { ResolvedProfile } from '../config.js';
import type { RuleSet } from './rulesets/index.js';

/** Common shapes a media's aspect snaps to when within SNAP of one. */
const COMMON = ['16:9', '3:2', '8:5', '4:3', '5:4', '1:1', '4:5', '5:8', '3:4', '2:3', '9:16'];
const SNAP = 0.02;

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** "1:1" → "1x1": a profile id for an aspect given in --profiles. */
export function aspectId(aspect: string): string {
  return aspect.replace(':', 'x');
}

/** "1:1" or "1x1" → "1:1"; undefined for a token that is not an aspect (a name such as "horizontal"). */
export function tokenAspect(token: string): string | undefined {
  const m = /^([1-9][0-9]*)[:x]([1-9][0-9]*)$/.exec(token);
  return m ? `${m[1]}:${m[2]}` : undefined;
}

/**
 * The id of the profile among `available` that `token` names: the id itself, or for an aspect written W:H or WxH
 * the profile with that id ("1:1" and "1x1" both name "1x1"; "2:2" names "2x2", else "1x1"). Undefined when none.
 */
export function findProfileId(available: readonly string[], token: string): string | undefined {
  if (available.includes(token)) return token;
  const aspect = tokenAspect(token);
  if (aspect === undefined) return undefined;
  return [aspectId(aspect), aspectId(reduceAspect(aspect))].find((id) => available.includes(id));
}

/**
 * Rules for a picture of `aspect`: each value interpolated linearly in ln(aspect) between the rule set's vertical
 * and horizontal profiles, clamped outside them. maxCharsPerLine and maxLines round to integers, the rest to 2
 * decimals.
 */
export function rulesFor(ruleset: RuleSet, aspect: string): ProfileRules {
  const wide = ruleset.profiles.horizontal;
  const tall = ruleset.profiles.vertical;
  const lo = Math.log(parseAspect(tall.aspect));
  const hi = Math.log(parseAspect(wide.aspect));
  const t = Math.min(1, Math.max(0, (Math.log(parseAspect(aspect)) - lo) / (hi - lo)));
  const mix = (a: number | undefined, b: number | undefined) => (a ?? b ?? 0) + t * ((b ?? a ?? 0) - (a ?? b ?? 0));
  const out: ProfileRules = {
    maxCharsPerLine: Math.round(mix(tall.rules.maxCharsPerLine, wide.rules.maxCharsPerLine)),
    maxLines: Math.round(mix(tall.rules.maxLines, wide.rules.maxLines)),
  };
  for (const key of ['maxCps', 'minDuration', 'maxDuration'] as const) {
    if (tall.rules[key] !== undefined || wide.rules[key] !== undefined) out[key] = round2(mix(tall.rules[key], wide.rules[key]));
  }
  return out;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** "2:2" → "1:1", "32:18" → "16:9": an aspect "W:H" reduced by the greatest common divisor. */
export function reduceAspect(aspect: string): string {
  const [w, h] = aspect.split(':').map(Number);
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

/**
 * The aspect of a width × height picture: a common ratio within 2%, else the reduced pixel ratio. Both sizes are
 * rounded to integers first (a probe may report 1919.7); they must be at least 1 after rounding (mediaProfile checks).
 */
export function snapAspect(width: number, height: number): string {
  const w = Math.round(width);
  const h = Math.round(height);
  const ratio = w / h;
  const near = COMMON.find((a) => Math.abs(parseAspect(a) / ratio - 1) <= SNAP);
  return near ?? reduceAspect(`${w}:${h}`);
}

const sameRules = (a: ProfileRules, b: ProfileRules) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A profile for the media's own shape, or undefined when one of `profiles` already gets the same rules (rulesFor: a
 * 21:9 video adds nothing next to 16:9) or the shape is unknown (width or height not finite and ≥ 1 after rounding).
 */
export function mediaProfile(profiles: readonly ResolvedProfile[], shape: { width: number; height: number }, ruleset: RuleSet): ResolvedProfile | undefined {
  const valid = (n: number) => Number.isFinite(n) && Math.round(n) >= 1;
  if (!valid(shape.width) || !valid(shape.height)) return undefined;
  const aspect = snapAspect(shape.width, shape.height);
  const rules = rulesFor(ruleset, aspect);
  if (profiles.some((p) => sameRules(rulesFor(ruleset, p.aspect), rules))) return undefined;
  return { id: aspectId(aspect), description: `${aspect} (the media)`, aspect, rules };
}
