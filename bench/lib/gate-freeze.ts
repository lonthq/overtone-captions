// Freezes the regression gate's fixtures (packages/cli/test/fixtures/bench/) from saved runs on this machine: cached
// answers (stage caches or the request cache), Scribe's whole-file words and the references. Answers a fixture
// already holds are kept.
//
// `--live` sends the requests no saved run answers once to the real providers (keys from .env) and freezes them.
// That costs money; the run prints what it sent. Run through bench/gate-freeze.mjs, on the machine that made the runs.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseModelSpec, resolveConfig } from '../../packages/cli/src/config.js';
import { cutAudio, normalizeLoudness } from '../../packages/cli/src/media/extract.js';
import { createProvider, resolveSelection } from '../../packages/cli/src/providers/registry.js';
import { withSchemaValidation } from '../../packages/cli/src/providers/structured.js';
import type { LlmProvider, TextProvider, TimingProvider } from '../../packages/cli/src/providers/types.js';
import { formatUsage, UsageMeter } from '../../packages/cli/src/usage.js';
import { FIXTURE_DIR, parseSrt, readFixture, REPO, type BenchWord, type Fixture, type Reference } from '../../packages/cli/test/bench/fixture.js';
import { llmKey, runOvertone, spanKey, textKey } from '../../packages/cli/test/bench/run.js';

const EL3 = 'bench/experiments/2026-10-17-elevenlabs-3runs/cache-r1';
const BLENDER = { level: 'high' as const, note: "a Blender open movie: a ubiquitous test asset, very likely in the engines' training data (ElevenLabs writes the script's \"Thom\" and \"Vivacissimo\" without any context). Kept for regression and timing checks of our own pipeline only." };
const PUBLIC = (what: string) => ({ level: 'possible' as const, note: `${what}: a public dataset that may be in any engine's training data.` });
/** The provider ids of the stage caches' relisten entries. */
const PROVIDER_OF: Record<string, string> = { 'azure-speech-fast': 'azure-speech:fast', 'elevenlabs-scribe_v2': 'elevenlabs:scribe_v2' };

/** The context the text vote's chooser gets. */
const FILM = {
  tos: 'Tears of Steel (2012), a Blender Foundation live-action science-fiction short film: in a future Amsterdam, scientists try to stop an army of robots by recreating the moment Thom broke up with Celia, the robotics student with a robot hand who built them.',
  ed: 'Elephants Dream (2006), a Blender Foundation animated short film: the old Proog guides the young Emo through a strange, seemingly endless machine, and Emo grows more and more skeptical of him.',
  cosmos: 'Cosmos Laundromat: First Cycle (2015), a Blender Institute animated short film: on a desolate island, Franck, a suicidal sheep, meets Victor, a mysterious salesman who offers him the gift of a lifetime.',
};
const contextOf = (file: string, id: string): string => (JSON.parse(readFileSync(join(REPO, file), 'utf8')).clips as Array<{ id: string; context: string }>).find((c) => c.id === id)!.context;
const glossary = (file: string): string[] => readFileSync(join(REPO, file), 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);

interface ClipSource {
  id: string;
  title: string;
  kind: string;
  /** A cache folder (stage caches or a request cache) with audio.wav. */
  cache: string;
  textProvider: string;
  timingProvider: string;
  license: string;
  attribution: string;
  contamination: Fixture['contamination'];
  elevenlabs?: { path: string; format: 'api' | 'words' | 'cache' | 'request'; note: string };
  reference?: { kind: 'bench-data'; clip: string; source: string } | { kind: 'srt'; path: string; source: string };
  localReference?: Fixture['localReference'];
  timingReference?: string;
  /** For the chooser. */
  context: () => string;
  names?: () => string[];
  /** The prompt the saved run sent with its chunks (for the echo guard). */
  prompt?: () => string;
  /** The saved text holds a prompt echo: also freeze the answers of the run without the echo guard. */
  echo?: boolean;
  /** Audio without speech: the gate checks that no words are output. */
  nonSpeech?: boolean;
  /** Where the speech starts (s): the gate checks that no word starts before it. */
  speechStart?: number;
  notes?: string[];
}

/**
 * The clips of bench/clips.standard.json and bench/clips.nonspeech.json, frozen from a run with the second hearing.
 * Earnings-22 is left out: the calls' audio belongs to the companies, so their transcripts are not committed.
 */
