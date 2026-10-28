// Word timing scores of the benchmark (score.mjs). See RESULTS.md ("Word timing").

/**
 * Start-boundary F1 (as in FA-Bench): a hit is a correct word with start error `ds` within `tol` s; precision over
 * system timed words, recall over reference timed words.
 */
export function startF1(rows, refTimed, hypTimed, tol) {
  const hits = rows.filter((r) => Math.abs(r.ds) <= tol).length;
  const p = hits / (hypTimed || 1), r = hits / (refTimed || 1);
  return p + r ? (2 * p * r) / (p + r) : 0;
}
