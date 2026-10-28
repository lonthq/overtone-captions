#!/usr/bin/env node
// Runs the CLI as a black box on every benchmark clip and writes hyp.json per clip:
//   overtone  the final document words
//   textOnly  the raw gpt-transcribe text (chunk answers from the request cache, joined)
//   azure     the Azure Speech words (from the request cache)
// plus stage runtimes from the CLI log and HTTP usage from lib/meter.mjs.
//
//   node bench/run.mjs                 all clips; requests sent before come from the cache (no new API calls)
//   node bench/run.mjs --fresh         ignore the cache (new, billable API calls for every clip)
//   node bench/run.mjs --clip <id>     only this clip (repeatable)
//
// Flags for experiments:
//   --clips <file>      clip selection file (default bench/clips.json)
//   --runs <dir>        output folder for hyp.json, logs and meter files (default bench/runs)
//   --cache <dir>       CLI cache (default bench/runs/cache, or <runs>/cache with --runs); concurrent runs need
//                       their own
//   --cli <path>        the CLI to run (default packages/cli/dist/cli.js)
//   --no-context        do not pass the clip's --context
//   --cli-arg <arg>     extra argument for the CLI (repeatable), e.g. --cli-arg --no-infer-context
//   --keep-meter        keep this run's HTTP log as meter.jsonl even when some stages came from the cache
//
// Run from the repository root: the CLI reads .env from the current directory.
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { meterSummary } from './lib/meter-summary.mjs';

const BENCH = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(BENCH, '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const CLI = resolve(flag('--cli') ?? join(ROOT, 'packages/cli/dist/cli.js'));
const CLIPS = resolve(flag('--clips') ?? join(BENCH, 'clips.json'));
const RUNS = resolve(flag('--runs') ?? join(BENCH, 'runs'));
const CACHE = resolve(flag('--cache') ?? (flag('--runs') ? join(RUNS, 'cache') : join(BENCH, 'runs/cache')));
const noContext = argv.includes('--no-context');
const keepMeter = argv.includes('--keep-meter');
const extraArgs = argv.flatMap((a, i) => (a === '--cli-arg' ? [argv[i + 1]] : []));
const TEXT = 'azure-openai:gpt-transcribe';
const LLM = 'azure-openai:gpt-6.1-sol';
const TIMING = 'azure-speech';

const fresh = argv.includes('--fresh');
const only = argv.flatMap((a, i) => (a === '--clip' ? [argv[i + 1]] : []));

if (process.cwd() !== ROOT) { console.error(`error: run from the repository root (${ROOT})`); process.exit(1); }
if (!existsSync(CLI)) { console.error(`error: ${relative(ROOT, CLI)} is missing; run \`npm run build\` first`); process.exit(1); }

const { clips } = JSON.parse(readFileSync(CLIPS, 'utf8'));
// bench/overtone.bench.json points at bench/runs/cache; another cache needs its own config.
let CONFIG = join(BENCH, 'overtone.bench.json');
if (CACHE !== join(BENCH, 'runs/cache')) {
  mkdirSync(RUNS, { recursive: true });
  CONFIG = join(RUNS, 'overtone.bench.json');
  writeFileSync(CONFIG, JSON.stringify({ cacheDir: CACHE }, null, 2) + '\n');
}
const rel = (p) => relative(ROOT, p);
const gitHead = () => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(); } catch { return undefined; } };

function runCli(args, env, logPath) {
  return new Promise((resolveRun) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, ['--import', join(BENCH, 'lib/meter.mjs'), CLI, ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let log = '';
    p.stderr.on('data', (d) => { log += d; process.stderr.write(d); });
    p.stdout.on('data', (d) => { log += d; });
    p.on('close', (code) => { writeFileSync(logPath, log); resolveRun({ code, log, wallSeconds: (Date.now() - t0) / 1000 }); });
  });
}

