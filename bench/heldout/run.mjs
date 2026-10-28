#!/usr/bin/env node
// Live runs of the held-out study (PROTOCOL.md, "Systems") on the clips of clips.json that have an excerpt:
//
//   A  OpenAI whisper-1 with word timestamps (one call); scored with lines filled up to the length limit
//   B  ElevenLabs scribe_v2 with diarization and its own SRT export (42/84 and 22/44 characters), one call
//   C  Azure AI Speech: its words from E's timing hearing (no extra call); scored with lines filled to the limit
//   D  overtone recut on B's horizontal SRT (layout only, offline)
//   E  overtone transcribe: gpt-transcribe and gpt-6.1-sol (Azure OpenAI deployments of the same models) with
//      Azure AI Speech, no second hearing
//   F  E plus ElevenLabs Scribe as the second hearing
//
//   node bench/heldout/run.mjs                  every clip and system; skips outputs that already exist
//   node bench/heldout/run.mjs --clip <id>      only this clip (repeatable)
//   node bench/heldout/run.mjs --system <A-F>   only this system (repeatable)
//
// Live and billable. Run from the repository root (the CLI reads .env there); keys are read from .env and never
// printed or written. Everything goes to bench/heldout/data/ (git-ignored): audio/<clip>.wav, runs/<clip>/<system>/,
// and the Overtone cache (data/cache, set in overtone.heldout.json).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envVar } from '../lib/env.mjs';
import { meterSummary } from '../lib/meter-summary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const CLI = join(ROOT, 'packages/cli/dist/cli.js');
const DATA = join(HERE, 'data');
const CONFIG = join(HERE, 'overtone.heldout.json');
const AZURE_TEXT = 'azure-openai:gpt-transcribe';
const AZURE_LLM = 'azure-openai:gpt-6.1-sol';
const ELEVENLABS_SRT = {
  horizontal: { format: 'srt', max_characters_per_line: 42, max_segment_chars: 84 },
  vertical: { format: 'srt', max_characters_per_line: 22, max_segment_chars: 44 },
};

const argv = process.argv.slice(2);
const pick = (name) => argv.flatMap((a, i) => (a === name ? [argv[i + 1]] : []));
const onlyClips = pick('--clip');
const onlySystems = pick('--system');
const want = (s) => !onlySystems.length || onlySystems.includes(s);
if (process.cwd() !== ROOT) { console.error(`error: run from the repository root (${ROOT})`); process.exit(1); }
const rel = (p) => relative(ROOT, p);

/** The clip's sound as 16 kHz mono WAV (what every system gets). */
function audioOf(clip) {
  const wav = join(DATA, 'audio', `${clip.id}.wav`);
  if (!existsSync(wav)) {
    mkdirSync(dirname(wav), { recursive: true });
    execFileSync('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-i', join(HERE, clip.excerpt.file), '-vn', '-ac', '1', '-ar', '16000', wav]);
  }
  return wav;
}

function runCli(clip, system, args, outDir) {
  const meter = join(outDir, 'meter.jsonl');
  writeFileSync(meter, '');
  console.error(`[${clip.id}] ${system}: overtone ${args.join(' ')}`);
  return new Promise((done) => {
    const t0 = Date.now();
    const p = spawn(process.execPath, ['--import', join(ROOT, 'bench/lib/meter.mjs'), CLI, ...args],
      { cwd: ROOT, env: { ...process.env, BENCH_METER_FILE: meter } });
    let log = '';
    p.stdout.on('data', (d) => (log += d));
    p.stderr.on('data', (d) => (log += d));
    p.on('close', (code) => {
      writeFileSync(join(outDir, 'cli.log'), log);
      const seconds = (Date.now() - t0) / 1000;
      writeFileSync(join(outDir, 'run.json'), `${JSON.stringify({ system, code, seconds, args, usage: meterSummary(meter) }, null, 2)}\n`);
      console.error(`[${clip.id}] ${system}: ${code === 0 ? 'done' : `FAILED (exit ${code}, see ${rel(join(outDir, 'cli.log'))})`} in ${seconds.toFixed(0)} s`);
      done(code === 0);
    });
  });
}

const transcribeArgs = (clip, wav, outDir, second) => ['transcribe', rel(wav), '--text', AZURE_TEXT, '--llm', AZURE_LLM,
  '--timing', 'azure-speech', '--timing-second-opinion', second, '--language', clip.language,
  '--export', 'json,vtt,srt', '--out', rel(outDir), '--config', rel(CONFIG)];

