/** Internal helpers shared by the validator modules. */

import type { StyleSettings } from './types.js';

/** Allowed meta.style values (the schema-parity test compares them with the schema). */
export const NUMBER_STYLES = ['digits', 'words', 'auto'] as const satisfies readonly NonNullable<StyleSettings['numbers']>[];
export const CURRENCY_STYLES = ['symbol', 'code', 'words', 'auto'] as const satisfies readonly NonNullable<
  StyleSettings['currency']
>[];

export type Report = (path: string, message: string) => void;

/** What the cross-reference checks need to know about each global word. */
export interface WordInfo { text: string; speaker: string }
export type Obj = Record<string, unknown>;

/** Calls `fn` for every index, holes included (Array#forEach would let a sparse array pass unchecked). */
export function forEachItem(array: readonly unknown[], fn: (item: unknown, index: number) => void): void {
  for (let i = 0; i < array.length; i++) fn(array[i], i);
}

export function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** A non-negative, finite number of seconds with at most 3 decimals (float noise tolerated). */
export function isTime(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return false;
  const millis = value * 1000;
  return Math.abs(millis - Math.round(millis)) < 1e-6;
}

export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export const TIME_MESSAGE = 'must be a non-negative number of seconds with at most 3 decimals';

/** Checks `obj[key]` is a time; returns the value or undefined (after reporting). */
export function checkTime(obj: Obj, key: string, path: string, report: Report): number | undefined {
  const value = obj[key];
  if (isTime(value)) return value;
  report(`${path}.${key}`, TIME_MESSAGE);
  return undefined;
}

/** Checks an inclusive [first, last] word range; with `wordCount` undefined (invalid turns), only its shape. */
export function checkWordRange(value: unknown, path: string, wordCount: number | undefined, report: Report): value is [number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isInteger(value[0]) ||
    !Number.isInteger(value[1]) ||
    value[0] < 0 ||
    value[1] < value[0]
  ) {
    report(path, 'must be an inclusive [first, last] range of word indices with first <= last');
    return false;
  }
  if (wordCount !== undefined && value[1] >= wordCount) {
    report(path, `word index ${value[1]} is out of bounds (document has ${wordCount} words)`);
    return false;
  }
  return true;
}

/** String form of an untrusted value for messages; never throws. */
export function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