function NEW_SETS(): ClipSource[] {
  const RUN = 'bench/runs/2026-10-23-new/scribe/run1/cache';
  const scribe = (hash: string) => {
    const dir = join(REPO, RUN, hash, 'requests');
    const file = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith('speech-') && JSON.parse(readFileSync(join(dir, f), 'utf8')).stage === 'timing') : undefined;
    return file ? { elevenlabs: { path: `${RUN}/${hash}/requests/${file}`, format: 'request' as const, note: 'ElevenLabs Scribe v2, the second hearing of the whole file (bench/runs/2026-10-23-new/scribe/run1)' } } : {};
  };
  const base = (id: string, hash: string, clipsFile: string) => ({
    id, cache: `${RUN}/${hash}`, textProvider: 'azure-openai:gpt-transcribe', timingProvider: 'azure-speech:fast',
    ...scribe(hash), context: () => contextOf(clipsFile, id), prompt: () => contextOf(clipsFile, id),
  });
  const GENERATED = { license: 'none needed (generated with ffmpeg)', attribution: 'generated (bench/clips.nonspeech.json)', contamination: { level: 'none' as const, note: 'a generated signal, in no training set.' } };
  const SPRING = { license: 'CC BY 4.0', attribution: 'Spring, Andy Goralczyk / Blender Foundation, studio.blender.org', contamination: BLENDER };
  return [
    {
      ...base('libri-other-7018-75788', '6ac9dea46644c872', 'bench/clips.standard.json'),
      title: 'LibriSpeech test-other 7018-75788, utterances 0–17', kind: 'audiobook, 1 reader (test-other)',
      license: 'CC BY 4.0', attribution: 'LibriSpeech (Panayotov et al. 2015), LibriSpeech-PC (Meister et al. 2023), word times by Mila (Montreal Forced Aligner)', contamination: PUBLIC('LibriSpeech'),
      reference: { kind: 'bench-data', clip: 'libri-other-7018-75788', source: 'LibriSpeech-PC test-other text (CC BY 4.0), word times from forced alignment (Mila, CC BY 4.0)' },
    },
    { ...base('silence-60', '99951b78edc7b296', 'bench/clips.nonspeech.json'), title: '60 s of digital silence', kind: 'no speech: silence', ...GENERATED, nonSpeech: true },
    { ...base('noise-white-60', '7cb1d33c60c12073', 'bench/clips.nonspeech.json'), title: '60 s of white noise', kind: 'no speech: white noise', ...GENERATED, nonSpeech: true },
    { ...base('noise-pink-60', '43133d5445b63a5b', 'bench/clips.nonspeech.json'), title: '60 s of pink noise', kind: 'no speech: pink noise', ...GENERATED, nonSpeech: true },
    { ...base('hum-60', '9fac2e866624ef9c', 'bench/clips.nonspeech.json'), title: '60 s of 50 Hz hum', kind: 'no speech: mains hum', ...GENERATED, nonSpeech: true },
    { ...base('spring', '4b580650bcac232c', 'bench/clips.nonspeech.json'), title: 'Spring (Blender Studio, 2019)', kind: 'animated film without dialogue: music and effects', ...SPRING, nonSpeech: true },
    {
      ...base('music-then-speech', 'e81fde3c4efddece', 'bench/clips.nonspeech.json'),
      title: 'The first 60 s of Spring, then FLEURS nl_nl rows 0–17', kind: 'film music, then read sentences, Dutch',
      license: 'CC BY 4.0 (both)', attribution: 'Spring, Andy Goralczyk / Blender Foundation; FLEURS (Conneau et al. 2022), Google', contamination: PUBLIC('FLEURS and a Blender film'),
      reference: { kind: 'bench-data', clip: 'music-then-speech', source: 'FLEURS raw_transcription (CC BY 4.0), no word times' },
      speechStart: 60,
    },
  ];
}

