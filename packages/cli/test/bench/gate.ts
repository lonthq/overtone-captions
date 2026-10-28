// Regression gate: per-clip scores of the pipeline (run.ts) and the frozen hearings, gated metrics with baseline and
// tolerances, and the printed tables. Used by bench-gate.test.ts and bench/gate.mjs.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tokenizeDisplay } from '../../src/text/normalize.js';
import { referenceOf, type BenchWord, type Fixture, type Reference } from './fixture.js';
import { runOvertone, type OvertoneRun } from './run.js';
import { cueTiming, speakerScore, wer, wordTiming, type CueTimingScore, type SpeakerScore, type TextScore, type Timed, type WordTimingScore } from './score.js';

export interface SystemScore {
  /** "text", "timing", a hearing name or "overtone". */
  role: string;
  provider: string;
  text?: TextScore;
  words?: WordTimingScore;
  cues?: CueTimingScore;
  /** Speaker attribution against reference words with speakers (AMI). */
  speakers?: SpeakerScore;
  /** Overtone only: share of output words no engine heard (interpolated or placed by the voice estimate). */
  unheard?: number;
  /** Overtone only: the first profile's cues and those faster than its maxCps. */
  output?: { profile: string; cues: number; fast: number };
  /** Overtone only: the number of output words. */
  wordsOut?: number;
  /** Overtone only: output words that start before the speech does (the fixture's speechStart). */
  wordsEarly?: number;
  /** Overtone only: the same without the second hearing (as without an ELEVENLABS_API_KEY). */
  wordsEarlyNoSecond?: number;
}

export interface ClipResult {
  id: string;
  title: string;
  contamination: Fixture['contamination'];
  /** What the word timing is measured against ("AMI reference words", "ElevenLabs words (machine)"), if anything. */
  wordRef?: string;
  /** What the WER and cue timing are measured against, if anything. */
  textRef?: string;
  /** Why a reference is missing (a local-only reference whose file is absent). */
  missingRef?: string;
  systems: SystemScore[];
  /** The text provider gave no text, also when retried: the text base is an engine's words (meta.fallbacks). */
  textFallback: boolean;
  /** Audio without speech (the fixture's nonSpeech). */
  nonSpeech: boolean;
  misses: OvertoneRun['misses'];
  votes: OvertoneRun['votes'];
  notes: string[];
}

const textWords = (text: string) => tokenizeDisplay(text).map((t) => ({ text: t }));

function score(words: ReadonlyArray<{ text: string; start?: number; speaker?: string }>, lang: string, ref: Reference | undefined, wordRef: Timed[] | undefined, timed: boolean): Pick<SystemScore, 'text' | 'words' | 'cues' | 'speakers'> {
  const out: Pick<SystemScore, 'text' | 'words' | 'cues' | 'speakers'> = {};
  const refText = ref?.words ?? ref?.cues;
  if (refText) out.text = wer(refText, words, lang);
  if (!timed) return out;
  const hyp = words as Timed[];
  if (wordRef) out.words = wordTiming(wordRef, hyp, lang);
  if (ref?.cues) out.cues = cueTiming(ref.cues, hyp, lang);
  if (ref?.words?.some((w) => w.speaker !== undefined && typeof w.start === 'number')) {
    const s = speakerScore(ref.words as Array<Timed & { speaker?: string }>, hyp as Array<Timed & { speaker?: string }>, lang);
    if (s) out.speakers = s;
  }
  return out;
}

