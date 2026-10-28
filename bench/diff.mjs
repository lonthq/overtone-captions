#!/usr/bin/env node
// Prints the aligned errors of one system on one clip:
//   node bench/diff.mjs <clip> [overtone|textOnly|azure] [plain|formatted]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWords, wordsFromText } from './lib/normalize.mjs';
import { align } from './lib/wer.mjs';

const BENCH = dirname(fileURLToPath(import.meta.url));
const [clipId, cfg = 'overtone', mode = 'plain'] = process.argv.slice(2);
const clip = JSON.parse(readFileSync(join(BENCH, 'clips.json'), 'utf8')).clips.find((c) => c.id === clipId);
if (!clip) { console.error('usage: node bench/diff.mjs <clip> [overtone|textOnly|azure] [plain|formatted]'); process.exit(1); }
const ref = JSON.parse(readFileSync(join(BENCH, 'data', clipId, 'ref.json'), 'utf8'));
const hyp = JSON.parse(readFileSync(join(BENCH, 'runs', clipId, 'hyp.json'), 'utf8'));
const words = cfg === 'textOnly' ? wordsFromText(hyp.textOnly.text) : hyp[cfg].words;
const R = normalizeWords(ref.words, clip.language, mode), H = normalizeWords(words, clip.language, mode);
const { ops } = align(R.map((t) => t.t), H.map((t) => t.t));
const out = [];
let n = 0;
for (const [i, o] of ops.entries()) {
  if (o.op === 'C') continue;
  n++;
  const ctx = ops.slice(Math.max(0, i - 3), i).map((p) => (p.r !== null ? R[p.r].t : '')).join(' ');
  out.push(`${o.op}  ${o.r !== null ? R[o.r].t : '∅'}  ->  ${o.h !== null ? H[o.h].t : '∅'}    [… ${ctx}]`);
}
console.log(out.join('\n'));
console.log(`${n} errors / ${R.length} reference tokens`);