const AMI = 'AMI Meeting Corpus (University of Edinburgh), CC BY 4.0; word times from forced alignment of the manual transcript';
const CLIPS: ClipSource[] = [
  {
    id: 'tears-of-steel', title: 'Tears of Steel (Blender Foundation, 2012)', kind: 'film: dialogue over music and effects',
    cache: '.overtone/efa9062d9cdb7a33', textProvider: 'azure-openai:gpt-transcribe', timingProvider: 'azure-speech:fast',
    license: 'CC BY 3.0', attribution: '(CC) Blender Foundation | mango.blender.org', contamination: BLENDER,
    elevenlabs: { path: 'bench/captions/data/runs/tears-of-steel/elevenlabs/response.json', format: 'api', note: 'ElevenLabs Scribe v2 on the whole file, no keyterms or context (bench/captions/run.mjs, 2026-10-17)' },
    localReference: { path: 'bench/captions/data/tears-of-steel/reference.srt', format: 'srt', source: 'the official English subtitles, https://download.blender.org/demo/movies/ToS/subtitles/TOS-en.srt (license not stated, so not committed)' },
    timingReference: 'elevenlabs',
    context: () => FILM.tos, names: () => glossary('examples/output/tears-of-steel/glossary.txt'),
  },
  {
    id: 'elephants-dream', title: 'Elephants Dream (Blender Foundation, 2006)', kind: 'animated film: dialogue over music and effects',
    cache: '.overtone/6fc295e0e9283531', textProvider: 'azure-openai:gpt-transcribe', timingProvider: 'azure-speech:fast',
    license: 'CC BY 2.5', attribution: '(c) copyright 2006, Blender Foundation / Netherlands Media Art Institute / www.elephantsdream.org', contamination: BLENDER,
    elevenlabs: { path: 'bench/data/gate-sources/elephants-dream.elevenlabs.json', format: 'words', note: 'ElevenLabs Scribe v2 on the whole file, language en, no keyterms (2026-10-18)' },
    timingReference: 'elevenlabs',
    context: () => FILM.ed, names: () => glossary('examples/output/elephants-dream/glossary.txt'),
  },
  {
    id: 'cosmos-laundromat', title: 'Cosmos Laundromat (Blender Institute, 2015)', kind: 'animated film: dialogue over music and effects',
    cache: '.overtone/8c8030191c97a5a4', textProvider: 'azure-openai:gpt-transcribe', timingProvider: 'azure-speech:fast',
    license: 'CC BY 4.0', attribution: '(CC) Blender Foundation | gooseberry.blender.org', contamination: BLENDER,
    elevenlabs: { path: 'bench/data/gate-sources/cosmos-laundromat.elevenlabs.json', format: 'words', note: 'ElevenLabs Scribe v2 on the whole file, language en, no keyterms (2026-10-18)' },
    timingReference: 'elevenlabs',
    context: () => FILM.cosmos, names: () => glossary('examples/output/cosmos-laundromat/glossary.txt'),
  },
  {
    id: 'nasa-oravec', title: 'Surprisingly STEM: Space Tire Engineer (NASA, 2023)', kind: 'interview-style documentary, 1 main speaker',
    cache: 'bench/captions/data/cache/9ec5e8125e07fad0', textProvider: 'azure-openai:gpt-transcribe', timingProvider: 'azure-speech',
    license: 'NASA media, US public domain (no endorsement implied)', attribution: 'NASA', contamination: PUBLIC('a public NASA video with published captions'),
    elevenlabs: { path: 'bench/captions/data/runs/nasa-oravec/elevenlabs/response.json', format: 'api', note: 'ElevenLabs Scribe v2 on the whole file, no keyterms or context (bench/captions/run.mjs, 2026-10-17)' },
    reference: { kind: 'srt', path: 'bench/captions/data/nasa-oravec/reference.srt', source: "NASA's captions for the video (images-assets.nasa.gov, SurprisinglySTEM_HeatherOravec_Social_jsc2023m000129.srt), US public domain" },
    context: () => contextOf('bench/captions/clips.json', 'nasa-oravec'), prompt: () => contextOf('bench/captions/clips.json', 'nasa-oravec'),
  },
  {
    id: 'nasa-ayers', title: 'Connecting Classrooms to Space: Ham Radio Explainer (NASA, 2025)', kind: 'talk to camera, 1 main speaker plus radio call signs',
    cache: 'bench/captions/data/cache/d671a3fe5c44ce8f', textProvider: 'azure-openai:gpt-transcribe', timingProvider: 'azure-speech',
    license: 'NASA media, US public domain (no endorsement implied)', attribution: 'NASA', contamination: PUBLIC('a public NASA video with published captions'),
    elevenlabs: { path: 'bench/captions/data/runs/nasa-ayers/elevenlabs/response.json', format: 'api', note: 'ElevenLabs Scribe v2 on the whole file, no keyterms or context (bench/captions/run.mjs, 2026-10-17)' },
    reference: { kind: 'srt', path: 'bench/captions/data/nasa-ayers/reference.srt', source: "NASA's captions for the video (images-assets.nasa.gov, jsc2025m000040_…_Nichole_Ayers.srt), US public domain" },
    context: () => contextOf('bench/captions/clips.json', 'nasa-ayers'), prompt: () => contextOf('bench/captions/clips.json', 'nasa-ayers'), echo: true,
    notes: ["The saved run's text begins with the --context sentence, which gpt-transcribe echoed where the speakers say radio call signs (29 words never said); the prompt echo guard (echo.ts) removes it."],
  },
  {
    id: 'ami-es2004a', title: 'AMI ES2004a, 630–850 s (scenario meeting)', kind: 'meeting, 4 speakers',
    cache: 'bench/runs/cache/cc9d0c853a33de93', textProvider: 'azure-openai:gpt-transcribe', timingProvider: 'azure-speech',
    license: 'CC BY 4.0', attribution: 'AMI Meeting Corpus, University of Edinburgh', contamination: PUBLIC('AMI Meeting Corpus'),
    elevenlabs: { path: `${EL3}/cc9d0c853a33de93/transcribe.json`, format: 'cache', note: 'ElevenLabs Scribe v2 as text and timing provider (bench/experiments/2026-10-17-elevenlabs-3runs, run 1)' },
    reference: { kind: 'bench-data', clip: 'ami-es2004a', source: AMI },
    context: () => contextOf('bench/clips.json', 'ami-es2004a'), prompt: () => contextOf('bench/clips.json', 'ami-es2004a'),
  },
  {
    id: 'ami-en2002a', title: 'AMI EN2002a, 558–783 s (natural meeting)', kind: 'meeting, 4 speakers, overlapping speech',
    cache: 'bench/runs/cache/06616cb30e113564', textProvider: 'azure-openai:gpt-transcribe', timingProvider: 'azure-speech',
    license: 'CC BY 4.0', attribution: 'AMI Meeting Corpus, University of Edinburgh', contamination: PUBLIC('AMI Meeting Corpus'),
    elevenlabs: { path: `${EL3}/06616cb30e113564/transcribe.json`, format: 'cache', note: 'ElevenLabs Scribe v2 as text and timing provider (bench/experiments/2026-10-17-elevenlabs-3runs, run 1)' },
    reference: { kind: 'bench-data', clip: 'ami-en2002a', source: AMI },
    context: () => contextOf('bench/clips.json', 'ami-en2002a'), prompt: () => contextOf('bench/clips.json', 'ami-en2002a'),
    notes: ['gpt-transcribe returned an empty text in every saved run of this clip (with the context as prompt and no language); the one retry (loudness-normalized, language en, no prompt; recorded 2026-10-18) answered 715 words, which are the text base.'],
  },
  {
    id: 'libri-672-122797', title: 'LibriSpeech test-clean 672-122797, utterances 0–22', kind: 'audiobook, 1 reader',
    cache: 'bench/runs/cache/c49364c349d57d9d', textProvider: 'azure-openai:gpt-transcribe', timingProvider: 'azure-speech',
    license: 'CC BY 4.0', attribution: 'LibriSpeech (Panayotov et al. 2015) and LibriSpeech-PC (Meister et al. 2023)', contamination: PUBLIC('LibriSpeech'),
    elevenlabs: { path: `${EL3}/c49364c349d57d9d/transcribe.json`, format: 'cache', note: 'ElevenLabs Scribe v2 as text and timing provider (bench/experiments/2026-10-17-elevenlabs-3runs, run 1)' },
    reference: { kind: 'bench-data', clip: 'libri-672-122797', source: 'LibriSpeech-PC test-clean text (CC BY 4.0), word times from forced alignment (Mila, CC BY 4.0)' },
    context: () => contextOf('bench/clips.json', 'libri-672-122797'), prompt: () => contextOf('bench/clips.json', 'libri-672-122797'),
  },
  {
    id: 'fleurs-nl', title: 'FLEURS nl_nl test, rows 0–17', kind: 'read sentences, Dutch',
    cache: 'bench/runs/cache/d9476e6d9fd7de0e', textProvider: 'azure-openai:gpt-transcribe', timingProvider: 'azure-speech',
    license: 'CC BY 4.0', attribution: 'FLEURS (Conneau et al. 2022), Google', contamination: PUBLIC('FLEURS'),
    elevenlabs: { path: `${EL3}/d9476e6d9fd7de0e/transcribe.json`, format: 'cache', note: 'ElevenLabs Scribe v2 as text and timing provider (bench/experiments/2026-10-17-elevenlabs-3runs, run 1)' },
    reference: { kind: 'bench-data', clip: 'fleurs-nl', source: 'FLEURS raw_transcription (CC BY 4.0), no word times' },
    context: () => contextOf('bench/clips.json', 'fleurs-nl'), prompt: () => contextOf('bench/clips.json', 'fleurs-nl'),
  },
  {
    id: 'fleurs-de', title: 'FLEURS de_de test, rows 0–11', kind: 'read sentences, German',
    cache: 'bench/experiments/2026-10-17-variance-context/X-r1/cache/3768c7911c88529f', textProvider: 'azure-openai:gpt-transcribe', timingProvider: 'azure-speech',
    license: 'CC BY 4.0', attribution: 'FLEURS (Conneau et al. 2022), Google', contamination: PUBLIC('FLEURS'),
    elevenlabs: { path: `${EL3}/3768c7911c88529f/transcribe.json`, format: 'cache', note: 'ElevenLabs Scribe v2 as text and timing provider (bench/experiments/2026-10-17-elevenlabs-3runs, run 1)' },
    reference: { kind: 'bench-data', clip: 'fleurs-de', source: 'FLEURS raw_transcription (CC BY 4.0), no word times' },
    context: () => contextOf('bench/clips.extra.json', 'fleurs-de'),
  },
  {
    id: 'fleurs-es', title: 'FLEURS es_419 test, rows 0–15', kind: 'read sentences, Spanish',
    cache: 'bench/experiments/2026-10-17-variance-context/X-r1/cache/7f219e2300138fe9', textProvider: 'azure-openai:gpt-transcribe', timingProvider: 'azure-speech',
    license: 'CC BY 4.0', attribution: 'FLEURS (Conneau et al. 2022), Google', contamination: PUBLIC('FLEURS'),
    elevenlabs: { path: `${EL3}/7f219e2300138fe9/transcribe.json`, format: 'cache', note: 'ElevenLabs Scribe v2 as text and timing provider (bench/experiments/2026-10-17-elevenlabs-3runs, run 1)' },
    reference: { kind: 'bench-data', clip: 'fleurs-es', source: 'FLEURS raw_transcription (CC BY 4.0), no word times' },
    context: () => contextOf('bench/clips.extra.json', 'fleurs-es'),
  },
  ...NEW_SETS(),
];

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
/** Only the fields TimedWord has. */
const word = (w: { text: string; start: number; end: number; speaker?: string; confidence?: number }): BenchWord => ({
  text: w.text, start: w.start, end: w.end, ...(w.speaker !== undefined ? { speaker: w.speaker } : {}), ...(w.confidence !== undefined ? { confidence: w.confidence } : {}),
});