export async function scoreClip(f: Fixture): Promise<ClipResult> {
  const ref = referenceOf(f);
  const lang = f.language;
  const humanWordTimes = ref?.words?.every((w) => typeof w.start === 'number') ? (ref.words as Timed[]) : undefined;
  const machine = !humanWordTimes && f.timingReference ? f.hearings[f.timingReference] : undefined;
  const wordRef = humanWordTimes ?? machine?.words;
  const run = await runOvertone(f);
  // where the speech starts late, also the run without the second hearing (its times are the timing provider's)
  const early = (words: readonly BenchWord[]) => words.filter((w) => w.start < f.speechStart!).length;
  const noSecond = f.speechStart !== undefined && Object.keys(f.hearings).length > 0 ? await runOvertone(f, { noSecond: true }) : undefined;
  const systems: SystemScore[] = [];
  systems.push({ role: 'text', provider: f.text.provider, ...score(f.text.raw.flatMap((t, k) => textWords(t.trim() ? t : (f.text.retry?.[k] ?? ''))), lang, ref, undefined, false) });
  const timed = (role: string, provider: string, words: readonly BenchWord[]) => {
    const isRef = role === f.timingReference && !humanWordTimes;
    systems.push({ role, provider, ...score(words, lang, ref, isRef ? undefined : wordRef, true) });
  };
  timed('timing', f.timing.provider, f.timing.words);
  for (const [name, h] of Object.entries(f.hearings)) timed(name, h.provider, h.words);
  const profile = run.profiles[0];
  const maxCps = profile?.rules.maxCps;
  const chars = (c: NonNullable<typeof profile>['cues'][number]) => c.lines.map((l) => l.text).join(' ').length;
  systems.push({
    role: 'overtone', provider: 'current code (no LLM)',
    ...score(run.words, lang, ref, wordRef, true),
    unheard: run.words.length ? run.words.filter((w) => w.match === 'interpolated').length / run.words.length : 0,
    wordsOut: run.words.length,
    ...(f.speechStart !== undefined ? { wordsEarly: early(run.words) } : {}),
    ...(noSecond ? { wordsEarlyNoSecond: early(noSecond.words) } : {}),
    ...(profile ? { output: { profile: profile.id, cues: profile.cues.length, fast: maxCps ? profile.cues.filter((c) => chars(c) / Math.max(0.001, c.end - c.start) > maxCps).length : 0 } } : {}),
  });
  return {
    id: f.id, title: f.title, contamination: f.contamination,
    ...(wordRef ? { wordRef: humanWordTimes ? 'human reference word times' : `${f.timingReference} word times (machine, not truth)` } : {}),
    ...(ref ? { textRef: ref.source } : {}),
    ...(!ref && f.localReference ? { missingRef: `${f.localReference.path} not present (not committed: ${f.localReference.source})` } : {}),
    systems, textFallback: f.text.raw.every((t) => !t.trim()) && !(f.text.retry ?? []).some((t) => t.trim()), nonSpeech: !!f.nonSpeech, misses: run.misses, votes: run.votes, notes: f.notes ?? [],
  };
}

// ---------------------------------------------------------------- gate metrics and baseline

export interface GateMetric { key: string; value: number; better: 'lower' | 'higher'; tolerance: number }

/**
 * The gated metrics of the Overtone output and their tolerances (how much worse than the baseline a value may get).
 * The run is deterministic, so any change is real; the tolerances only let a redesign trade a little.
 */
export function gateMetrics(r: ClipResult): GateMetric[] {
  const o = r.systems.find((s) => s.role === 'overtone')!;
  const out: GateMetric[] = [];
  const add = (key: string, value: number | undefined, better: GateMetric['better'], tolerance: number) => {
    if (value !== undefined && Number.isFinite(value)) out.push({ key, value: Math.round(value * 1e4) / 1e4, better, tolerance });
  };
  add('wer', o.text?.wer, 'lower', 0.005);
  add('werFormatted', o.text?.werFormatted, 'lower', 0.005);
  add('words.median', o.words?.median, 'lower', 0.01);
  add('words.p90', o.words?.p90, 'lower', 0.03);
  add('words.within100', o.words?.within100, 'higher', 0.01);
  add('words.within250', o.words?.within250, 'higher', 0.01);
  add('words.matched', o.words?.matched, 'higher', 3);
  add('speakers.accuracy', o.speakers?.accuracy, 'higher', 0.01);
  add('cues.median', o.cues?.median, 'lower', 0.05);
  add('cues.matched', o.cues?.matched, 'higher', 0);
  add('cues.over1s', o.cues?.over1s, 'lower', 0);
  add('cues.over2s', o.cues?.over2s, 'lower', 0);
  add('output.fast', o.output?.fast, 'lower', 1);
  // on audio without speech every word is invented: no tolerance
  if (r.nonSpeech) add('output.words', o.wordsOut, 'lower', 0);
  // where the audio starts without speech, no word is said before the speech starts: no tolerance
  add('output.early', o.wordsEarly, 'lower', 0);
  add('output.earlyNoSecond', o.wordsEarlyNoSecond, 'lower', 0);
  return out;
}

export type Baseline = Record<string, Record<string, number>>;

export function readBaseline(path: string): Baseline {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')).clips as Baseline) : {};
}

/**
 * Writes the gate metrics of `results` into the baseline file; metrics of clips not run (or skipped for a missing
 * reference) keep their old values.
 */
export function writeBaseline(path: string, results: readonly ClipResult[]): void {
  const clips: Baseline = readBaseline(path);
  for (const r of results) clips[r.id] = { ...clips[r.id], ...Object.fromEntries(gateMetrics(r).map((m) => [m.key, m.value])) };
  const sorted = Object.fromEntries(Object.keys(clips).sort().map((id) => [id, clips[id]!]));
  writeFileSync(path, `${JSON.stringify({ $comment: 'Regression gate baseline (packages/cli/test/bench-gate.test.ts). Update with BENCH_GATE_WRITE=1 npx vitest run packages/cli/test/bench-gate.test.ts after a reviewed change.', clips: sorted }, null, 2)}\n`);
}

