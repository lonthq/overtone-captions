import { EDIT_REASONS, FORMAT_NAME, FORMAT_VERSION, MATCH_KINDS, STYLE_CLASSES } from './types.js';
import type { OvertoneDocument } from './types.js';
import { validateProfiles } from './validate-profiles.js';
import {
  checkTime,
  checkWordRange,
  CURRENCY_STYLES,
  describe,
  forEachItem,
  isNonEmptyString,
  isObject,
  isTime,
  NUMBER_STYLES,
  TIME_MESSAGE,
  type Obj,
  type Report,
  type WordInfo,
} from './validate-utils.js';

export interface ValidationIssue { path: string; message: string }
export interface ValidationResult { valid: boolean; errors: ValidationIssue[] }

/** Validates an unknown value as an Overtone document. Never throws. Unknown fields are allowed. */
export function validate(doc: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  const report: Report = (path, message) => errors.push({ path, message });

  if (!isObject(doc)) {
    report('$', 'document must be a JSON object');
    return { valid: false, errors };
  }

  if (doc.format !== FORMAT_NAME) report('format', `must be "${FORMAT_NAME}"`);
  if (doc.version !== FORMAT_VERSION) report('version', `must be ${FORMAT_VERSION}`);
  if (!isNonEmptyString(doc.language)) report('language', 'must be a non-empty BCP-47 language code');
  if (!isTime(doc.duration)) report('duration', TIME_MESSAGE);

  const speakerIds = validateSpeakers(doc.speakers, report);
  const words = validateTurns(doc.turns, speakerIds, report);
  validateProfiles(doc.profiles, speakerIds, words, report);
  validateEdits(doc.edits, words?.length, report);
  validateMeta(doc.meta, report);

  return { valid: errors.length === 0, errors };
}

/** Returns the document typed as OvertoneDocument, or throws an Error listing every issue. */
export function assertValid(doc: unknown): OvertoneDocument {
  const { valid, errors } = validate(doc);
  if (valid) return doc as OvertoneDocument;
  const lines = errors.map((issue) => `- ${issue.path}: ${issue.message}`);
  throw new Error(`Invalid Overtone document (${errors.length} issues):\n${lines.join('\n')}`);
}

function validateSpeakers(value: unknown, report: Report): Set<string> {
  const ids = new Set<string>();
  if (!Array.isArray(value)) {
    report('speakers', 'must be an array');
    return ids;
  }
  forEachItem(value, (speaker, i) => {
    const path = `speakers[${i}]`;
    if (!isObject(speaker)) return report(path, 'must be an object');
    if (!isNonEmptyString(speaker.id)) report(`${path}.id`, 'must be a non-empty string');
    else if (ids.has(speaker.id)) report(`${path}.id`, `duplicate speaker id "${speaker.id}"`);
    else ids.add(speaker.id);
    if (speaker.label !== undefined && typeof speaker.label !== 'string') report(`${path}.label`, 'must be a string');
    if (speaker.role !== undefined && typeof speaker.role !== 'string') report(`${path}.role`, 'must be a string');
  });
  return ids;
}

/** Validates turns and their words. Returns the flat word list, or undefined when any turn is invalid. */
function validateTurns(value: unknown, speakerIds: Set<string>, report: Report): WordInfo[] | undefined {
  if (!Array.isArray(value)) {
    report('turns', 'must be an array');
    return undefined;
  }
  let ok = true;
  const reportTurn: Report = (path, message) => {
    ok = false;
    report(path, message);
  };
  const words: WordInfo[] = [];
  forEachItem(value, (turn, i) => {
    const path = `turns[${i}]`;
    if (!isObject(turn)) return reportTurn(path, 'must be an object');
    if (typeof turn.speaker !== 'string' || !speakerIds.has(turn.speaker)) {
      reportTurn(`${path}.speaker`, `unknown speaker "${describe(turn.speaker)}"`);
    }
    const start = checkTime(turn, 'start', path, reportTurn);
    const end = checkTime(turn, 'end', path, reportTurn);
    if (start !== undefined && end !== undefined && end < start) reportTurn(`${path}.end`, 'must be >= start');
    if (!Array.isArray(turn.words) || turn.words.length === 0) {
      return reportTurn(`${path}.words`, 'must be a non-empty array');
    }
    let previousEnd: number | undefined;
    forEachItem(turn.words, (word, j) => {
      const wordPath = `${path}.words[${j}]`;
      if (!isObject(word)) return reportTurn(wordPath, 'must be an object');
      previousEnd = validateWord(word, wordPath, previousEnd, reportTurn);
      words.push({ text: describe(word.text), speaker: describe(turn.speaker) });
    });
  });
  return ok ? words : undefined;
}

