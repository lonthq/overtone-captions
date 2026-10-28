import { ASPECT_PATTERN } from './aspect.js';
import {
  checkTime,
  checkWordRange,
  describe,
  forEachItem,
  isNonEmptyString,
  isObject,
  isPositiveInteger,
  isPositiveNumber,
  type Obj,
  type Report,
  type WordInfo,
} from './validate-utils.js';

/** Profile ids end up in file names and CSS classes, so only safe characters are allowed. Keep in sync with overtone.schema.json. */
export const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Validates the profiles array. `words` is undefined when the turns are invalid; word-based checks are then skipped. */
export function validateProfiles(
  value: unknown,
  speakerIds: Set<string>,
  words: WordInfo[] | undefined,
  report: Report,
): void {
  if (!Array.isArray(value)) return report('profiles', 'must be an array');
  const ids = new Set<string>();
  forEachItem(value, (profile, i) => {
    const path = `profiles[${i}]`;
    if (!isObject(profile)) return report(path, 'must be an object');
    if (!isNonEmptyString(profile.id)) report(`${path}.id`, 'must be a non-empty string');
    else if (!PROFILE_ID_PATTERN.test(profile.id)) report(`${path}.id`, "must contain only letters, digits, '-' and '_'");
    else if (ids.has(profile.id)) report(`${path}.id`, `duplicate profile id "${profile.id}"`);
    else ids.add(profile.id);
    if (profile.description !== undefined && typeof profile.description !== 'string') {
      report(`${path}.description`, 'must be a string');
    }
    if (typeof profile.aspect !== 'string' || !ASPECT_PATTERN.test(profile.aspect)) {
      report(`${path}.aspect`, 'must be a ratio "W:H" of two positive integers without leading zeros, such as "16:9"');
    }
    validateWindow(profile.window, `${path}.window`, report);
    validateRules(profile.rules, `${path}.rules`, report);
    validateCues(profile.cues, `${path}.cues`, speakerIds, words, report);
  });
}

function validateWindow(value: unknown, path: string, report: Report): void {
  if (value === undefined) return;
  if (!isObject(value)) return report(path, 'must be an object');
  const start = checkTime(value, 'start', path, report);
  const end = checkTime(value, 'end', path, report);
  if (start !== undefined && end !== undefined && end <= start) report(path, 'start must be before end');
}

function validateRules(value: unknown, path: string, report: Report): void {
  if (!isObject(value)) return report(path, 'must be an object');
  for (const key of ['maxCharsPerLine', 'maxLines']) {
    if (!isPositiveInteger(value[key])) report(`${path}.${key}`, 'must be a positive integer');
  }
  for (const key of ['maxCps', 'minDuration', 'maxDuration']) {
    if (value[key] !== undefined && !isPositiveNumber(value[key])) report(`${path}.${key}`, 'must be a positive number');
  }
}

function validateCues(
  value: unknown,
  path: string,
  speakerIds: Set<string>,
  words: WordInfo[] | undefined,
  report: Report,
): void {
  if (!Array.isArray(value)) return report(path, 'must be an array');
  let previousEnd: number | undefined;
  forEachItem(value, (cue, i) => {
    const cuePath = `${path}[${i}]`;
    if (!isObject(cue)) return report(cuePath, 'must be an object');
    const start = checkTime(cue, 'start', cuePath, report);
    const end = checkTime(cue, 'end', cuePath, report);
    if (start !== undefined && end !== undefined && end <= start) report(`${cuePath}.end`, 'must be after start');
    if (start !== undefined && previousEnd !== undefined && start < previousEnd) {
      report(`${cuePath}.start`, 'overlaps the previous cue (cues must be ordered and non-overlapping)');
    }
    previousEnd = end ?? previousEnd;
    const speakerOk = typeof cue.speaker === 'string' && speakerIds.has(cue.speaker);
    if (!speakerOk) report(`${cuePath}.speaker`, `unknown speaker "${describe(cue.speaker)}"`);
    validateLines(cue, cuePath, speakerOk ? (cue.speaker as string) : undefined, words, report);
  });
}

function validateLines(
  cue: Obj,
  cuePath: string,
  speaker: string | undefined,
  words: WordInfo[] | undefined,
  report: Report,
): void {
  if (!Array.isArray(cue.lines) || cue.lines.length === 0) {
    return report(`${cuePath}.lines`, 'must be a non-empty array');
  }
  let previousLast: number | undefined;
  forEachItem(cue.lines, (line, i) => {
    const path = `${cuePath}.lines[${i}]`;
    if (!isObject(line)) return report(path, 'must be an object');
    if (typeof line.text !== 'string') report(`${path}.text`, 'must be a string');
    if (!checkWordRange(line.words, `${path}.words`, words?.length, report)) return;
    const [first, last] = line.words;
    if (previousLast !== undefined && first <= previousLast) {
      report(`${path}.words`, 'must start after the previous line (lines are ordered and do not share words)');
      return;
    }
    previousLast = last;
    if (!words) return;
    const foreign = words.slice(first, last + 1).findIndex((word) => word.speaker !== speaker);
    if (speaker !== undefined && foreign !== -1) {
      const index = first + foreign;
      report(`${path}.words`, `word ${index} belongs to speaker "${words[index].speaker}", not "${speaker}" (a cue never spans two speakers)`);
    }
    const expected = words
      .slice(first, last + 1)
      .map((word) => word.text)
      .join(' ');
    if (typeof line.text === 'string' && line.text !== expected) {
      report(`${path}.text`, `must equal the referenced words joined by single spaces: "${expected}"`);
    }
  });
}