function elevenlabsWords(src: NonNullable<ClipSource['elevenlabs']>): BenchWord[] {
  const p = src.path.startsWith('/') ? src.path : join(REPO, src.path);
  const d = readJson(p);
  if (src.format === 'api') {
    return (d.words as Array<{ text: string; start: number; end: number; type: string; speaker_id?: string; logprob?: number }>)
      .filter((w) => w.type === 'word')
      .map((w) => word({ text: w.text, start: w.start, end: w.end, ...(w.speaker_id ? { speaker: w.speaker_id } : {}) }));
  }
  if (src.format === 'cache') return (d.data.chunks as Array<{ words: BenchWord[] }>).flatMap((c) => c.words).map(word);
  if (src.format === 'request') return (d.response.words as BenchWord[]).map(word);
  return (d.words as BenchWord[]).map(word);
}

function reference(src: ClipSource): Reference | undefined {
  const r = src.reference;
  if (!r) return undefined;
  if (r.kind === 'srt') return { source: r.source, cues: parseSrt(readFileSync(join(REPO, r.path), 'utf8')) };
  const d = readJson(join(REPO, 'bench/data', r.clip, 'ref.json'));
  return {
    source: r.source,
    words: (d.words as Array<{ text: string; start?: number; end?: number; speaker?: string }>).map((w) => ({
      text: w.text, ...(typeof w.start === 'number' ? { start: w.start, end: w.end } : {}), ...(w.speaker && d.hasSpeakers ? { speaker: w.speaker } : {}),
    })),
  };
}

