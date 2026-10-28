#!/usr/bin/env node
// Scores run.mjs output against fetch.mjs references. No API calls.
//
//   node bench/score.mjs           writes bench/runs/scores.json and bench/runs/results.md, prints the tables
//   --clips <file>                 clip selection file (default bench/clips.json)
//   --runs <dir>                   run.mjs output folder, also the output folder (default bench/runs)
//
// Metrics (defined in RESULTS.md): plain and formatted WER with bootstrap 95% CIs, word start/end error, speaker
// accuracy and cpWER, cost and runtime per audio minute.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWords, wordsFromText } from './lib/normalize.mjs';
import { meterSummary } from './lib/meter-summary.mjs';
import { startF1 } from './lib/timing.mjs';
import { align, editDistance } from './lib/wer.mjs';

const BENCH = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const RUNS = resolve(flag('--runs') ?? join(BENCH, 'runs'));
const { clips } = JSON.parse(readFileSync(resolve(flag('--clips') ?? join(BENCH, 'clips.json')), 'utf8'));
const PRICES = JSON.parse(readFileSync(join(BENCH, 'prices.json'), 'utf8'));
const CONFIGS = ['overtone', 'textOnly', 'azure'];
const LABEL = { overtone: 'Overtone (full pipeline)', textOnly: 'gpt-transcribe alone', azure: 'Azure Speech alone', scribe: 'ElevenLabs Scribe alone' };
const B = 2000; // bootstrap resamples

// ---------- helpers ----------
const quantile = (xs, q) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); const p = (s.length - 1) * q, lo = Math.floor(p); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (p - lo); };
function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Best one-to-one assignment of hyp keys to ref keys maximizing score(h, r) (brute force; few speakers). */
function bestAssignment(hypKeys, refKeys, score) {
  let best = { total: -Infinity, map: {} };
  const rec = (k, used, total, map) => {
    if (k === hypKeys.length) { if (total > best.total) best = { total, map: { ...map } }; return; }
    const h = hypKeys[k];
    rec(k + 1, used, total + score(h, null), map); // unmapped
    for (const r of refKeys) if (!used.has(r)) { used.add(r); map[h] = r; rec(k + 1, used, total + score(h, r), map); delete map[h]; used.delete(r); }
  };
  rec(0, new Set(), 0, {});
  return best;
}

// ---------- per clip ----------
function hypWords(hyp, config) {
  return config === 'textOnly' ? wordsFromText(hyp.textOnly.text) : hyp[config].words;
}

function scoreText(ref, words, lang, mode) {
  const R = normalizeWords(ref.words, lang, mode), H = normalizeWords(words, lang, mode);
  const { ops } = align(R.map((t) => t.t), H.map((t) => t.t));
  const nSeg = ref.segments.length, err = new Array(nSeg).fill(0), cnt = new Array(nSeg).fill(0);
  const count = { C: 0, S: 0, D: 0, I: 0 };
  let lastSeg = 0;
  for (const o of ops) {
    count[o.op]++;
    if (o.r !== null) { lastSeg = ref.words[R[o.r].src].seg; cnt[lastSeg]++; if (o.op !== 'C') err[lastSeg]++; }
    else err[lastSeg]++; // insertion: charged to the segment of the previous reference token
  }
  const N = R.length;
  return { wer: (count.S + count.D + count.I) / N, ...count, refTokens: N, hypTokens: H.length, perSeg: { err, cnt }, ops, R, H };
}