async function post(clip, system, url, headers, form, outDir) {
  const t0 = Date.now();
  let res;
  for (let attempt = 1; !res; attempt++) {
    try { res = await fetch(url, { method: 'POST', headers, body: form }); } catch (err) {
      if (attempt >= 2) throw err;
      console.error(`[${clip.id}] ${system}: ${err.message}; retrying once`);
    }
  }
  const text = await res.text();
  const seconds = (Date.now() - t0) / 1000;
  if (!res.ok) { console.error(`[${clip.id}] ${system}: FAILED HTTP ${res.status}: ${text.slice(0, 300)}`); return undefined; }
  console.error(`[${clip.id}] ${system}: done in ${seconds.toFixed(0)} s`);
  writeFileSync(join(outDir, 'run.json'), `${JSON.stringify({ system, seconds }, null, 2)}\n`);
  return JSON.parse(text);
}

async function runA(clip, wav, outDir) {
  const key = envVar(ROOT, 'OPENAI_API_KEY');
  if (!key) { console.error(`[${clip.id}] A: OPENAI_API_KEY is not set; skipped`); return false; }
  const form = new FormData();
  form.append('model', 'whisper-1');
  form.append('file', new Blob([readFileSync(wav)], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('language', clip.language);
  const body = await post(clip, 'A', 'https://api.openai.com/v1/audio/transcriptions', { Authorization: `Bearer ${key}` }, form, outDir);
  if (body) writeFileSync(join(outDir, 'response.json'), `${JSON.stringify(body, null, 2)}\n`);
  return Boolean(body);
}

async function runB(clip, wav, outDir) {
  const key = envVar(ROOT, 'ELEVENLABS_API_KEY');
  if (!key) { console.error(`[${clip.id}] B: ELEVENLABS_API_KEY is not set; skipped`); return false; }
  const form = new FormData();
  form.append('model_id', 'scribe_v2');
  form.append('file', new Blob([readFileSync(wav)], { type: 'audio/wav' }), 'audio.wav');
  form.append('timestamps_granularity', 'word');
  form.append('diarize', 'true');
  form.append('tag_audio_events', 'false');
  form.append('language_code', clip.language);
  form.append('additional_formats', JSON.stringify(Object.values(ELEVENLABS_SRT)));
  const body = await post(clip, 'B', 'https://api.elevenlabs.io/v1/speech-to-text', { 'xi-api-key': key }, form, outDir);
  if (!body) return false;
  writeFileSync(join(outDir, 'response.json'), `${JSON.stringify(body, null, 2)}\n`);
  Object.keys(ELEVENLABS_SRT).forEach((profile, k) => {
    const f = (body.additional_formats ?? [])[k];
    if (!f) throw new Error(`ElevenLabs returned no ${profile} SRT`);
    writeFileSync(join(outDir, `${profile}.srt`), f.is_base64_encoded ? Buffer.from(f.content, 'base64') : f.content);
  });
  return true;
}

async function runClip(clip) {
  const wav = audioOf(clip);
  const dir = (s) => { const d = join(DATA, 'runs', clip.id, s); mkdirSync(d, { recursive: true }); return d; };
  const done = (s, file) => existsSync(join(DATA, 'runs', clip.id, s, file));
  const jobs = [];
  if (want('A') && !done('A', 'response.json')) jobs.push(runA(clip, wav, dir('A')));
  if (want('B') && !done('B', 'horizontal.srt')) jobs.push(runB(clip, wav, dir('B')));
  if (want('E') && !done('E', `${clip.id}.overtone.json`)) jobs.push(runCli(clip, 'E', transcribeArgs(clip, wav, dir('E'), 'none'), dir('E')));
  await Promise.all(jobs);
  // F reuses E's cached hearings (same requests); D needs B's SRT
  if (want('F') && !done('F', `${clip.id}.overtone.json`)) await runCli(clip, 'F', transcribeArgs(clip, wav, dir('F'), 'elevenlabs'), dir('F'));
  if (want('D') && !done('D', 'horizontal.overtone.json') && done('B', 'horizontal.srt')) {
    await runCli(clip, 'D', ['recut', rel(join(DATA, 'runs', clip.id, 'B', 'horizontal.srt')), '--language', clip.language,
      '--export', 'json,srt', '--out', rel(dir('D')), '--config', rel(CONFIG)], dir('D'));
  }
}

const { clips } = JSON.parse(readFileSync(join(HERE, 'clips.json'), 'utf8'));
const todo = clips.filter((c) => c.excerpt && (!onlyClips.length || onlyClips.includes(c.id)));
for (let i = 0; i < todo.length; i += 2) await Promise.all(todo.slice(i, i + 2).map(runClip));
