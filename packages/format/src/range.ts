import type { WordRange } from './types.js';

/** Internal: the items of an inclusive word range. Throws RangeError on a malformed or out-of-bounds range. */
export function sliceRange<T>(words: readonly T[], range: WordRange): T[] {
  const [first, last] = range;
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last >= words.length) {
    throw new RangeError(`Invalid word range [${first}, ${last}] for ${words.length} words`);
  }
  return words.slice(first, last + 1);
}