function timingStats(ref, words, plain, withKinds) {
  if (!ref.hasWordTimes) return undefined;
  const seen = new Set(), rows = [];
  for (const o of plain.ops) {
    if (o.op !== 'C') continue;
    const rs = plain.R[o.r].src, hs = plain.H[o.h].src;
    if (seen.has(`${rs}:${hs}`)) continue;
    seen.add(`${rs}:${hs}`);
    const rw = ref.words[rs], hw = words[hs];
    if (typeof hw.start !== 'number' || typeof rw.start !== 'number') continue; // some Earnings-22 words are untimed
    rows.push({ ds: hw.start - rw.start, de: hw.end - rw.end, kind: hw.match });
  }
  const summarize = (rs) => {
    const a = rs.map((r) => Math.abs(r.ds)), e = rs.map((r) => Math.abs(r.de));
    return { words: rs.length, medianAbsStart: quantile(a, 0.5), p90AbsStart: quantile(a, 0.9), medianAbsEnd: quantile(e, 0.5), p90AbsEnd: quantile(e, 0.9),
      within50ms: a.filter((x) => x <= 0.05).length / (rs.length || 1), within100ms: a.filter((x) => x <= 0.1).length / (rs.length || 1), within250ms: a.filter((x) => x <= 0.25).length / (rs.length || 1),
      meanSignedStart: rs.reduce((s, r) => s + r.ds, 0) / (rs.length || 1), meanSignedEnd: rs.reduce((s, r) => s + r.de, 0) / (rs.length || 1),
      medianSignedStart: quantile(rs.map((r) => r.ds), 0.5), medianSignedEnd: quantile(rs.map((r) => r.de), 0.5) };
  };
  const out = summarize(rows);
  // Unlike the medians, start-boundary F1 counts missed and inserted words.
  const refTimed = ref.words.filter((w) => typeof w.start === 'number').length, hypTimed = words.filter((w) => typeof w.start === 'number').length;
  out.f1At50ms = startF1(rows, refTimed, hypTimed, 0.05);
  out.f1At100ms = startF1(rows, refTimed, hypTimed, 0.1);
  if (withKinds) { out.byMatch = {}; for (const k of new Set(rows.map((r) => r.kind))) out.byMatch[k] = summarize(rows.filter((r) => r.kind === k)); }
  return out;
}

function speakerStats(ref, words, plain, lang) {
  if (!ref.hasSpeakers || !words.length || words[0].speaker === undefined) return undefined;
  // Over correct words, after the best hyp->ref speaker mapping.
  const seen = new Set(), pairs = [];
  for (const o of plain.ops) {
    if (o.op !== 'C') continue;
    const rs = plain.R[o.r].src, hs = plain.H[o.h].src;
    if (seen.has(`${rs}:${hs}`)) continue;
    seen.add(`${rs}:${hs}`);
    pairs.push([words[hs].speaker, ref.words[rs].speaker]);
  }
  const hypSpk = [...new Set(words.map((w) => w.speaker))], refSpk = [...new Set(ref.words.map((w) => w.speaker))];
  const m = {};
  for (const [h, r] of pairs) m[`${h}|${r}`] = (m[`${h}|${r}`] ?? 0) + 1;
  const acc = bestAssignment(hypSpk, refSpk, (h, r) => (r === null ? 0 : m[`${h}|${r}`] ?? 0));
  // cpWER: per-speaker token streams, best speaker assignment, summed edit distance / reference tokens
  const R = plain.R, H = plain.H;
  const stream = (toks, src, key) => { const s = {}; for (const t of toks) (s[src[t.src][key]] ??= []).push(t.t); return s; };
  const rS = stream(R, ref.words, 'speaker'), hS = stream(H, words, 'speaker');
  const dist = {};
  for (const h of hypSpk) for (const r of refSpk) dist[`${h}|${r}`] = editDistance(rS[r] ?? [], hS[h] ?? []);
  const cp = bestAssignment(hypSpk, refSpk, (h, r) => -(r === null ? (hS[h]?.length ?? 0) : dist[`${h}|${r}`]));
  const mappedRefs = new Set(Object.values(cp.map));
  const unmatchedRef = refSpk.filter((r) => !mappedRefs.has(r)).reduce((s, r) => s + (rS[r]?.length ?? 0), 0);
  return { refSpeakers: refSpk.length, hypSpeakers: hypSpk.length, wordSpeakerAccuracy: acc.total / (pairs.length || 1), scoredWords: pairs.length,
    cpWER: (-cp.total + unmatchedRef) / R.length, mapping: acc.map };
}

// ---------- bootstrap ----------
function bootstrap(units, seed = 1) {
  // units: [{ err: {cfg: e}, cnt }] ; returns per config [lo, hi] and paired deltas vs textOnly / azure
  const r = rng(seed), stats = {};
  const keys = Object.keys(units[0].err);
  const samples = Object.fromEntries(keys.map((k) => [k, []]));
  for (let b = 0; b < B; b++) {
    const tot = Object.fromEntries(keys.map((k) => [k, 0]));
    let n = 0;
    for (let i = 0; i < units.length; i++) { const u = units[Math.floor(r() * units.length)]; n += u.cnt; for (const k of keys) tot[k] += u.err[k]; }
    for (const k of keys) samples[k].push(tot[k] / n);
  }
  for (const k of keys) stats[k] = [quantile(samples[k], 0.025), quantile(samples[k], 0.975)];
  const delta = (a, c) => { const d = samples[a].map((x, i) => x - samples[c][i]); return [quantile(d, 0.025), quantile(d, 0.975)]; };
  return { ci: stats, delta };
}