export interface Comparison { clip: string; key: string; baseline?: number; value?: number; tolerance: number; status: 'ok' | 'worse' | 'better' | 'new' | 'skipped' }

export function compare(results: readonly ClipResult[], baseline: Baseline): Comparison[] {
  const out: Comparison[] = [];
  for (const r of results) {
    const metrics = gateMetrics(r);
    const now = new Map(metrics.map((m) => [m.key, m]));
    for (const m of metrics) {
      const b = baseline[r.id]?.[m.key];
      if (b === undefined) { out.push({ clip: r.id, key: m.key, value: m.value, tolerance: m.tolerance, status: 'new' }); continue; }
      const delta = m.better === 'lower' ? m.value - b : b - m.value; // > 0: worse
      const status = delta > m.tolerance + 1e-9 ? 'worse' : delta < -1e-9 ? 'better' : 'ok';
      out.push({ clip: r.id, key: m.key, baseline: b, value: m.value, tolerance: m.tolerance, status });
    }
    // a baseline metric the run could not compute: its reference is absent here (a local-only file)
    for (const [key, b] of Object.entries(baseline[r.id] ?? {})) if (!now.has(key)) out.push({ clip: r.id, key, baseline: b, tolerance: 0, status: 'skipped' });
  }
  return out;
}

// ---------------------------------------------------------------- tables

const pct = (x?: number) => (x === undefined || !Number.isFinite(x) ? '-' : `${(x * 100).toFixed(1)}%`);
const sec = (x?: number) => (x === undefined || !Number.isFinite(x) ? '-' : `${x.toFixed(3)}`);
const int = (x?: number) => (x === undefined ? '-' : String(x));
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const lpad = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s);

export const CONTAMINATION_LABEL: Record<Fixture['contamination']['level'], string> = {
  high: "POSSIBLY IN ENGINES' TRAINING DATA: not used for engine comparisons",
  possible: "public dataset: may be in engines' training data",
  none: 'private clip',
};

