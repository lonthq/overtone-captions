// Word-level Levenshtein alignment (unit costs) with backtrace: ops C(orrect) S(ub) D(el) I(ns).
export function align(ref, hyp) {
  const n = ref.length, m = hyp.length, W = m + 1;
  const d = new Uint32Array((n + 1) * W);
  for (let i = 0; i <= n; i++) d[i * W] = i;
  for (let j = 0; j <= m; j++) d[j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = d[(i - 1) * W + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      const del = d[(i - 1) * W + j] + 1, ins = d[i * W + j - 1] + 1;
      d[i * W + j] = Math.min(sub, del, ins);
    }
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i * W + j] === d[(i - 1) * W + j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1)) {
      ops.push({ op: ref[i - 1] === hyp[j - 1] ? 'C' : 'S', r: i - 1, h: j - 1 }); i--; j--;
    } else if (i > 0 && d[i * W + j] === d[(i - 1) * W + j] + 1) { ops.push({ op: 'D', r: i - 1, h: null }); i--; }
    else { ops.push({ op: 'I', r: null, h: j - 1 }); j--; }
  }
  return { ops: ops.reverse(), dist: d[n * W + m] };
}
export const editDistance = (a, b) => (a.length === 0 ? b.length : b.length === 0 ? a.length : align(a, b).dist);