// ---------- cost and runtime ----------
function costRuntime(hyp, minutes, meter) {
  const p = PRICES;
  const stages = hyp.perf.stages;
  const sec = (n) => (typeof stages[n] === 'number' ? stages[n] : NaN);
  const llm = meter.llm;
  const uncached = Math.max(0, llm.promptTokens - llm.cachedTokens - llm.cacheWriteTokens);
  const llmCost = (uncached * p.llm.usdPerMInput + llm.cachedTokens * p.llm.usdPerMCachedInput + llm.cacheWriteTokens * p.llm.usdPerMCacheWrite + llm.completionTokens * p.llm.usdPerMOutput) / 1e6;
  const txCost = (minutes / 60) * p.gptTranscribe.usdPerAudioHour, spCost = (minutes / 60) * p.azureSpeechFast.usdPerAudioHour;
  // Every request is billed (retries too), and maybe timed-out ones, whose audio only the CLI's usage line gives.
  const timedOut = hyp.perf.timedOut ?? {};
  const billed = (meter.transcribe?.usage ?? []).reduce((s, u) => s + (u.type === 'duration' ? u.seconds ?? 0 : 0), 0);
  const txBilled = (billed > 0 ? (billed / 3600) * p.gptTranscribe.usdPerAudioHour : txCost) + ((timedOut.text?.audioSeconds ?? 0) / 3600) * p.gptTranscribe.usdPerAudioHour;
  const spBilled = spCost + ((timedOut.timing?.audioSeconds ?? 0) / 3600) * p.azureSpeechFast.usdPerAudioHour;
  return {
    llmTokens: { ...llm },
    timedOutRequests: (timedOut.text?.requests ?? 0) + (timedOut.timing?.requests ?? 0) + (timedOut.llm?.requests ?? 0),
    usd: { textOnly: txCost, azure: spCost, llm: llmCost, overtone: txBilled + spBilled + llmCost },
    seconds: { textOnly: sec('extract') + sec('transcribe'), azure: sec('extract') + sec('timing'), overtone: hyp.perf.wallSeconds, refine: sec('refine') },
  };
}

// ---------- main ----------
const results = [];
const units = { plain: [], formatted: [] };
for (const clip of clips) {
  const refPath = join(BENCH, 'data', clip.id, 'ref.json'), hypPath = join(RUNS, clip.id, 'hyp.json');
  if (!existsSync(refPath) || !existsSync(hypPath)) { console.error(`skip ${clip.id}: missing ${existsSync(refPath) ? 'hyp.json (run.mjs)' : 'ref.json (fetch.mjs)'}`); continue; }
  const ref = JSON.parse(readFileSync(refPath, 'utf8')), hyp = JSON.parse(readFileSync(hypPath, 'utf8'));
  const lang = clip.language, minutes = ref.duration / 60;
  const res = { clip: clip.id, hasSpeakers: !!ref.hasSpeakers, textModelEmpty: !hyp.textOnly.text.trim(), kind: clip.kind, language: lang, minutes, refWords: ref.words.length, detectedLanguage: hyp.language, summary: hyp.summary, edits: hyp.edits, rejectedEdits: hyp.rejectedEdits, configs: {} };
  const perSeg = { plain: {}, formatted: {} };
  for (const cfg of CONFIGS) {
    const words = hypWords(hyp, cfg);
    const plain = scoreText(ref, words, lang, 'plain'), formatted = scoreText(ref, words, lang, 'formatted');
    perSeg.plain[cfg] = plain.perSeg; perSeg.formatted[cfg] = formatted.perSeg;
    res.configs[cfg] = {
      wer: plain.wer, sub: plain.S, del: plain.D, ins: plain.I, refTokens: plain.refTokens,
      formattedWer: formatted.wer, formattedRefTokens: formatted.refTokens,
      timing: cfg === 'textOnly' ? undefined : timingStats(ref, words, plain, cfg === 'overtone'),
      speakers: cfg === 'textOnly' ? undefined : speakerStats(ref, words, plain, lang),
    };
  }
  // The second hearing, when present: timing and speakers only, not in the pooled WER.
  if (hyp.scribe) {
    const plain = scoreText(ref, hyp.scribe.words, lang, 'plain');
    res.configs.scribe = { wer: plain.wer, refTokens: plain.refTokens, timing: timingStats(ref, hyp.scribe.words, plain, false), speakers: speakerStats(ref, hyp.scribe.words, plain, lang) };
  }
  for (const mode of ['plain', 'formatted']) {
    const segUnits = ref.segments.map((_, i) => ({ cnt: perSeg[mode].overtone.cnt[i], err: Object.fromEntries(CONFIGS.map((c) => [c, perSeg[mode][c].err[i]])) })).filter((u) => u.cnt > 0);
    units[mode].push(...segUnits.map((u) => ({ ...u, clip: clip.id })));
    const bs = bootstrap(segUnits, 7);
    for (const c of CONFIGS) res.configs[c][mode === 'plain' ? 'werCI' : 'formattedWerCI'] = bs.ci[c];
    res[mode === 'plain' ? 'deltaCI' : 'formattedDeltaCI'] = { overtoneMinusTextOnly: bs.delta('overtone', 'textOnly'), overtoneMinusAzure: bs.delta('overtone', 'azure') };
  }
  // How Overtone's words got their times.
  const kinds = {};
  for (const w of hyp.overtone.words) kinds[w.match] = (kinds[w.match] ?? 0) + 1;
  res.alignment = kinds;
  const meter = meterSummary(join(RUNS, clip.id, 'meter.jsonl'));
  res.cost = costRuntime(hyp, minutes, meter);
  results.push(res);
}