/** The cached answer of the last run for a request of `role` in `stage` that sent the audio with this SHA-256. */
function lastAnswer(cache, role, stage, audioHash) {
  const dir = join(cache, 'requests');
  const hits = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.startsWith(`${role}-`) && f.endsWith('.json'))
    .map((f) => ({ f, entry: JSON.parse(readFileSync(join(dir, f), 'utf8')) }))
    .filter(({ entry }) => entry.stage === stage && entry.request?.audio === audioHash && entry.response !== undefined)
    // mtime is the CLI's last use
    .sort((a, b) => statSync(join(dir, b.f)).mtimeMs - statSync(join(dir, a.f)).mtimeMs);
  if (hits.length === 0) throw new Error(`no cached ${role} answer for ${audioHash.slice(0, 16)} in ${rel(dir)}`);
  return hits[0].entry.response;
}
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function parseLog(log) {
  const stages = {};
  // "done in 3.2 s", "done in 0.1 s (all 4 provider requests from the cache)" or (extract) "cached"
  for (const m of log.matchAll(/^\[\d+\/\d+\] (\w+): (?:done in ([\d.]+) s(?: \((.+) from the cache\))?|(cached))$/gm)) stages[m[1]] = m[3] || m[4] ? 'cached' : Number(m[2]);
  const lines = log.trim().split('\n');
  const summary = lines.reverse().find((l) => /^\d+ words( |:)/.test(l));
  const language = /language: (\S+) \(([^)]*)\)/.exec(log);
  const rejected = Number(/(\d+) rejected/.exec(summary ?? '')?.[1] ?? 0);
  const warnings = (log.match(/^warning: /gm) ?? []).length;
  return { stages, summary, language: language ? { code: language[1], source: language[2] } : undefined, rejectedEdits: rejected, warnings, timedOut: timedOutUsage(log) };
}

/**
 * Timed-out requests per role from the CLI's usage line: `{ text: { requests, audioSeconds }, … }`. The HTTP log has
 * no usage for them, but the service may bill them.
 */
function timedOutUsage(log) {
  const line = /^usage: (.*)$/m.exec(log)?.[1] ?? '';
  const out = {};
  for (const part of line.split(' · ')) {
    const m = /^(text|timing|llm) \S+ \d+ requests? \((\d+) timed out(?: with ([\d.]+) s audio)?, may be billed\)/.exec(part);
    if (m) out[m[1]] = { requests: (out[m[1]]?.requests ?? 0) + Number(m[2]), audioSeconds: (out[m[1]]?.audioSeconds ?? 0) + Number(m[3] ?? 0) };
  }
  return out;
}