/** Validates one word; returns its end time (or the previous end when the word's times are invalid). */
function validateWord(word: Obj, path: string, previousEnd: number | undefined, report: Report): number | undefined {
  if (!isNonEmptyString(word.text)) report(`${path}.text`, 'must be a non-empty string');
  else if (!/\S/.test(word.text)) report(`${path}.text`, 'must contain non-whitespace text');
  const start = checkTime(word, 'start', path, report);
  const end = checkTime(word, 'end', path, report);
  if (start !== undefined && end !== undefined && end < start) report(`${path}.end`, 'must be >= start');
  if (start !== undefined && previousEnd !== undefined && start < previousEnd) {
    report(`${path}.start`, 'overlaps the previous word (words in a turn must be ordered and non-overlapping)');
  }
  if (word.classes !== undefined) {
    if (!Array.isArray(word.classes)) report(`${path}.classes`, 'must be an array');
    else {
      forEachItem(word.classes, (cls, k) => {
        if (!(STYLE_CLASSES as readonly unknown[]).includes(cls)) {
          report(`${path}.classes[${k}]`, `unknown class "${describe(cls)}" (allowed: ${STYLE_CLASSES.join(', ')})`);
        } else if ((word.classes as unknown[]).indexOf(cls) < k) {
          report(`${path}.classes[${k}]`, `duplicate class "${describe(cls)}"`);
        }
      });
    }
  }
  if (word.match !== undefined && !(MATCH_KINDS as readonly unknown[]).includes(word.match)) {
    report(`${path}.match`, `must be one of ${MATCH_KINDS.join(', ')}`);
  }
  if (
    word.confidence !== undefined &&
    (typeof word.confidence !== 'number' || !(word.confidence >= 0 && word.confidence <= 1))
  ) {
    report(`${path}.confidence`, 'must be a number from 0 to 1');
  }
  return end ?? previousEnd;
}

function validateEdits(value: unknown, wordCount: number | undefined, report: Report): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return report('edits', 'must be an array');
  forEachItem(value, (edit, i) => {
    const path = `edits[${i}]`;
    if (!isObject(edit)) return report(path, 'must be an object');
    checkWordRange(edit.words, `${path}.words`, wordCount, report);
    if (typeof edit.from !== 'string') report(`${path}.from`, 'must be a string');
    if (typeof edit.to !== 'string') report(`${path}.to`, 'must be a string');
    if (!(EDIT_REASONS as readonly unknown[]).includes(edit.reason)) {
      report(`${path}.reason`, `must be one of ${EDIT_REASONS.join(', ')}`);
    }
  });
}


/** Checks the known meta fields (same rules as the JSON Schema); unknown fields are allowed. */
function validateMeta(value: unknown, report: Report): void {
  if (value === undefined) return;
  if (!isObject(value)) return report('meta', 'must be an object');
  checkOptionalStrings(value, ['title', 'context', 'generator', 'createdAt'], 'meta', report);
  if (value.style !== undefined) {
    if (!isObject(value.style)) report('meta.style', 'must be an object');
    else {
      const { numbers, currency } = value.style;
      if (numbers !== undefined && !(NUMBER_STYLES as readonly unknown[]).includes(numbers)) {
        report('meta.style.numbers', `must be one of ${NUMBER_STYLES.join(', ')}`);
      }
      if (currency !== undefined && !(CURRENCY_STYLES as readonly unknown[]).includes(currency)) {
        report('meta.style.currency', `must be one of ${CURRENCY_STYLES.join(', ')}`);
      }
      checkOptionalStrings(value.style, ['guide'], 'meta.style', report);
    }
  }
  if (value.models !== undefined) {
    if (!isObject(value.models)) report('meta.models', 'must be an object');
    else checkOptionalStrings(value.models, ['text', 'timing', 'second', 'llm'], 'meta.models', report);
  }
}

function checkOptionalStrings(obj: Obj, keys: string[], path: string, report: Report): void {
  for (const key of keys) {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') report(`${path}.${key}`, 'must be a string');
  }
}