// Pooled: all clips, and without clips where the text model returned no text.
function pool(keep) {
  const out = { clips: results.filter((r) => keep(r)).map((r) => r.clip), configs: {} };
  for (const mode of ['plain', 'formatted']) {
    const us = units[mode].filter((u) => out.clips.includes(u.clip));
    const bs = bootstrap(us, 11);
    for (const c of CONFIGS) {
      const e = us.reduce((s, u) => s + u.err[c], 0), n = us.reduce((s, u) => s + u.cnt, 0);
      out.configs[c] ??= {};
      out.configs[c][mode === 'plain' ? 'wer' : 'formattedWer'] = e / n;
      out.configs[c][mode === 'plain' ? 'werCI' : 'formattedWerCI'] = bs.ci[c];
      if (mode === 'plain') out.refTokens = n;
    }
    out[mode === 'plain' ? 'deltaCI' : 'formattedDeltaCI'] = { overtoneMinusTextOnly: bs.delta('overtone', 'textOnly'), overtoneMinusAzure: bs.delta('overtone', 'azure') };
  }
  return out;
}
const pooled = { minutes: results.reduce((s, r) => s + r.minutes, 0), ...pool(() => true) };
const empties = results.filter((r) => r.textModelEmpty).map((r) => r.clip);
const pooledNonEmpty = empties.length ? pool((r) => !r.textModelEmpty) : undefined;
const sum = (f) => results.reduce((s, r) => s + f(r), 0);
pooled.usd = Object.fromEntries(['textOnly', 'azure', 'llm', 'overtone'].map((k) => [k, sum((r) => r.cost.usd[k])]));
pooled.seconds = Object.fromEntries(['textOnly', 'azure', 'overtone', 'refine'].map((k) => [k, sum((r) => r.cost.seconds[k])]));
pooled.llmTokens = Object.fromEntries(['requests', 'promptTokens', 'cachedTokens', 'cacheWriteTokens', 'completionTokens', 'reasoningTokens'].map((k) => [k, sum((r) => r.cost.llmTokens[k])]));

writeFileSync(join(RUNS, 'scores.json'), JSON.stringify({ scoredAt: new Date().toISOString(), bootstrapResamples: B, prices: PRICES, results, pooled, pooledNonEmpty }, null, 1) + '\n');