for (const clip of clips) {
  if (only.length && !only.includes(clip.id)) continue;
  const flac = join(BENCH, 'data', clip.id, 'audio.flac');
  const media = existsSync(flac) ? flac : join(BENCH, 'data', clip.id, 'audio.wav');
  if (!existsSync(media)) { console.error(`error: ${rel(media)} missing; run \`node bench/fetch.mjs\` first`); process.exit(1); }
  const outDir = join(RUNS, clip.id);
  mkdirSync(outDir, { recursive: true });
  const meterPath = join(outDir, 'meter.partial.jsonl');
  writeFileSync(meterPath, '');
  const args = ['transcribe', rel(media), '--text', TEXT, '--timing', TIMING, '--llm', LLM, ...(noContext ? [] : ['--context', clip.context]),
    '--export', 'json,txt', '--out', rel(outDir), '--config', rel(CONFIG), ...extraArgs, ...(fresh ? ['--no-cache'] : [])];
  console.error(`\n=== ${clip.id}: node packages/cli/dist/cli.js ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  // cli.log: the last run that did all the work; a run with cached stages logs to cli.cached.log
  const cliSha256 = createHash('sha256').update(readFileSync(CLI)).digest('hex').slice(0, 16); // the dist the run used
  const logFile = join(outDir, fresh ? 'cli.log' : 'cli.cached.log');
  const res = await runCli(args, { BENCH_METER_FILE: meterPath }, logFile);
  // On a non-speech clip, "No words to caption" is the right answer.
  const noWords = clip.nonSpeech && res.code !== 0 && /No words to caption/.test(res.log);
  if (res.code !== 0 && !noWords) { console.error(`error: CLI failed for ${clip.id} (exit ${res.code}); see ${rel(logFile)}`); process.exitCode = 1; continue; }

  const hash = createHash('sha256').update(readFileSync(media)).digest('hex').slice(0, 16);
  const cache = join(CACHE, hash);
  const extracted = JSON.parse(readFileSync(join(cache, 'extract.json'), 'utf8')).data;
  const transcribe = { chunks: extracted.chunks.map((c) => ({ text: lastAnswer(cache, 'text', 'transcribe', sha256(join(cache, basename(c.path)))).text.trim() })) };
  const timing = lastAnswer(cache, 'timing', 'timing', sha256(join(cache, basename(extracted.wav))));
  // The second hearing (ElevenLabs Scribe), when the run had one.
  let scribe;
  try { scribe = lastAnswer(cache, 'speech', 'timing', sha256(join(cache, basename(extracted.wav)))); } catch { scribe = undefined; }
  const docPath = join(outDir, 'audio.overtone.json');
  if (noWords) rmSync(docPath, { force: true }); // an earlier run's document
  const doc = noWords ? { turns: [] } : JSON.parse(readFileSync(docPath, 'utf8'));
  const parsed = parseLog(res.log);
  const prev = existsSync(join(outDir, 'hyp.json')) ? JSON.parse(readFileSync(join(outDir, 'hyp.json'), 'utf8')) : undefined;
  const anyCached = Object.values(parsed.stages).includes('cached');
  // Runtimes, usage and the HTTP log count only for a run that did all the work; otherwise keep the last fresh run's.
  if (!anyCached || keepMeter) renameSync(meterPath, join(outDir, 'meter.jsonl')); else rmSync(meterPath, { force: true });
  if (!anyCached && !fresh) renameSync(join(outDir, 'cli.cached.log'), join(outDir, 'cli.log'));
  const perf = anyCached && prev?.perf && !keepMeter ? prev.perf : { stages: parsed.stages, wallSeconds: res.wallSeconds, timedOut: parsed.timedOut, meter: meterSummary(join(outDir, 'meter.jsonl')), ranAt: new Date().toISOString(), cachedStages: anyCached, cliSha256, gitHead: gitHead() };
  const hyp = {
    clip: clip.id,
    command: `node packages/cli/dist/cli.js ${args.join(' ')}`,
    models: doc.meta?.models,
    generator: doc.meta?.generator,
    language: { document: doc.language, ...parsed.language },
    summary: parsed.summary,
    rejectedEdits: parsed.rejectedEdits,
    edits: doc.edits?.length ?? 0,
    perf,
    ...(noWords ? { noWords: true } : {}),
    overtone: { words: doc.turns.flatMap((t) => t.words.map((w) => ({ text: w.text, start: w.start, end: w.end, speaker: t.speaker, match: w.match }))) },
    textOnly: { text: transcribe.chunks.map((c) => c.text).join(' '), chunks: transcribe.chunks.length, source: 'request cache (raw gpt-transcribe text, chunks joined)' },
    azure: { words: timing.words.map((w) => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker })), language: timing.language, source: 'request cache (Azure Speech fast transcription words)' },
    ...(scribe ? { scribe: { words: scribe.words.map((w) => ({ text: w.text, start: w.start, end: w.end, speaker: w.speaker })), language: scribe.language, source: 'request cache (ElevenLabs Scribe words of the second hearing)' } } : {}),
  };
  writeFileSync(join(outDir, 'hyp.json'), JSON.stringify(hyp, null, 1) + '\n');
  console.error(`${clip.id}: ${parsed.summary ?? '(no summary line)'}${anyCached ? '  [some stages cached; perf kept from the last fresh run]' : ''}`);
}
