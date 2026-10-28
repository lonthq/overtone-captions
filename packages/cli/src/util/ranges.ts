/** A replacement of the words [first, last]; last = first − 1 is an insertion before word `first`. */
export interface WordRange { first: number; last: number }

/**
 * Splits replacements sorted by `first` into those that can all apply and those that overlap an earlier accepted
 * one. A replacement is accepted when it starts after every word already replaced. An insertion is accepted unless
 * it falls inside an accepted replacement (next to one, or at the same place as another insertion, is fine).
 */
export function nonOverlapping<T>(sorted: readonly T[], range: (x: T) => WordRange): { accepted: T[]; overlapping: T[] } {
  const accepted: T[] = [];
  const overlapping: T[] = [];
  let lastEnd = -1;
  for (const x of sorted) {
    const { first, last } = range(x);
    if (first <= lastEnd) {
      overlapping.push(x);
      continue;
    }
    accepted.push(x);
    lastEnd = Math.max(lastEnd, last);
  }
  return { accepted, overlapping };
}