// ---------- markdown ----------
const pct = (x, d = 1) => (Number.isFinite(x) ? `${(100 * x).toFixed(d)}%` : 'n/a');
const ci = (c) => (c ? ` (${(100 * c[0]).toFixed(1)}–${(100 * c[1]).toFixed(1)})` : '');
const dci = (c) => `${c[0] >= 0 ? '+' : ''}${(100 * c[0]).toFixed(1)} to ${c[1] >= 0 ? '+' : ''}${(100 * c[1]).toFixed(1)} pts`;
const ms = (x) => (Number.isFinite(x) ? `${Math.round(1000 * x)} ms` : 'n/a');
const usd = (x) => `$${x.toFixed(4)}`;
const L = [];
L.push(`Audio scored: ${pooled.minutes.toFixed(2)} min in ${results.length} clips. WER cells: value (bootstrap 95% CI over reference segments).`, '');
L.push('### Text accuracy (lower is better)', '');
L.push('| Clip | Ref words | ' + CONFIGS.map((c) => `${LABEL[c]} WER`).join(' | ') + ' | ' + CONFIGS.map((c) => `${LABEL[c]} formatted WER`).join(' | ') + ' |');
L.push('|---|---:|' + CONFIGS.map(() => '---:').join('|') + '|' + CONFIGS.map(() => '---:').join('|') + '|');
for (const r of results) L.push(`| ${r.clip} (${r.kind}) | ${r.configs.overtone.refTokens} | ` + CONFIGS.map((c) => pct(r.configs[c].wer) + ci(r.configs[c].werCI)).join(' | ') + ' | ' + CONFIGS.map((c) => pct(r.configs[c].formattedWer) + ci(r.configs[c].formattedWerCI)).join(' | ') + ' |');
const pools = [['**Pooled, all clips**', pooled], ...(pooledNonEmpty ? [[`**Pooled, without ${empties.join(', ')}** (empty gpt-transcribe output)`, pooledNonEmpty]] : [])];
for (const [name, p] of pools) L.push(`| ${name} | ${p.refTokens} | ` + CONFIGS.map((c) => `**${pct(p.configs[c].wer)}**` + ci(p.configs[c].werCI)).join(' | ') + ' | ' + CONFIGS.map((c) => `**${pct(p.configs[c].formattedWer)}**` + ci(p.configs[c].formattedWerCI)).join(' | ') + ' |');
L.push('', 'Paired bootstrap 95% CI of the difference (negative = Overtone better):', '');
L.push('| Clip | WER: Overtone − gpt-transcribe | WER: Overtone − Azure | Formatted: Overtone − gpt-transcribe | Formatted: Overtone − Azure |', '|---|---|---|---|---|');
for (const r of [...results, ...pools.map(([clip, p]) => ({ ...p, clip }))]) L.push(`| ${r.clip} | ${dci(r.deltaCI.overtoneMinusTextOnly)} | ${dci(r.deltaCI.overtoneMinusAzure)} | ${dci(r.formattedDeltaCI.overtoneMinusTextOnly)} | ${dci(r.formattedDeltaCI.overtoneMinusAzure)} |`);
L.push('', 'Error breakdown (plain WER, substitutions / deletions / insertions):', '');
L.push('| Clip | ' + CONFIGS.map((c) => LABEL[c]).join(' | ') + ' |', '|---|' + CONFIGS.map(() => '---').join('|') + '|');
for (const r of results) L.push(`| ${r.clip} | ` + CONFIGS.map((c) => `${r.configs[c].sub} / ${r.configs[c].del} / ${r.configs[c].ins}`).join(' | ') + ' |');
const timed = results.filter((r) => r.configs.overtone.timing);
if (timed.length) {
  L.push('', '### Word timing (clips with reference word times; correctly recognized words only)', '');
  L.push('| Clip | System | Words | Median abs start error | P90 abs start error | Within 50 ms | Within 100 ms | Within 250 ms | Median abs end error | Mean signed start | Mean signed end | Start F1 at 50 ms | Start F1 at 100 ms |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of timed) for (const c of ['overtone', 'azure', 'scribe'].filter((c) => r.configs[c])) { const t = r.configs[c].timing; L.push(`| ${r.clip} | ${LABEL[c]} | ${t.words} | ${ms(t.medianAbsStart)} | ${ms(t.p90AbsStart)} | ${pct(t.within50ms, 0)} | ${pct(t.within100ms, 0)} | ${pct(t.within250ms, 0)} | ${ms(t.medianAbsEnd)} | ${ms(t.meanSignedStart)} | ${ms(t.meanSignedEnd)} | ${pct(t.f1At50ms, 0)} | ${pct(t.f1At100ms, 0)} |`); }
  L.push('', 'Overtone timing by alignment match kind:', '');
  L.push('| Clip | Match kind | Words | Median abs start error | P90 abs start error |', '|---|---|---:|---:|---:|');
  for (const r of timed) for (const [k, t] of Object.entries(r.configs.overtone.timing.byMatch)) L.push(`| ${r.clip} | ${k} | ${t.words} | ${ms(t.medianAbsStart)} | ${ms(t.p90AbsStart)} |`);
}
L.push('', '### Alignment coverage (Overtone words by how they got their times)', '');
const allKinds = [...new Set(results.flatMap((r) => Object.keys(r.alignment)))];
L.push('| Clip | Words | ' + allKinds.join(' | ') + ' |', '|---|---:|' + allKinds.map(() => '---:').join('|') + '|');
for (const r of results) { const n = Object.values(r.alignment).reduce((a, b) => a + b, 0); L.push(`| ${r.clip} | ${n} | ` + allKinds.map((k) => pct((r.alignment[k] ?? 0) / n)).join(' | ') + ' |'); }
const spk = results.filter((r) => r.hasSpeakers);
if (spk.length) {
  L.push('', '### Speakers (clips with reference speakers)', '');
  L.push('| Clip | System | Ref speakers | Hyp speakers | Word speaker accuracy | cpWER | WER (for comparison) |', '|---|---|---:|---:|---:|---:|---:|');
  for (const r of spk) for (const c of ['overtone', 'azure', 'scribe'].filter((c) => r.configs[c])) { const s = r.configs[c].speakers; if (!s) { L.push(`| ${r.clip} | ${LABEL[c]} | – | 0 | n/a (no words) | 100.0% | ${pct(r.configs[c].wer)} |`); continue; } L.push(`| ${r.clip} | ${LABEL[c]} | ${s.refSpeakers} | ${s.hypSpeakers} | ${pct(s.wordSpeakerAccuracy)} | ${pct(s.cpWER)} | ${pct(r.configs[c].wer)} |`); }
}
const nonSpk = results.filter((r) => !r.hasSpeakers);
if (nonSpk.length) L.push('', 'Speakers found on clips without a speaker reference (one reader for LibriSpeech; FLEURS readers unknown): ' + nonSpk.map((r) => `${r.clip}: ${new Set(JSON.parse(readFileSync(join(RUNS, r.clip, 'hyp.json'), 'utf8')).overtone.words.map((w) => w.speaker)).size}`).join(', ') + '.');
L.push('', '### Cost and runtime', '');
L.push('| Clip | Audio min | ' + CONFIGS.map((c) => `${LABEL[c]} $/audio min`).join(' | ') + ' | LLM tokens in / out (reasoning) | ' + CONFIGS.map((c) => `${LABEL[c]} s per audio min`).join(' | ') + ' |');
L.push('|---|---:|' + CONFIGS.map(() => '---:').join('|') + '|---|' + CONFIGS.map(() => '---:').join('|') + '|');
for (const r of [...results, { clip: '**Total**', minutes: pooled.minutes, cost: { usd: pooled.usd, seconds: pooled.seconds, llmTokens: pooled.llmTokens } }]) {
  const t = r.cost.llmTokens;
  L.push(`| ${r.clip} | ${r.minutes.toFixed(2)} | ` + CONFIGS.map((c) => usd(r.cost.usd[c] / r.minutes)).join(' | ') + ` | ${t.promptTokens} / ${t.completionTokens} (${t.reasoningTokens}) | ` + CONFIGS.map((c) => (r.cost.seconds[c] / r.minutes).toFixed(1)).join(' | ') + ' |');
}
const timedOutRequests = results.reduce((s, r) => s + (r.cost.timedOutRequests ?? 0), 0);
L.push('', `Total list-price cost of the scored runs: ${usd(pooled.usd.overtone)} (gpt-transcribe ${usd(pooled.usd.textOnly)}, Azure Speech ${usd(pooled.usd.azure)}, LLM ${usd(pooled.usd.llm)}). Refine stage: ${(pooled.seconds.refine / pooled.minutes).toFixed(1)} s per audio minute.`
  + (timedOutRequests > 0 ? ` Overtone's cost includes the audio of ${timedOutRequests} request${timedOutRequests === 1 ? '' : 's'} that ran out of time (the service may bill them; the LLM tokens of timed-out LLM requests are not known).` : ''));
const md = L.join('\n') + '\n';
writeFileSync(join(RUNS, 'results.md'), md);
process.stdout.write(md);