interface Hearings {
  language: string;
  duration: number;
  chunks: Array<{ start: number; end: number; text: string; source?: string; filled?: boolean; regions?: boolean }>;
  raw: string[];
  retry?: string[];
  timing: { language?: string; words: BenchWord[] };
  windows: Fixture['relisten']['windows'];
  relistenText: Record<string, string>;
  llm: Record<string, unknown>;
}

/** A stage-cache folder (older CLI): one JSON file per stage. */
function fromStageCache(dir: string): Hearings {
  const stage = (name: string) => (existsSync(join(dir, `${name}.json`)) ? readJson(join(dir, `${name}.json`)).data : undefined);
  const extract = stage('extract');
  const align = stage('align');
  const raw = stage('transcribe');
  const covered = stage('coverage') ?? raw;
  const timing = stage('timing');
  const windows: Fixture['relisten']['windows'] = {};
  for (const f of readdirSync(dir)) {
    const m = /^relisten-(.+)-(\d+)-(\d+)\.json$/.exec(f);
    if (!m) continue;
    const provider = PROVIDER_OF[m[1]!];
    if (!provider) throw new Error(`${dir}: unknown relisten provider in ${f}`);
    (windows[provider] ??= {})[`${m[2]}-${m[3]}`] = (readJson(join(dir, f)).data.words as BenchWord[]).map(word);
  }
  const rawTexts = (raw.chunks as Array<{ text: string }>).map((c) => c.text);
  const chunks = (covered.chunks as Hearings['chunks']).map((c) => ({ start: c.start, end: c.end, text: c.text, ...(c.source ? { source: c.source } : {}), ...(c.filled ? { filled: true } : {}), ...(c.regions ? { regions: true } : {}) }));
  // The retry of an empty chunk, known when the coverage step kept its answer.
  const retries = (covered.retries ?? []) as Array<{ start: number; result: string }>;
  const retry = rawTexts.map((t, k) => (t.trim() ? '' : retries.some((r) => Math.abs(r.start - chunks[k]!.start) < 0.01 && r.result === 'retry') ? chunks[k]!.text : undefined));
  return {
    language: align.language, duration: extract.duration, chunks, raw: rawTexts,
    ...(retry.some((r) => r !== undefined && r !== '') ? { retry: retry.map((r) => r ?? '') } : {}),
    timing: { ...(timing.language ? { language: timing.language } : {}), words: (timing.words as BenchWord[]).map(word) },
    windows, relistenText: {}, llm: {},
  };
}

