let rowA = new Int32Array(64);
let rowB = new Int32Array(64);

/** Levenshtein edit distance (insert/delete/substitute, each cost 1). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  if (rowA.length <= b.length) {
    rowA = new Int32Array(b.length * 2 + 1);
    rowB = new Int32Array(b.length * 2 + 1);
  }
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      cur[j] = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
    }
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[b.length];
}

/** Levenshtein distance of a and b if it is at most `limit`, else -1 (stops as soon as the limit is exceeded). */
export function levenshteinWithin(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return -1;
  if (a === b) return 0;
  if (a.length === 0 || b.length === 0) return Math.max(a.length, b.length);
  if (rowA.length <= b.length) {
    rowA = new Int32Array(b.length * 2 + 1);
    rowB = new Int32Array(b.length * 2 + 1);
  }
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1);
      const del = prev[j] + 1;
      const ins = cur[j - 1] + 1;
      const v = sub < del ? (sub < ins ? sub : ins) : del < ins ? del : ins;
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return -1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return prev[b.length] <= limit ? prev[b.length] : -1;
}

/** Similarity of two keys that contain no spaces: 1 = identical, 0 = nothing in common. */
export function flatSimilarity(x: string, y: string): number {
  if (x === y) return 1;
  const max = x.length > y.length ? x.length : y.length;
  return 1 - levenshtein(x, y) / max;
}

/** Character similarity of two keys, ignoring spaces: 1 = identical, 0 = nothing in common. */
export function similarity(a: string, b: string): number {
  return flatSimilarity(a.replace(/ /g, ''), b.replace(/ /g, ''));
}