/** The full table of one clip: every hearing and the Overtone output. */
export function clipTable(r: ClipResult): string {
  const head = ['system', 'WER', 'fWER', 'w.med', 'w.p90', '<=100ms', '<=250ms', 'w.match', 'c.med', 'c>1s', 'c>2s', 'c.match', 'spk', 'unheard', 'cues', 'fast'];
  const widths = [34, 7, 7, 7, 7, 8, 8, 9, 7, 5, 5, 8, 10, 8, 5, 5];
  const row = (cells: string[]) => cells.map((c, k) => (k === 0 ? pad(c, widths[k]!) : lpad(c, widths[k]!))).join(' ');
  const lines = [
    `${r.id}: ${r.title}`,
    `  [${CONTAMINATION_LABEL[r.contamination.level]}] ${r.contamination.note}`,
    `  WER and cue timing vs: ${r.textRef ?? r.missingRef ?? 'no human text reference'}`,
    `  word timing vs: ${r.wordRef ?? 'no reference word times'}`,
    row(head),
  ];
  for (const s of r.systems) {
    lines.push(row([
      `${s.role}: ${s.provider}`.slice(0, widths[0]), pct(s.text?.wer), pct(s.text?.werFormatted),
      sec(s.words?.median), sec(s.words?.p90), pct(s.words?.within100), pct(s.words?.within250),
      s.words ? `${s.words.matched}/${s.words.refWords}` : '-',
      sec(s.cues?.median), int(s.cues?.over1s), int(s.cues?.over2s), s.cues ? `${s.cues.matched}/${s.cues.cues}` : '-',
      s.speakers ? `${pct(s.speakers.accuracy)} ${s.speakers.found}/${s.speakers.refSpeakers}` : '-',
      pct(s.unheard), int(s.output?.cues), int(s.output?.fast),
    ]));
  }
  const m = r.misses;
  if (m.relisten.length || m.text.length || m.llm.length) {
    lines.push(`  not in the fixture (answered with nothing, or "keep"): ${m.relisten.length} timing snippet(s)${m.relisten.length ? ` (${m.relisten.join(', ')})` : ''}, ${m.text.length} text snippet(s), ${m.llm.length} chooser request(s)`);
  }
  const changed = r.votes.filter((v) => v.result === 'changed');
  if (r.votes.length > 0) lines.push(`  text vote: ${r.votes.length} region(s), ${changed.length} changed${changed.length ? `: ${changed.map((v) => `${v.from ? `"${v.from}" → ` : '+'}"${v.to}" (${v.class})`).join('; ')}` : ''}`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  return lines.join('\n');
}

/** The gate table: every gated metric with its baseline. */
export function gateTable(rows: readonly Comparison[]): string {
  const fmt = (x?: number) => (x === undefined ? '-' : Number.isInteger(x) ? String(x) : x.toFixed(4));
  const out = [`${pad('clip', 20)} ${pad('metric', 16)} ${lpad('baseline', 9)} ${lpad('now', 9)} ${lpad('tol', 7)}  status`];
  for (const c of rows) out.push(`${pad(c.clip, 20)} ${pad(c.key, 16)} ${lpad(fmt(c.baseline), 9)} ${lpad(fmt(c.value), 9)} ${lpad(fmt(c.tolerance), 7)}  ${c.status === 'skipped' ? 'skipped (reference absent)' : c.status}`);
  return out.join('\n');
}

// ---------------------------------------------------------------- bench/gate.mjs

/**
 * Engine summary over the clips engines may be compared on (contamination not `high`): WER weighted by reference
 * words, and the median word start error over the clips with reference word times.
 */
export function engineSummary(results: readonly ClipResult[]): string {
  const usable = results.filter((r) => r.contamination.level !== 'high');
  // the same clips for every row: WER where the text is the text provider's own (not an engine's words)
  const forWer = usable.filter((r) => !r.textFallback && r.systems.every((s) => s.text));
  const forTiming = usable.filter((r) => r.wordRef?.startsWith('human'));
  const roles = [...new Set(usable.flatMap((r) => r.systems.map((s) => s.role)))];
  const lines = [
    `engines, pooled. The Blender films are left out (possibly in the engines' training data); the rest are public datasets that may be too.`,
    `  WER over ${forWer.length} clips (${forWer.map((r) => r.id).join(', ')}), weighted by reference words; clips whose text is an engine's words (the fallback) are left out`,
    `  word start error over ${forTiming.length} clips with human reference word times (${forTiming.map((r) => r.id).join(', ')}): mean of the per-clip medians`,
    `${pad('system', 12)} ${lpad('WER', 7)} ${lpad('fWER', 7)} ${lpad('w.med', 8)}`,
  ];
  for (const role of roles) {
    const t = forWer.flatMap((r) => r.systems.filter((x) => x.role === role && x.text));
    const n = t.reduce((a, x) => a + x.text!.refWords, 0);
    const w = (k: 'wer' | 'werFormatted') => (n ? t.reduce((a, x) => a + x.text![k] * x.text!.refWords, 0) / n : undefined);
    const timed = forTiming.flatMap((r) => r.systems.filter((x) => x.role === role && x.words));
    const med = timed.length === forTiming.length && timed.length > 0 ? timed.reduce((a, x) => a + x.words!.median, 0) / timed.length : undefined;
    lines.push(`${pad(role, 12)} ${lpad(pct(w('wer')), 7)} ${lpad(pct(w('werFormatted')), 7)} ${lpad(sec(med), 8)}`);
  }
  return lines.join('\n');
}

/** Everything bench/gate.mjs prints: the full table per clip, the engine summary and the gate against the baseline. */
export async function report(dirs: ReadonlyArray<{ name: string; dir: string }>, only: readonly string[] = []): Promise<string> {
  const { loadFixtures } = await import('./fixture.js');
  const { join } = await import('node:path');
  const out: string[] = [];
  const all: ClipResult[] = [];
  for (const { name, dir } of dirs) {
    const fixtures = loadFixtures(dir).filter((f) => only.length === 0 || only.includes(f.id));
    if (fixtures.length === 0) continue;
    const t0 = Date.now();
    const results: ClipResult[] = [];
    for (const f of fixtures) results.push(await scoreClip(f));
    all.push(...results);
    out.push(`==== ${name}: ${results.length} clips in ${((Date.now() - t0) / 1000).toFixed(1)} s`, '');
    for (const r of results) out.push(clipTable(r), '');
    out.push(gateTable(compare(results, readBaseline(join(dir, 'baseline.json')))), '');
  }
  if (all.length > 0) out.push(engineSummary(all));
  out.push('', 'Columns: WER / fWER plain and formatted WER; w.* word start error (seconds) of matched words against the word-timing reference, with the shares within 100 and 250 ms; c.* cue timing: per reference cue, |start of its first matched word − cue start|, median and cues more than 1 s / 2 s off; unheard: output words no engine heard; cues / fast: output cues of the first profile and those over its maximum reading speed.');
  return out.join('\n');
}