/**
 * A request-cache folder (current CLI). Requests are matched by SHA-256 to the chunks, the WAV and the snippets
 * (`audio.region-<startMs>-<endMs>.wav`).
 */
function fromRequestCache(dir: string, timingProvider: string, secondProvider?: string): Hearings {
  const extract = readJson(join(dir, 'extract.json')).data as { duration: number; wav: string; chunks: Array<{ path: string; start: number; end: number }> };
  const entries = readdirSync(join(dir, 'requests')).filter((f) => f.endsWith('.json')).map((f) => readJson(join(dir, 'requests', f)) as {
    role: string; provider: string; stage: string; request: Record<string, unknown>; response?: { text?: string; words?: BenchWord[]; language?: string }; error?: unknown;
  });
  const hashOf = new Map<string, string>();
  const region = new Map<string, [number, number]>();
  for (const f of readdirSync(dir)) {
    const m = /^audio\.region-(\d+)-(\d+)\.wav$/.exec(f);
    if (m) { const h = sha256(join(dir, f)); hashOf.set(f, h); region.set(h, [Number(m[1]) / 1000, Number(m[2]) / 1000]); }
  }
  const wav = sha256(join(dir, 'audio.wav'));
  const chunkHash = extract.chunks.map((c) => sha256(c.path.startsWith('/') ? c.path : join(dir, c.path)));
  const answer = (role: string, stage: string, audio: string) => entries.find((e) => e.role === role && e.stage === stage && e.request.audio === audio && e.provider === undefined) ?? entries.find((e) => e.role === role && e.stage === stage && e.request.audio === audio);
  const raw = chunkHash.map((h) => answer('text', 'transcribe', h)?.response?.text ?? '');
  const timing = entries.find((e) => e.role === 'timing' && e.request.audio === wav && e.provider === timingProvider);
  if (!timing?.response?.words) throw new Error(`${dir}: no whole-file timing answer of ${timingProvider} in the request cache`);
  const windows: Fixture['relisten']['windows'] = {};
  const relistenText: Record<string, string> = {};
  for (const e of entries) {
    const win = region.get(String(e.request.audio));
    if (!win) continue;
    if (e.role === 'timing' && (e.provider === timingProvider || e.provider === secondProvider)) (windows[e.provider] ??= {})[spanKey(win[0], win[1])] = (e.response?.words ?? []).map(word);
    if (e.role === 'text' && e.stage === 'align') relistenText[textKey(win[0], win[1], e.request.prompt as string | undefined)] = e.response?.text?.trim() ?? '';
  }
  const llm: Record<string, unknown> = {};
  for (const e of entries) if (e.role === 'llm' && e.stage === 'align' && e.response) llm[llmKey(e.request as never)] = e.response;
  return {
    language: timing.response.language ?? 'und', duration: extract.duration,
    chunks: extract.chunks.map((c, k) => ({ start: c.start, end: c.end, text: raw[k]! })), raw,
    timing: { ...(timing.response.language ? { language: timing.response.language } : {}), words: timing.response.words.map(word) },
    windows, relistenText, llm,
  };
}

interface Live { listen: NonNullable<NonNullable<Parameters<typeof runOvertone>[1]>['live']>['listen']; text: (start: number, end: number, prompt: string | undefined) => Promise<string>; llm: LlmProvider; retry: (path: string, prompt: string | undefined, language: string) => Promise<string>; meter: UsageMeter }

async function liveProviders(): Promise<Live> {
  const dotenv = await import('dotenv');
  dotenv.config({ path: join(REPO, '.env'), quiet: true });
  const meter = new UsageMeter();
  const opts = { cwd: REPO, onUsage: (r: Parameters<UsageMeter['add']>[0]) => meter.add(r) };
  const env = process.env;
  const text = createProvider('text', resolveSelection(parseModelSpec('azure-openai:gpt-transcribe'), 'text'), env, opts) as TextProvider;
  const llm = withSchemaValidation(createProvider('llm', resolveSelection(parseModelSpec('azure-openai:gpt-6.1-sol'), 'llm'), env, opts) as LlmProvider);
  const timing = new Map<string, TimingProvider>();
  const timingOf = (id: string) => {
    if (!timing.has(id)) {
      timing.set(id, createProvider('timing', resolveSelection(parseModelSpec(id), 'timing'), env, opts) as TimingProvider);
    }
    return timing.get(id)!;
  };
  let wav = '';
  let language = 'en';
  const live: Live & { use(w: string, l: string): void } = {
    meter, llm,
    use(w: string, l: string) { wav = w; language = l; },
    listen: async (id, start, end) => {
      const path = await cutAudio(wav, start, end);
      try {
        const res = await timingOf(id).align({ path, duration: end - start }, { language });
        return res.words.map((w) => ({ ...word(w), start: w.start + start, end: w.end + start }));
      } catch (err) {
        if ((err as Error).name === 'ImplausibleTranscriptError') return [];
        throw err;
      }
    },
    text: async (start, end, prompt) => {
      const path = await cutAudio(wav, start, end);
      // A small tier's rate limit outlasts the providers' own retries (about a minute).
      for (let attempt = 0; ; attempt++) {
        try {
          return (await text.transcribe({ path, index: 0, start, end }, { language, prompt })).text.trim();
        } catch (err) {
          if ((err as { status?: number }).status !== 429 || attempt >= 8) throw err;
          await new Promise((r) => setTimeout(r, 15_000));
        }
      }
    },
    retry: async (path, prompt, lang) => (await text.transcribe({ path: await normalizeLoudness(path), index: 0, start: 0, end: 0 }, { language: lang, prompt })).text.trim(),
  };
  return Object.assign(live, { use: live.use });
}

async function freeze(src: ClipSource, live?: Live & { use(w: string, l: string): void }): Promise<{ fixture: Fixture; bytes: number; misses: number }> {
  const dir = join(REPO, src.cache);
  const second = src.elevenlabs ? 'elevenlabs:scribe_v2' : undefined;
  const h = existsSync(join(dir, 'requests')) && !existsSync(join(dir, 'timing.json')) ? fromRequestCache(dir, src.timingProvider, second) : fromStageCache(dir);
  const path = join(FIXTURE_DIR, `${src.id}.fixture.json.gz`);
  const old = existsSync(path) ? readFixture(path) : undefined;
  const ref = reference(src);
  const windows = h.windows;
  // Keep what earlier live recordings froze.
  for (const [id, ws] of Object.entries(old?.relisten.windows ?? {})) for (const [k, v] of Object.entries(ws)) (windows[id] ??= {})[k] ??= v;
  const fixture: Fixture = {
    id: src.id, title: src.title, kind: src.kind, language: h.language, duration: h.duration,
    license: src.license, attribution: src.attribution, contamination: src.contamination,
    text: {
      provider: src.textProvider, raw: h.raw,
      ...(h.retry ?? old?.text.retry ? { retry: h.retry ?? old!.text.retry } : {}),
      ...(src.prompt ? { prompt: h.raw.map(() => src.prompt!()) } : {}),
      covered: h.chunks,
    },
    context: src.context(),
    ...(src.names ? { names: src.names() } : {}),
    timing: { provider: src.timingProvider, ...(h.timing.language ? { language: h.timing.language } : {}), words: h.timing.words },
    relisten: { listeners: [src.timingProvider, ...(second ? [second] : [])], windows },
    hearings: src.elevenlabs ? { elevenlabs: { provider: 'elevenlabs:scribe_v2', note: src.elevenlabs.note, words: elevenlabsWords(src.elevenlabs) } } : {},
    relistenText: { ...old?.relistenText, ...h.relistenText },
    llm: { ...old?.llm, ...h.llm },
    ...(ref ? { reference: ref } : {}),
    ...(src.localReference ? { localReference: src.localReference } : {}),
    ...(src.timingReference ? { timingReference: src.timingReference } : {}),
    notes: [...(src.notes ?? [])],
    ...(src.nonSpeech ? { nonSpeech: true } : {}),
    ...(src.speechStart !== undefined ? { speechStart: src.speechStart } : {}),
  };
  if (live) {
    live.use(join(dir, 'audio.wav'), h.language.split(/[-_]/)[0]!.toLowerCase());
    // The retry of an empty chunk, when no saved run has its answer.
    if (!fixture.text.retry && fixture.text.raw.some((t) => !t.trim())) {
      const mp3 = join(dir, 'audio.mp3');
      const lang = h.language.split(/[-_]/)[0]!.toLowerCase();
      // Single-chunk clips only (the chunk is audio.mp3), so no prompt, as in pipeline/text-base.ts.
      fixture.text.retry = await Promise.all(fixture.text.raw.map(async (t, k) => (t.trim() || fixture.text.raw.length > 1 || !existsSync(mp3) ? '' : live.retry(mp3, undefined, lang))));
    }
  }
  // The gate's configuration, the one without the second hearing and, for a prompt echo, the one without the
  // echo guard.
  let misses = 0;
  const used = { relisten: new Set<string>(), text: new Set<string>(), llm: new Set<string>() };
  const configs: Array<{ noSecond?: boolean; noEcho?: boolean }> = [{}, { noSecond: true }, ...(src.echo ? [{ noEcho: true }] : [])];
  for (const config of configs) {
    const noSecond = config.noSecond ?? false;
    const run = await runOvertone(fixture, { ...config, ...(live ? { live: { listen: live.listen, text: live.text, llm: live.llm } } : {}) });
    for (const k of ['relisten', 'text', 'llm'] as const) for (const x of run.used[k]) used[k].add(x);
    const n = run.misses.relisten.length + run.misses.text.length + run.misses.llm.length;
    misses += n;
    if (n > 0) console.log(`  ${src.id}${noSecond ? ' (without the second hearing)' : config.noEcho ? ' (without the echo guard)' : ''}: not answered (run with --live to record): ${run.misses.relisten.length} timing snippets, ${run.misses.text.length} text snippets, ${run.misses.llm.length} chooser requests`);
  }
  // Keep only the answers the current code asks for.
  if (misses === 0) {
    for (const [id, ws] of Object.entries(fixture.relisten.windows)) for (const k of Object.keys(ws)) if (!used.relisten.has(`${id} ${k}`)) delete ws[k];
    for (const k of Object.keys(fixture.relistenText ?? {})) if (!used.text.has(k)) delete fixture.relistenText![k];
    for (const k of Object.keys(fixture.llm ?? {})) if (!used.llm.has(k)) delete fixture.llm![k];
  }
  if (fixture.notes!.length === 0) delete fixture.notes;
  const gz = gzipSync(JSON.stringify(fixture), { level: 9 });
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(path, gz);
  return { fixture, bytes: gz.length, misses };
}

export async function main(args: string[]): Promise<void> {
  const isLive = args.includes('--live');
  const only = args.filter((a) => !a.startsWith('--'));
  // The gate's defaults, as the CLI resolves them without a config file.
  await resolveConfig({}, {}, { cwd: REPO, configDir: REPO });
  const live = isLive ? await liveProviders() as Live & { use(w: string, l: string): void } : undefined;
  for (const src of CLIPS) {
    if (only.length > 0 && !only.includes(src.id)) continue;
    const { fixture, bytes } = await freeze(src, live);
    const rl = Object.values(fixture.relisten.windows).reduce((n, w) => n + Object.keys(w).length, 0);
    console.log(`${src.id}: ${(bytes / 1024).toFixed(0)} KB; ${fixture.timing.words.length} timing words, ${rl} timing snippets, ${Object.keys(fixture.relistenText ?? {}).length} text snippets, ${Object.keys(fixture.llm ?? {}).length} chooser answers${fixture.notes ? `; ${fixture.notes.join(' ')}` : ''}`);
  }
  if (live) console.log(formatUsage(live.meter.list()) ?? 'usage: nothing sent');
}
